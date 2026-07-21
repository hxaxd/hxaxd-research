from __future__ import annotations

import ctypes
import hashlib
import os
import queue
import subprocess
import time
from collections import deque
from collections.abc import Callable, Mapping
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock, Thread
from typing import IO

from .models import (
    CancellationToken,
    ExecutableIdentity,
    ProcessLogEvent,
    ProcessOutcome,
    ProcessResult,
    ProcessSpec,
)

LogObserver = Callable[[ProcessLogEvent], None]

DEFAULT_ENVIRONMENT_ALLOWLIST = frozenset(
    {
        "ALLUSERSPROFILE",
        "APPDATA",
        "COMSPEC",
        "HOME",
        "HOMEDRIVE",
        "HOMEPATH",
        "HXAXD_MCP_TOKEN",
        "LANG",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROGRAMDATA",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "WINDIR",
    }
)


class ProcessPolicyError(ValueError):
    pass


class ProcessStartError(RuntimeError):
    pass


class ExecutableRegistry:
    """Maps stable identities to paths so callers never submit arbitrary executables."""

    def __init__(self, identities: tuple[ExecutableIdentity, ...] = ()) -> None:
        self._lock = Lock()
        self._identities: dict[str, ExecutableIdentity] = {}
        for identity in identities:
            self.register(identity)

    def register(self, identity: ExecutableIdentity) -> None:
        if not identity.name.strip():
            raise ProcessPolicyError("executable identity must have a name")
        with self._lock:
            self._identities[identity.name] = identity

    def resolve(self, name: str) -> ExecutableIdentity:
        with self._lock:
            identity = self._identities.get(name)
        if identity is None:
            raise ProcessPolicyError(f"unregistered executable: {name}")
        return identity


class _Tail:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self._parts: deque[str] = deque()
        self._size = 0
        self._lock = Lock()

    def append(self, text: str) -> None:
        with self._lock:
            if len(text) >= self.limit:
                self._parts.clear()
                self._parts.append(text[-self.limit :])
                self._size = self.limit
                return
            self._parts.append(text)
            self._size += len(text)
            while self._parts and self._size > self.limit:
                removed = self._parts.popleft()
                self._size -= len(removed)

    def value(self) -> str:
        with self._lock:
            value = "".join(self._parts)
        return value[-self.limit :]


class _Redactor:
    def __init__(self, values: tuple[str, ...]) -> None:
        self.values = tuple(sorted({item for item in values if item}, key=len, reverse=True))

    def __call__(self, text: str) -> str:
        for value in self.values:
            text = text.replace(value, "[REDACTED]")
        return text


class ProcessHandle:
    """Interactive process handle; construction is restricted to ProcessRunner."""

    _EOF = object()

    def __init__(
        self,
        process: subprocess.Popen[str],
        spec: ProcessSpec,
        redactor: _Redactor,
        observer: LogObserver | None,
        windows_job: _WindowsJob | None,
        on_close: Callable[[int], None],
        tail_characters: int,
    ) -> None:
        self._process = process
        self.spec = spec
        self._redactor = redactor
        self._observer = observer
        self._windows_job = windows_job
        self._on_close = on_close
        self._stdout: queue.Queue[str | object] = queue.Queue()
        self._stderr: queue.Queue[str | object] = queue.Queue()
        self._stdout_tail = _Tail(tail_characters)
        self._stderr_tail = _Tail(tail_characters)
        self._stdin_lock = Lock()
        self._closed = False
        self._close_lock = Lock()
        self._readers = (
            self._reader(process.stdout, "stdout", self._stdout, self._stdout_tail),
            self._reader(process.stderr, "stderr", self._stderr, self._stderr_tail),
        )

    @property
    def pid(self) -> int:
        return self._process.pid

    @property
    def returncode(self) -> int | None:
        return self._process.poll()

    @property
    def stdout_tail(self) -> str:
        return self._stdout_tail.value()

    @property
    def stderr_tail(self) -> str:
        return self._stderr_tail.value()

    def write_line(self, value: str) -> None:
        if "\n" in value or "\r" in value:
            raise ValueError("write_line accepts one JSONL record without a newline")
        if self._process.stdin is None:
            raise BrokenPipeError("process stdin is not available")
        with self._stdin_lock:
            self._process.stdin.write(value + "\n")
            self._process.stdin.flush()

    def read_stdout_line(self, timeout: float | None = None) -> str | None:
        return self._read_queue(self._stdout, timeout)

    def read_stderr_line(self, timeout: float | None = None) -> str | None:
        return self._read_queue(self._stderr, timeout)

    def wait(self, timeout: float | None = None) -> int:
        try:
            return self._process.wait(timeout=timeout)
        finally:
            if self._process.poll() is not None:
                self.close()

    def terminate(self, grace_seconds: float = 2.0) -> None:
        if self._process.poll() is not None:
            self.close()
            return
        if self._windows_job is not None:
            self._windows_job.terminate()
        elif os.name == "posix":
            with suppress(ProcessLookupError):
                os.killpg(self._process.pid, 15)
        else:
            self._process.terminate()
        try:
            self._process.wait(timeout=grace_seconds)
        except subprocess.TimeoutExpired:
            if self._windows_job is not None:
                self._windows_job.terminate()
            elif os.name == "posix":
                with suppress(ProcessLookupError):
                    os.killpg(self._process.pid, 9)
            else:
                self._process.kill()
            self._process.wait(timeout=max(grace_seconds, 1.0))
        finally:
            self.close()

    def close_stdin(self) -> None:
        if self._process.stdin is not None:
            with self._stdin_lock:
                self._process.stdin.close()

    def close(self) -> None:
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
        for reader in self._readers:
            reader.join(timeout=1)
        if self._windows_job is not None:
            self._windows_job.close()
        self._on_close(self._process.pid)

    def _reader(
        self,
        stream: IO[str] | None,
        name: str,
        target: queue.Queue[str | object],
        tail: _Tail,
    ) -> Thread:
        def read() -> None:
            if stream is None:
                target.put(self._EOF)
                return
            try:
                for raw in iter(stream.readline, ""):
                    target.put(raw)
                    redacted = self._redactor(raw)
                    tail.append(redacted)
                    if self._observer is not None:
                        with suppress(Exception):
                            self._observer(
                                ProcessLogEvent(
                                    stream=name,
                                    text=redacted.rstrip("\r\n"),
                                    occurred_at=datetime.now(UTC),
                                )
                            )
            finally:
                stream.close()
                target.put(self._EOF)

        thread = Thread(target=read, name=f"process-{name}-{self.pid}", daemon=True)
        thread.start()
        return thread

    def _read_queue(self, source: queue.Queue[str | object], timeout: float | None) -> str | None:
        try:
            value = source.get(timeout=timeout)
        except queue.Empty:
            return None
        if value is self._EOF:
            return None
        return str(value).rstrip("\r\n")


class ProcessRunner:
    """The only module allowed to create operating-system child processes."""

    def __init__(
        self,
        registry: ExecutableRegistry,
        *,
        environment_source: Mapping[str, str] | None = None,
        allowed_environment: frozenset[str] = DEFAULT_ENVIRONMENT_ALLOWLIST,
        tail_characters: int = 32_000,
    ) -> None:
        self.registry = registry
        self.environment_source = dict(
            os.environ if environment_source is None else environment_source
        )
        self.allowed_environment = allowed_environment
        self.tail_characters = tail_characters
        self._active: dict[int, ProcessHandle] = {}
        self._lock = Lock()

    def start(self, spec: ProcessSpec, observer: LogObserver | None = None) -> ProcessHandle:
        identity, executable, cwd = self._validate(spec)
        environment = self._environment(spec)
        redactor = _Redactor((*spec.sensitive_values, *spec.environment.values()))
        flags = 0
        if os.name == "nt":
            flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
        options: dict[str, object] = {
            "args": [str(executable), *spec.argv],
            "cwd": str(cwd),
            "env": environment,
            "stdin": subprocess.PIPE,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "bufsize": 1,
            "shell": False,
        }
        if os.name == "nt":
            options["creationflags"] = flags
        else:
            options["start_new_session"] = True
        try:
            process = subprocess.Popen(**options)
        except OSError as error:
            raise ProcessStartError(f"cannot start {identity.name}: {error}") from error
        windows_job = _WindowsJob.attach(process) if os.name == "nt" else None
        handle = ProcessHandle(
            process,
            spec,
            redactor,
            observer,
            windows_job,
            self._remove_active,
            self.tail_characters,
        )
        with self._lock:
            self._active[process.pid] = handle
        return handle

    def run(
        self,
        spec: ProcessSpec,
        *,
        cancellation: CancellationToken | None = None,
        observer: LogObserver | None = None,
    ) -> ProcessResult:
        token = cancellation or CancellationToken()
        started_at = datetime.now(UTC)
        started_clock = time.monotonic()
        sanitized_argv = _Redactor((*spec.sensitive_values, *spec.environment.values()))(
            "\0".join(spec.argv)
        ).split("\0")
        try:
            handle = self.start(spec, observer)
        except ProcessStartError as error:
            finished_at = datetime.now(UTC)
            return ProcessResult(
                outcome=ProcessOutcome.FAILED_TO_START,
                executable=spec.executable,
                argv=tuple(sanitized_argv),
                pid=None,
                returncode=None,
                started_at=started_at,
                finished_at=finished_at,
                duration_seconds=time.monotonic() - started_clock,
                stdout_tail="",
                stderr_tail="",
                error=str(error),
            )

        outcome = ProcessOutcome.COMPLETED
        while handle.returncode is None:
            elapsed = time.monotonic() - started_clock
            if token.is_cancelled:
                outcome = ProcessOutcome.CANCELED
                handle.terminate()
                break
            if elapsed >= spec.timeout_seconds:
                outcome = ProcessOutcome.TIMED_OUT
                handle.terminate()
                break
            token.wait(min(0.1, spec.timeout_seconds - elapsed))
        if handle.returncode is not None:
            handle.wait()
        finished_at = datetime.now(UTC)
        return ProcessResult(
            outcome=outcome,
            executable=spec.executable,
            argv=tuple(sanitized_argv),
            pid=handle.pid,
            returncode=handle.returncode,
            started_at=started_at,
            finished_at=finished_at,
            duration_seconds=time.monotonic() - started_clock,
            stdout_tail=handle.stdout_tail,
            stderr_tail=handle.stderr_tail,
        )

    def shutdown(self) -> None:
        with self._lock:
            handles = list(self._active.values())
        for handle in handles:
            handle.terminate()

    def _validate(self, spec: ProcessSpec) -> tuple[ExecutableIdentity, Path, Path]:
        if spec.timeout_seconds <= 0:
            raise ProcessPolicyError("process timeout must be positive")
        if any("\x00" in argument for argument in spec.argv):
            raise ProcessPolicyError("process argument contains a null byte")
        identity = self.registry.resolve(spec.executable)
        executable = identity.path.resolve(strict=True)
        executable_root = identity.allowed_root.resolve(strict=True)
        if not _within(executable, executable_root):
            raise ProcessPolicyError(f"executable escapes registered root: {identity.name}")
        if not executable.is_file():
            raise ProcessPolicyError(f"registered executable is not a file: {identity.name}")
        if identity.sha256 is not None and _sha256(executable) != identity.sha256.lower():
            raise ProcessPolicyError(f"executable checksum mismatch: {identity.name}")
        cwd = spec.cwd.resolve(strict=True)
        cwd_root = spec.allowed_cwd_root.resolve(strict=True)
        if not cwd.is_dir() or not _within(cwd, cwd_root):
            raise ProcessPolicyError("process working directory escapes its allowed root")
        requested = {*spec.inherit_environment, *spec.environment}
        forbidden = requested - self.allowed_environment
        if forbidden:
            raise ProcessPolicyError(
                f"environment keys are not allowlisted: {', '.join(sorted(forbidden))}"
            )
        return identity, executable, cwd

    def _environment(self, spec: ProcessSpec) -> dict[str, str]:
        inherited = {
            key: self.environment_source[key]
            for key in spec.inherit_environment
            if key in self.environment_source
        }
        inherited.update(spec.environment)
        return inherited

    def _remove_active(self, pid: int) -> None:
        with self._lock:
            self._active.pop(pid, None)


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class _WindowsJob:
    """Best-effort Windows Job Object that kills the complete child process tree."""

    _KILL_ON_CLOSE = 0x00002000
    _EXTENDED_LIMIT_INFORMATION = 9

    def __init__(self, handle: int) -> None:
        self.handle = handle

    @classmethod
    def attach(cls, process: subprocess.Popen[str]) -> _WindowsJob | None:
        if os.name != "nt":
            return None
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.SetInformationJobObject.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
        ]
        kernel32.SetInformationJobObject.restype = ctypes.c_int
        kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel32.AssignProcessToJobObject.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = _JobObjectExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags = cls._KILL_ON_CLOSE
        ok = kernel32.SetInformationJobObject(
            job,
            cls._EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if ok:
            process_handle = ctypes.c_void_p(int(process._handle))  # noqa: SLF001
            ok = kernel32.AssignProcessToJobObject(job, process_handle)
        if not ok:
            kernel32.CloseHandle(job)
            return None
        return cls(job)

    def terminate(self) -> None:
        if self.handle:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.TerminateJobObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            kernel32.TerminateJobObject.restype = ctypes.c_int
            kernel32.TerminateJobObject(self.handle, 1)

    def close(self) -> None:
        if self.handle:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel32.CloseHandle.restype = ctypes.c_int
            kernel32.CloseHandle(self.handle)
            self.handle = 0


class _JobObjectBasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _JobObjectExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JobObjectBasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]

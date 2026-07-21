from __future__ import annotations

import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import Condition, RLock
from typing import BinaryIO, TypeVar


class WorkspaceBusyError(RuntimeError):
    pass


class WorkspaceProcessLock:
    """Holds one advisory lock for the lifetime of a backend process."""

    def __init__(self, path: Path) -> None:
        self.path = path.resolve()
        self._stream: BinaryIO | None = None

    def acquire(self) -> None:
        if self._stream is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        stream = self.path.open("a+b")
        try:
            stream.seek(0, os.SEEK_END)
            if stream.tell() == 0:
                stream.write(b"\0")
                stream.flush()
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            stream.close()
            raise WorkspaceBusyError(
                "另一个后端进程已经占用这个工作区"
            ) from error
        self._stream = stream

    def release(self) -> None:
        stream = self._stream
        if stream is None:
            return
        try:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        finally:
            stream.close()
            self._stream = None


Result = TypeVar("Result")


class WorkspaceMutationGate:
    """Coordinates synchronous HTTP writes with snapshot maintenance."""

    def __init__(self) -> None:
        self._condition = Condition(RLock())
        self._active_mutations = 0
        self._active_reads = 0
        self._maintenance = False
        self._reads_blocked = False

    def enter_read(self) -> bool:
        with self._condition:
            if self._reads_blocked:
                return False
            self._active_reads += 1
            return True

    def exit_read(self) -> None:
        with self._condition:
            if self._active_reads <= 0:
                raise RuntimeError("workspace read gate is unbalanced")
            self._active_reads -= 1
            if self._active_reads == 0:
                self._condition.notify_all()

    def enter_mutation(self) -> bool:
        with self._condition:
            if self._maintenance:
                return False
            self._active_mutations += 1
            return True

    def exit_mutation(self) -> None:
        with self._condition:
            if self._active_mutations <= 0:
                raise RuntimeError("workspace mutation gate is unbalanced")
            self._active_mutations -= 1
            if self._active_mutations == 0:
                self._condition.notify_all()

    @contextmanager
    def maintenance(self, *, block_reads: bool = False) -> Iterator[None]:
        with self._condition:
            if self._maintenance:
                raise WorkspaceBusyError("工作区已经处于维护状态")
            self._maintenance = True
            self._reads_blocked = block_reads
            while self._active_mutations or (block_reads and self._active_reads):
                self._condition.wait()
        try:
            yield
        finally:
            with self._condition:
                self._maintenance = False
                self._reads_blocked = False
                self._condition.notify_all()

    def run_maintenance(
        self, operation: Callable[[], Result], *, block_reads: bool = False
    ) -> Result:
        with self.maintenance(block_reads=block_reads):
            return operation()

    @property
    def maintenance_active(self) -> bool:
        with self._condition:
            return self._maintenance

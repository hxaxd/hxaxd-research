from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from threading import Event, Lock, Thread
from typing import Protocol
from uuid import uuid4

from app.platform.processes import CancellationToken

from .models import ClaimedJob, Job, JobCreate, JobExecutionResult, JobFailure
from .repository import JobConflictError, SqliteJobRepository


@dataclass(frozen=True)
class JobExecutionContext:
    claimed: ClaimedJob
    cancellation: CancellationToken
    emit: Callable[[str, dict, str], None]
    record_process: Callable[[int | None, str, int | None], None]


class JobHandler(Protocol):
    def __call__(self, context: JobExecutionContext) -> JobExecutionResult: ...


class JobRegistry:
    def __init__(self) -> None:
        self._handlers: dict[str, JobHandler] = {}

    def register(self, kind: str, handler: JobHandler) -> None:
        if kind in self._handlers:
            raise ValueError(f"job handler already registered: {kind}")
        self._handlers[kind] = handler

    def resolve(self, kind: str) -> JobHandler:
        try:
            return self._handlers[kind]
        except KeyError as error:
            raise JobFailure("unknown_job_kind", f"no handler registered for {kind}") from error


class JobWorker:
    def __init__(
        self,
        repository: SqliteJobRepository,
        registry: JobRegistry,
        *,
        worker_id: str | None = None,
        poll_interval: float = 0.5,
        lease_seconds: int = 30,
        heartbeat_interval: float | None = None,
    ) -> None:
        self.repository = repository
        self.registry = registry
        self.worker_id = worker_id or f"local-{uuid4().hex}"
        self.poll_interval = poll_interval
        self.lease_seconds = lease_seconds
        self.heartbeat_interval = heartbeat_interval
        self._stop = Event()
        self._wake = Event()
        self._thread: Thread | None = None
        self._active: dict[str, CancellationToken] = {}
        self._errors: dict[str, str] = {}
        self._lock = Lock()

    def start(self, *, recover: bool = True) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        if recover:
            self.repository.recover_interrupted()
        self._stop.clear()
        self._thread = Thread(target=self._loop, name=f"job-worker-{self.worker_id}", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 10) -> None:
        self._stop.set()
        self._wake.set()
        with self._lock:
            active = list(self._active.values())
        for token in active:
            token.cancel()
        if self._thread is not None:
            self._thread.join(timeout=timeout)

    def notify(self) -> None:
        self._wake.set()

    @property
    def is_alive(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive() and not self._stop.is_set()

    @property
    def last_error(self) -> str | None:
        with self._lock:
            return next(reversed(self._errors.values()), None)

    @property
    def ready(self) -> bool:
        return self.is_alive and self.last_error is None

    def cancel(self, job_id: str) -> None:
        with self._lock:
            token = self._active.get(job_id)
        if token is not None:
            token.cancel()
        self.notify()

    def run_once(self) -> bool:
        claimed = self.repository.claim_next(self.worker_id, lease_seconds=self.lease_seconds)
        if claimed is None:
            return False
        token = CancellationToken()
        with self._lock:
            self._active[claimed.job.id] = token
        if self.repository.get(claimed.job.id).status.value == "cancellation_requested":
            token.cancel()
        heartbeat_stop = Event()
        heartbeat = Thread(
            target=self._heartbeat,
            args=(claimed, heartbeat_stop),
            name=f"job-heartbeat-{claimed.job.id}",
            daemon=True,
        )
        heartbeat.start()
        try:
            handler = self.registry.resolve(claimed.job.kind)
            context = JobExecutionContext(
                claimed=claimed,
                cancellation=token,
                emit=lambda event_type, payload, level="info": self.repository.append_event(
                    claimed.job.id,
                    event_type,
                    payload,
                    attempt_id=claimed.attempt.id,
                    level=level,
                ),
                record_process=lambda process_id, executable, exit_code=None: (
                    self.repository.record_process(
                        claimed.attempt.id,
                        process_id=process_id,
                        executable=executable,
                        exit_code=exit_code,
                    )
                ),
            )
            result = handler(context)
            current = self.repository.get(claimed.job.id)
            if token.is_cancelled and current.status.value != "cancellation_requested":
                self.repository.fail(
                    claimed,
                    code="worker_stopped",
                    message="worker stopped before the job completed",
                    retryable=True,
                )
            else:
                self.repository.complete(
                    claimed,
                    result.result,
                    result.attachments,
                    commit_point_reached=result.commit_point_reached,
                )
        except JobFailure as error:
            self._fail_safely(
                claimed,
                code=error.code,
                message=str(error),
                retryable=error.retryable,
            )
        except Exception as error:
            self._fail_safely(
                claimed,
                code="unhandled_job_error",
                message=str(error),
                retryable=False,
            )
        finally:
            heartbeat_stop.set()
            heartbeat.join(timeout=1)
            with self._lock:
                self._active.pop(claimed.job.id, None)
        return True

    def _fail_safely(
        self,
        claimed: ClaimedJob,
        *,
        code: str,
        message: str,
        retryable: bool,
    ) -> None:
        try:
            self.repository.fail(
                claimed,
                code=code,
                message=message,
                retryable=retryable,
            )
        except JobConflictError:
            # Another recovery path already revoked this attempt's lease.
            return

    def _loop(self) -> None:
        try:
            while not self._stop.is_set():
                try:
                    processed = self.run_once()
                except Exception as error:
                    self._record_error("loop", error)
                    self._wait_for_work()
                    continue
                self._clear_error("loop")
                if not processed:
                    self._wait_for_work()
        except BaseException as error:
            self._record_error("loop", error)
            raise

    def _heartbeat(self, claimed: ClaimedJob, stop: Event) -> None:
        source = f"heartbeat:{claimed.job.id}"
        interval = self.heartbeat_interval or max(1.0, self.lease_seconds / 3)
        try:
            while not stop.wait(interval):
                try:
                    renewed = self.repository.heartbeat(
                        claimed.job.id,
                        claimed.attempt.id,
                        self.worker_id,
                        lease_seconds=self.lease_seconds,
                    )
                except Exception as error:
                    self._record_error(source, error)
                    continue
                self._clear_error(source)
                if not renewed:
                    return
        except BaseException as error:
            self._record_error(source, error)
            raise
        finally:
            if stop.is_set():
                self._clear_error(source)

    def _wait_for_work(self) -> None:
        self._wake.wait(self.poll_interval)
        self._wake.clear()

    def _record_error(self, source: str, error: BaseException) -> None:
        detail = str(error).strip() or "no details"
        message = f"{source}: {type(error).__name__}: {detail}"[:1000]
        with self._lock:
            self._errors.pop(source, None)
            self._errors[source] = message

    def _clear_error(self, source: str) -> None:
        with self._lock:
            self._errors.pop(source, None)


class JobScheduler:
    def __init__(self, repository: SqliteJobRepository, worker: JobWorker | None = None) -> None:
        self.repository = repository
        self.worker = worker

    def create(self, request: JobCreate) -> Job:
        job = self.repository.enqueue(request)
        if self.worker is not None:
            self.worker.notify()
        return job

    def cancel(self, job_id: str) -> Job:
        job = self.repository.request_cancel(job_id)
        if self.worker is not None:
            self.worker.cancel(job_id)
        return job

    def resume(self, job_id: str) -> Job:
        job = self.repository.resume(job_id)
        if self.worker is not None:
            self.worker.notify()
        return job

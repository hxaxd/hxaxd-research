from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4
from zipfile import BadZipFile, ZipFile

from app.core.config import Settings
from app.jobs.models import (
    ClaimedJob,
    Job,
    JobCreate,
    JobExecutionResult,
    JobFailure,
    JobStatus,
)
from app.jobs.repository import JobConflictError, SqliteJobRepository
from app.jobs.scheduler import JobExecutionContext, JobRegistry, JobScheduler
from app.platform import WorkspaceBusyError, WorkspaceMutationGate
from app.platform.db import V3Database
from app.utils.snapshots.backup import SnapshotWriter
from app.utils.snapshots.contract import MANIFEST_PATH, SnapshotManifest
from app.utils.snapshots.errors import SnapshotCancelled, SnapshotError
from app.utils.snapshots.restore import SnapshotRestorer
from app.utils.time import utc_now

from .models import SnapshotItem, SnapshotOverview, SnapshotRestoreRequest

SNAPSHOT_CREATE_JOB = "snapshot.create"
SNAPSHOT_RESTORE_JOB = "snapshot.restore"
_SNAPSHOT_CONCURRENCY_KEY = "workspace:snapshot"


class SnapshotNotFoundError(LookupError):
    pass


class SnapshotInputError(ValueError):
    pass


class SnapshotBusyError(RuntimeError):
    pass


class SnapshotService:
    def __init__(
        self,
        settings: Settings,
        database: V3Database,
        jobs: SqliteJobRepository,
        scheduler: JobScheduler,
        *,
        mutation_gate: WorkspaceMutationGate | None = None,
    ) -> None:
        self.settings = settings
        self.database = database
        self.jobs = jobs
        self.scheduler = scheduler
        self.mutation_gate = mutation_gate or WorkspaceMutationGate()

    def initialize(self) -> None:
        self.settings.snapshot_dir.mkdir(parents=True, exist_ok=True)

    def reconcile_committed(self) -> int:
        """Converge snapshot jobs interrupted after their atomic publish point."""

        reconciled = 0
        active = [
            *self.jobs.list_jobs(status=JobStatus.RUNNING, limit=1000),
            *self.jobs.list_jobs(status=JobStatus.CANCELLATION_REQUESTED, limit=1000),
        ]
        for job in active:
            if job.kind == SNAPSHOT_CREATE_JOB:
                filename = self._job_filename(job)
                try:
                    target = self.locate(filename)
                    with ZipFile(target, allowZip64=True) as archive:
                        manifest = SnapshotManifest.from_json(
                            archive.read(MANIFEST_PATH).decode("utf-8")
                        )
                except (
                    SnapshotNotFoundError,
                    SnapshotError,
                    BadZipFile,
                    KeyError,
                    UnicodeDecodeError,
                ):
                    continue
                self.jobs.reconcile_committed(
                    job.id,
                    {
                        "filename": filename,
                        "file_count": len(manifest.files),
                        "size": target.stat().st_size,
                        "download_url": f"/api/snapshots/{filename}/download",
                    },
                )
                reconciled += 1
            elif job.kind == SNAPSHOT_RESTORE_JOB:
                with self.database.read() as connection:
                    committed = connection.execute(
                        """
                        SELECT metadata_json FROM audit_events
                        WHERE action = 'workspace.restored' AND correlation_id = ?
                        ORDER BY occurred_at DESC LIMIT 1
                        """,
                        (job.id,),
                    ).fetchone()
                if committed is None:
                    continue
                filename = self._job_filename(job)
                self.jobs.reconcile_committed(
                    job.id,
                    {
                        "filename": filename,
                        "reconciled_after_restart": True,
                    },
                )
                reconciled += 1
        return reconciled

    def register_handlers(self, registry: JobRegistry) -> None:
        registry.register(SNAPSHOT_CREATE_JOB, self._create_handler)
        registry.register(SNAPSHOT_RESTORE_JOB, self._restore_handler)

    def overview(self) -> SnapshotOverview:
        return SnapshotOverview(snapshots=self._list())

    def create(self) -> Job:
        self._ensure_workspace_idle()
        timestamp = datetime.now(UTC).strftime("%Y-%m-%d_%H%M%S_%fZ")
        filename = f"research-{timestamp}.researchpack"
        try:
            return self.scheduler.create(
                JobCreate(
                    kind=SNAPSHOT_CREATE_JOB,
                    subject_type="workspace",
                    subject_id="local",
                    input={"filename": filename},
                    concurrency_key=_SNAPSHOT_CONCURRENCY_KEY,
                    priority=1000,
                    max_attempts=1,
                )
            )
        except JobConflictError as error:
            raise SnapshotBusyError(str(error)) from error

    def restore(self, filename: str, payload: SnapshotRestoreRequest) -> Job:
        self.locate(filename)
        if payload.confirmation != filename:
            raise SnapshotInputError("恢复确认内容必须与快照文件名完全相同")
        self._ensure_workspace_idle()
        try:
            return self.scheduler.create(
                JobCreate(
                    kind=SNAPSHOT_RESTORE_JOB,
                    subject_type="workspace",
                    subject_id="local",
                    input={"filename": filename, "confirmed_filename": payload.confirmation},
                    concurrency_key=_SNAPSHOT_CONCURRENCY_KEY,
                    priority=1000,
                    max_attempts=1,
                )
            )
        except JobConflictError as error:
            raise SnapshotBusyError(str(error)) from error

    def locate(self, filename: str) -> Path:
        if Path(filename).name != filename or not filename.endswith(".researchpack"):
            raise SnapshotNotFoundError("快照不存在")
        root = self.settings.snapshot_dir.resolve()
        path = (root / filename).resolve()
        if path.parent != root or not path.is_file():
            raise SnapshotNotFoundError("快照不存在")
        return path

    def _new_snapshot_path(self, filename: str) -> Path:
        if Path(filename).name != filename or not filename.endswith(".researchpack"):
            raise SnapshotError("快照任务包含非法文件名")
        root = self.settings.snapshot_dir.resolve()
        path = (root / filename).resolve()
        if path.parent != root:
            raise SnapshotError("快照任务文件名越界")
        return path

    def _list(self) -> list[SnapshotItem]:
        items: list[SnapshotItem] = []
        for path in self.settings.snapshot_dir.glob("*.researchpack"):
            stat = path.stat()
            items.append(
                SnapshotItem(
                    filename=path.name,
                    size=stat.st_size,
                    created_at=datetime.fromtimestamp(stat.st_mtime, UTC),
                    download_url=f"/api/snapshots/{path.name}/download",
                )
            )
        return sorted(items, key=lambda item: item.created_at, reverse=True)

    def _ensure_workspace_idle(self, *, exclude_job_id: str | None = None) -> None:
        if self.jobs.has_active_jobs(exclude_job_id=exclude_job_id):
            raise SnapshotBusyError("存在尚未结束的任务，不能创建或恢复快照")

    def _create_handler(self, context: JobExecutionContext) -> JobExecutionResult:
        try:
            return self.mutation_gate.run_maintenance(
                lambda: self._create_during_maintenance(context)
            )
        except WorkspaceBusyError as error:
            raise JobFailure("workspace_busy", str(error), retryable=True) from error

    def _create_during_maintenance(self, context: JobExecutionContext) -> JobExecutionResult:
        try:
            filename = self._job_filename(context.claimed.job)
            target = self._new_snapshot_path(filename)
            self._ensure_workspace_idle(exclude_job_id=context.claimed.job.id)
            context.emit("snapshot.create.started", {"filename": filename}, "info")
            result = SnapshotWriter(
                self.settings.data_dir,
                V3Database(self.settings.database_path),
            ).write(
                target,
                operation_job_id=context.claimed.job.id,
                should_cancel=lambda: context.cancellation.is_cancelled,
                source_idle_check=lambda: self._ensure_workspace_idle(
                    exclude_job_id=context.claimed.job.id
                ),
            )
            context.emit(
                "snapshot.create.committed",
                {"filename": filename, "file_count": result.file_count, "size": result.size},
                "info",
            )
            return JobExecutionResult(
                result={
                    "filename": filename,
                    "file_count": result.file_count,
                    "size": result.size,
                    "download_url": f"/api/snapshots/{filename}/download",
                },
                commit_point_reached=True,
            )
        except SnapshotCancelled as error:
            raise JobFailure("snapshot_cancelled", str(error), retryable=False) from error
        except (SnapshotError, SnapshotBusyError, OSError) as error:
            raise JobFailure("snapshot_create_failed", str(error), retryable=False) from error

    def _restore_handler(self, context: JobExecutionContext) -> JobExecutionResult:
        try:
            return self.mutation_gate.run_maintenance(
                lambda: self._restore_during_maintenance(context),
                block_reads=True,
            )
        except WorkspaceBusyError as error:
            raise JobFailure("workspace_busy", str(error), retryable=True) from error

    def _restore_during_maintenance(self, context: JobExecutionContext) -> JobExecutionResult:
        try:
            filename = self._job_filename(context.claimed.job)
            if context.claimed.job.input.get("confirmed_filename") != filename:
                raise SnapshotError("恢复任务缺少与文件名一致的显式确认")
            archive_path = self.locate(filename)
            self._ensure_workspace_idle(exclude_job_id=context.claimed.job.id)
            context.emit("snapshot.restore.validating", {"filename": filename}, "info")
            result = SnapshotRestorer().restore(
                archive_path,
                self.settings.data_dir,
                replace=True,
                should_cancel=lambda: context.cancellation.is_cancelled,
                source_idle_check=lambda: self._ensure_workspace_idle(
                    exclude_job_id=context.claimed.job.id
                ),
                before_activate=lambda database: self._seed_restore_continuity(
                    database,
                    context.claimed,
                    filename,
                ),
                activation_journal=self.settings.activation_journal_path,
            )
            return JobExecutionResult(
                result={
                    "filename": filename,
                    "file_count": result.file_count,
                    "source_format": result.source_format,
                    "recovery_directory": (
                        str(result.recovery_dir) if result.recovery_dir is not None else None
                    ),
                },
                commit_point_reached=True,
            )
        except SnapshotCancelled as error:
            raise JobFailure("snapshot_cancelled", str(error), retryable=False) from error
        except SnapshotNotFoundError as error:
            raise JobFailure("snapshot_not_found", str(error), retryable=False) from error
        except (SnapshotError, SnapshotBusyError, OSError) as error:
            raise JobFailure("snapshot_restore_failed", str(error), retryable=False) from error

    @staticmethod
    def _job_filename(job: Job) -> str:
        filename = job.input.get("filename")
        if not isinstance(filename, str):
            raise SnapshotError("快照任务缺少文件名")
        return filename

    @staticmethod
    def _seed_restore_continuity(
        database: V3Database,
        claimed: ClaimedJob,
        filename: str,
    ) -> None:
        job = claimed.job
        attempt = claimed.attempt
        try:
            with database.transaction() as connection:
                connection.execute(
                    """
                    INSERT INTO jobs(
                        id, kind, subject_type, subject_id, status,
                        requested_by_type, priority, input_json, result_json,
                        error_code, error_message, idempotency_key, concurrency_key,
                        max_attempts, lease_owner, lease_expires_at, heartbeat_at,
                        created_at, updated_at, available_at, started_at, finished_at,
                        cancel_requested_at
                    ) VALUES(
                        ?, ?, ?, ?, ?, 'system', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                    """,
                    (
                        job.id,
                        job.kind,
                        job.subject_type,
                        job.subject_id,
                        job.status.value,
                        job.priority,
                        json.dumps(job.input, ensure_ascii=False, sort_keys=True),
                        json.dumps(job.result, ensure_ascii=False, sort_keys=True)
                        if job.result is not None
                        else None,
                        job.error_code,
                        job.error_message,
                        job.idempotency_key,
                        job.concurrency_key,
                        job.max_attempts,
                        job.lease_owner,
                        _iso(job.lease_expires_at),
                        _iso(job.heartbeat_at),
                        _iso(job.created_at),
                        _iso(job.updated_at),
                        _iso(job.available_at),
                        _iso(job.started_at),
                        _iso(job.finished_at),
                        _iso(job.cancel_requested_at),
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO job_attempts(
                        id, job_id, attempt_number, worker_id, status,
                        process_id, executable, exit_code, error_message,
                        started_at, heartbeat_at, finished_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        attempt.id,
                        job.id,
                        attempt.attempt_number,
                        attempt.worker_id,
                        attempt.status.value,
                        attempt.process_id,
                        attempt.executable,
                        attempt.exit_code,
                        attempt.error_message,
                        _iso(attempt.started_at),
                        _iso(attempt.heartbeat_at),
                        _iso(attempt.finished_at),
                    ),
                )
                now = utc_now().isoformat()
                connection.execute(
                    """
                    INSERT INTO job_events(
                        job_id, attempt_id, event_type, level, payload_json, created_at
                    ) VALUES(?, ?, 'snapshot.restore.activated', 'warning', ?, ?)
                    """,
                    (
                        job.id,
                        attempt.id,
                        json.dumps({"filename": filename}, ensure_ascii=False),
                        now,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO audit_events(
                        id, occurred_at, actor_type, actor_id, action,
                        entity_type, entity_id, correlation_id, metadata_json
                    ) VALUES(
                        ?, ?, 'system', 'snapshot', 'workspace.restored',
                        'workspace', 'local', ?, ?
                    )
                    """,
                    (
                        uuid4().hex,
                        now,
                        job.id,
                        json.dumps({"filename": filename}, ensure_ascii=False),
                    ),
                )
        except sqlite3.IntegrityError as error:
            raise SnapshotError("恢复任务标识与快照数据冲突") from error
        except sqlite3.DatabaseError as error:
            raise SnapshotError("无法在恢复数据中延续任务审计记录") from error


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None

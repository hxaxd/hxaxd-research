from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock

from app.core.config import Settings
from app.core.database import SCHEMA_PATH
from app.core.errors import InvalidSnapshotError, ResourceConflictError, ResourceNotFoundError
from app.modules.translations.repository import SqliteJobRepository
from app.utils.identity import new_id
from app.utils.snapshots.backup import SnapshotWriter
from app.utils.snapshots.errors import SnapshotError
from app.utils.snapshots.restore import SnapshotRestorer
from app.utils.time import utc_now

from .models import (
    SnapshotItem,
    SnapshotOperation,
    SnapshotOperationKind,
    SnapshotOperationStatus,
    SnapshotOverview,
    SnapshotRestoreRequest,
)


class SnapshotService:
    def __init__(self, settings: Settings, jobs: SqliteJobRepository):
        self.settings = settings
        self.jobs = jobs
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="snapshot")
        self._lock = Lock()
        self._future: Future[None] | None = None
        self._operation: SnapshotOperation | None = None

    def initialize(self) -> None:
        self.settings.snapshot_dir.mkdir(parents=True, exist_ok=True)

    def shutdown(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=False)

    def overview(self) -> SnapshotOverview:
        with self._lock:
            operation = self._operation
        return SnapshotOverview(snapshots=self._list(), operation=operation)

    def create(self) -> SnapshotOperation:
        self._ensure_available()
        timestamp = datetime.now(UTC).strftime("%Y-%m-%d_%H%M%SZ")
        filename = f"learning-{timestamp}.researchpack"
        operation = self._start(SnapshotOperationKind.BACKUP, filename, "正在创建完整备份")
        self._future = self.pool.submit(self._run_backup, operation, filename)
        return operation

    def restore(self, filename: str, payload: SnapshotRestoreRequest) -> SnapshotOperation:
        path = self.locate(filename)
        if payload.confirmation != filename:
            raise InvalidSnapshotError("恢复确认内容必须与快照文件名完全相同")
        self._ensure_available()
        operation = self._start(SnapshotOperationKind.RESTORE, filename, "正在校验并恢复备份")
        self._future = self.pool.submit(self._run_restore, operation, path)
        return operation

    def locate(self, filename: str) -> Path:
        if Path(filename).name != filename or not filename.endswith(".researchpack"):
            raise ResourceNotFoundError("备份不存在")
        path = (self.settings.snapshot_dir / filename).resolve()
        if path.parent != self.settings.snapshot_dir.resolve() or not path.is_file():
            raise ResourceNotFoundError("备份不存在")
        return path

    def _list(self) -> list[SnapshotItem]:
        items = []
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

    def _ensure_available(self) -> None:
        with self._lock:
            if (
                self._operation is not None
                and self._operation.status is SnapshotOperationStatus.RUNNING
            ):
                raise ResourceConflictError("已有备份或恢复任务正在执行")
        if self.jobs.has_active_jobs():
            raise ResourceConflictError("存在尚未结束的资源转换任务，不能备份或恢复")

    def _start(
        self,
        kind: SnapshotOperationKind,
        filename: str,
        message: str,
    ) -> SnapshotOperation:
        with self._lock:
            if (
                self._operation is not None
                and self._operation.status is SnapshotOperationStatus.RUNNING
            ):
                raise ResourceConflictError("已有备份或恢复任务正在执行")
            operation = SnapshotOperation(
                id=new_id(),
                kind=kind,
                status=SnapshotOperationStatus.RUNNING,
                message=message,
                filename=filename,
                error=None,
                started_at=utc_now(),
                finished_at=None,
            )
            self._operation = operation
        return operation

    def _run_backup(self, operation: SnapshotOperation, filename: str) -> None:
        try:
            result = SnapshotWriter(
                self.settings.data_dir,
                self.settings.database_path,
                SCHEMA_PATH,
            ).write(self.settings.snapshot_dir / filename)
            self._finish(operation, f"备份完成，共 {result.file_count} 个数据文件")
        except (SnapshotError, OSError) as error:
            self._fail(operation, error)

    def _run_restore(self, operation: SnapshotOperation, path: Path) -> None:
        try:
            if self.jobs.has_active_jobs():
                raise SnapshotError("存在尚未结束的资源转换任务")
            result = SnapshotRestorer(SCHEMA_PATH).restore(
                path,
                self.settings.data_dir,
                replace=True,
            )
            message = f"恢复完成，共 {result.file_count} 个数据文件"
            if result.recovery_dir is not None:
                message += f"；原数据保留在 {result.recovery_dir.name}"
            self._finish(operation, message)
        except (SnapshotError, OSError) as error:
            self._fail(operation, error)

    def _finish(self, operation: SnapshotOperation, message: str) -> None:
        with self._lock:
            self._operation = operation.model_copy(
                update={
                    "status": SnapshotOperationStatus.SUCCEEDED,
                    "message": message,
                    "finished_at": utc_now(),
                }
            )

    def _fail(self, operation: SnapshotOperation, error: Exception) -> None:
        message = "备份失败" if operation.kind is SnapshotOperationKind.BACKUP else "恢复失败"
        with self._lock:
            self._operation = operation.model_copy(
                update={
                    "status": SnapshotOperationStatus.FAILED,
                    "message": message,
                    "error": str(error)[-2000:],
                    "finished_at": utc_now(),
                }
            )

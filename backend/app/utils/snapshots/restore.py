from __future__ import annotations

import shutil
import sqlite3
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4
from zipfile import BadZipFile, LargeZipFile, ZipFile

from app.legacy.v2_importer import V2ImportError, migrate_v2_database
from app.platform.activation import (
    ActivationError,
    FaultInjector,
    activate_snapshot_directory,
    default_activation_journal,
)
from app.platform.db import DatabaseKind, WorkspaceDatabase, inspect_database
from app.platform.db.v4_migration import V3MigrationError, migrate_workspace_database

from .contract import (
    DATABASE_ARCHIVE_PATH,
    MANIFEST_PATH,
    SNAPSHOT_FORMAT,
    V2_SNAPSHOT_FORMAT,
    V3_SNAPSHOT_FORMAT,
    SnapshotManifest,
)
from .errors import SnapshotCancelled, SnapshotError
from .hashing import sha256_file
from .paths import payload_relative_path, resolve_data_path, safe_archive_path

_ACTIVE_JOB_STATUSES = ("queued", "running", "cancellation_requested")
_COPY_CHUNK_SIZE = 1024 * 1024
_MAX_MANIFEST_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True)
class SnapshotRestoreResult:
    data_dir: Path
    database: WorkspaceDatabase
    recovery_dir: Path | None
    file_count: int
    source_format: str


class SnapshotRestorer:
    """Validate a snapshot in a sibling staging directory, then atomically activate it."""

    def restore(
        self,
        archive_path: Path,
        data_dir: Path,
        *,
        replace: bool = False,
        should_cancel: Callable[[], bool] | None = None,
        source_idle_check: Callable[[], None] | None = None,
        before_activate: Callable[[WorkspaceDatabase], None] | None = None,
        activation_journal: Path | None = None,
        fault_injector: FaultInjector | None = None,
    ) -> SnapshotRestoreResult:
        archive_path = archive_path.resolve()
        data_dir = data_dir.resolve()
        if not archive_path.is_file():
            raise SnapshotError(f"快照文件不存在: {archive_path}")
        data_dir.parent.mkdir(parents=True, exist_ok=True)
        if data_dir.exists() and any(data_dir.iterdir()) and not replace:
            raise SnapshotError("目标数据目录非空；如需重建，必须显式使用 --replace")

        self._check_cancelled(should_cancel)
        with tempfile.TemporaryDirectory(
            prefix=".snapshot-restore-", dir=data_dir.parent
        ) as temporary:
            stage = Path(temporary) / "data"
            stage.mkdir()
            manifest = self._extract_verified(
                archive_path,
                stage,
                should_cancel=should_cancel,
            )
            database_path = stage / Path(DATABASE_ARCHIVE_PATH).relative_to("payload")
            database = self._upgrade_and_verify_database(database_path, stage, manifest)
            self._validate_payload(stage, database, manifest)
            self._ensure_restored_jobs_are_terminal(database)
            self._check_cancelled(should_cancel)
            if source_idle_check is not None:
                source_idle_check()
            self._check_cancelled(should_cancel)
            if before_activate is not None:
                before_activate(database)
                database.verify()
            recovery = self._activate(
                stage,
                data_dir,
                replace=replace,
                activation_journal=(
                    activation_journal
                    if activation_journal is not None
                    else default_activation_journal(data_dir)
                ),
                fault_injector=fault_injector,
            )

        active_database = WorkspaceDatabase(data_dir / "research.sqlite3")
        return SnapshotRestoreResult(
            data_dir=data_dir,
            database=active_database,
            recovery_dir=recovery,
            file_count=len(manifest.files),
            source_format=manifest.format,
        )

    def _extract_verified(
        self,
        archive_path: Path,
        stage: Path,
        *,
        should_cancel: Callable[[], bool] | None,
    ) -> SnapshotManifest:
        try:
            with ZipFile(archive_path, allowZip64=True) as archive:
                infos = archive.infolist()
                if any(info.is_dir() for info in infos):
                    raise SnapshotError("快照压缩包包含未声明的目录成员")
                names = [info.filename for info in infos]
                if len(names) != len(set(names)):
                    raise SnapshotError("快照压缩包包含重复成员")
                for name in names:
                    safe_archive_path(name)
                if MANIFEST_PATH not in names:
                    raise SnapshotError("快照缺少清单")
                manifest_info = archive.getinfo(MANIFEST_PATH)
                if manifest_info.file_size > _MAX_MANIFEST_BYTES:
                    raise SnapshotError("快照清单过大")
                manifest = SnapshotManifest.from_json(archive.read(manifest_info).decode("utf-8"))
                expected = {MANIFEST_PATH, *(item.path for item in manifest.files)}
                if set(names) != expected:
                    raise SnapshotError("快照内容与清单不一致")
                required_bytes = sum(item.size for item in manifest.files)
                if required_bytes > shutil.disk_usage(stage).free:
                    raise SnapshotError("磁盘空间不足，无法安全暂存完整快照")
                records = {item.path: item for item in manifest.files}
                for info in infos:
                    if info.filename == MANIFEST_PATH:
                        continue
                    self._check_cancelled(should_cancel)
                    record = records[info.filename]
                    if info.file_size != record.size:
                        raise SnapshotError(f"快照成员大小与清单不一致: {info.filename}")
                    target = stage / payload_relative_path(info.filename)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as source, target.open("xb") as output:
                        while chunk := source.read(_COPY_CHUNK_SIZE):
                            self._check_cancelled(should_cancel)
                            output.write(chunk)
                    if target.stat().st_size != record.size or sha256_file(target) != record.sha256:
                        raise SnapshotError(f"快照文件校验失败: {info.filename}")
                return manifest
        except SnapshotError:
            raise
        except (BadZipFile, LargeZipFile, UnicodeDecodeError, RuntimeError) as error:
            raise SnapshotError("快照压缩包损坏或无法读取") from error

    @staticmethod
    def _upgrade_and_verify_database(
        database_path: Path,
        stage: Path,
        manifest: SnapshotManifest,
    ) -> WorkspaceDatabase:
        state = inspect_database(database_path)
        if manifest.format == V2_SNAPSHOT_FORMAT:
            if state.kind is not DatabaseKind.LEGACY_V2:
                raise SnapshotError("v2 快照清单与数据库结构不一致")
            try:
                migration = migrate_v2_database(
                    database_path,
                    data_dir=stage,
                    verify_files=True,
                )
            except (V2ImportError, OSError, sqlite3.DatabaseError) as error:
                raise SnapshotError(f"v2 快照迁移失败: {error}") from error
            if migration.backup_database is not None:
                SnapshotRestorer._remove_staged_migration_backup(migration.backup_database)
        elif manifest.format == SNAPSHOT_FORMAT:
            if state.kind is not DatabaseKind.V4:
                raise SnapshotError("v4 快照清单与数据库结构不一致")
        elif manifest.format == V3_SNAPSHOT_FORMAT:
            if state.kind is not DatabaseKind.LEGACY_V3:
                raise SnapshotError("v3 快照清单与数据库结构不一致")
            try:
                migration = migrate_workspace_database(database_path)
            except (V3MigrationError, OSError, sqlite3.DatabaseError) as error:
                raise SnapshotError(f"v3 快照迁移失败: {error}") from error
            if migration.backup_database is not None:
                SnapshotRestorer._remove_staged_migration_backup(migration.backup_database)
        else:  # SnapshotManifest rejects unsupported formats; keep the boundary explicit.
            raise SnapshotError("快照容器格式不受支持")

        database = WorkspaceDatabase(database_path)
        try:
            database.verify()
        except (RuntimeError, sqlite3.DatabaseError) as error:
            raise SnapshotError("快照数据库未通过当前结构校验") from error
        return database

    @staticmethod
    def _remove_staged_migration_backup(path: Path) -> None:
        path.unlink(missing_ok=True)
        path.with_name(f"{path.name}-wal").unlink(missing_ok=True)
        path.with_name(f"{path.name}-shm").unlink(missing_ok=True)

    @staticmethod
    def _validate_payload(
        stage: Path,
        database: WorkspaceDatabase,
        manifest: SnapshotManifest,
    ) -> None:
        file_records = {item.path.removeprefix("payload/"): item for item in manifest.files}
        try:
            with database.read() as connection:
                unavailable = connection.execute(
                    """
                    SELECT a.id
                    FROM attachments a
                    WHERE NOT EXISTS (
                        SELECT 1 FROM blob_objects bo
                        WHERE bo.blob_id = a.blob_id
                          AND bo.storage_backend = 'local'
                          AND bo.state = 'available'
                    )
                    LIMIT 1
                    """
                ).fetchone()
                if unavailable is not None:
                    raise SnapshotError(f"快照附件缺少可用的本地对象: {unavailable['id']}")
                rows = connection.execute(
                    """
                    SELECT bo.storage_key, b.sha256, b.size
                    FROM blob_objects bo
                    JOIN blobs b ON b.id = bo.blob_id
                    WHERE bo.storage_backend = 'local' AND bo.state = 'available'
                    ORDER BY bo.storage_key
                    """
                ).fetchall()
        except sqlite3.DatabaseError as error:
            raise SnapshotError("快照数据库不符合当前文件模型") from error

        expected_paths = {DATABASE_ARCHIVE_PATH.removeprefix("payload/")}
        for row in rows:
            storage_key = str(row["storage_key"])
            path = resolve_data_path(stage, storage_key)
            record = file_records.get(storage_key)
            if (
                record is None
                or record.sha256 != row["sha256"]
                or record.size != row["size"]
                or not path.is_file()
            ):
                raise SnapshotError(f"资源文件与数据库记录不一致: {storage_key}")
            expected_paths.add(storage_key)
        if set(file_records) != expected_paths:
            raise SnapshotError("快照包含数据库未引用的文件")

    @staticmethod
    def _ensure_restored_jobs_are_terminal(database: WorkspaceDatabase) -> None:
        placeholders = ", ".join("?" for _ in _ACTIVE_JOB_STATUSES)
        try:
            with database.read() as connection:
                row = connection.execute(
                    f"SELECT id FROM jobs WHERE status IN ({placeholders}) LIMIT 1",  # noqa: S608
                    _ACTIVE_JOB_STATUSES,
                ).fetchone()
        except sqlite3.DatabaseError as error:
            raise SnapshotError("无法校验快照中的任务状态") from error
        if row is not None:
            raise SnapshotError(f"快照包含未结束任务: {row['id']}")

    @staticmethod
    def _activate(
        stage: Path,
        data_dir: Path,
        *,
        replace: bool,
        activation_journal: Path,
        fault_injector: FaultInjector | None = None,
    ) -> Path | None:
        had_active_data = data_dir.exists() and any(data_dir.iterdir())
        if had_active_data and not replace:
            raise SnapshotError("目标数据目录非空")
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        recovery = data_dir.with_name(
            f"{data_dir.name}.before-restore-{timestamp}-{uuid4().hex[:8]}"
        )
        try:
            activate_snapshot_directory(
                stage,
                data_dir,
                recovery,
                journal_path=activation_journal,
                fault_injector=fault_injector,
            )
        except ActivationError as error:
            raise SnapshotError(str(error)) from error
        return recovery if had_active_data else None

    @staticmethod
    def _check_cancelled(should_cancel: Callable[[], bool] | None) -> None:
        if should_cancel is not None and should_cancel():
            raise SnapshotCancelled("快照操作已取消")

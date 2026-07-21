from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from app.platform.db import V3Database
from app.utils.time import utc_now

from .contract import (
    DATABASE_ARCHIVE_PATH,
    MANIFEST_PATH,
    SNAPSHOT_FORMAT,
    SnapshotFile,
    SnapshotManifest,
)
from .errors import SnapshotCancelled, SnapshotError
from .paths import resolve_data_path, safe_archive_path

_ACTIVE_JOB_STATUSES = ("queued", "running", "cancellation_requested")
_COPY_CHUNK_SIZE = 1024 * 1024


@dataclass(frozen=True)
class SnapshotWriteResult:
    archive_path: Path
    file_count: int
    size: int


@dataclass(frozen=True)
class _ResourceRecord:
    storage_key: str
    sha256: str
    size: int


class SnapshotWriter:
    """Create a verified current snapshot without exposing a half-written archive."""

    def __init__(self, data_dir: Path, database: V3Database):
        self.data_dir = data_dir.resolve()
        self.database = database
        self.database_path = database.path

    def write(
        self,
        archive_path: Path,
        *,
        operation_job_id: str | None = None,
        should_cancel: Callable[[], bool] | None = None,
        source_idle_check: Callable[[], None] | None = None,
    ) -> SnapshotWriteResult:
        self._check_cancelled(should_cancel)
        self.database.verify()
        archive_path = archive_path.resolve()
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        if archive_path.exists():
            raise SnapshotError(f"快照文件已存在: {archive_path}")

        temporary_archive: Path | None = None
        with tempfile.TemporaryDirectory(
            prefix=".snapshot-database-", dir=archive_path.parent
        ) as temporary:
            database_copy = Path(temporary) / "research.sqlite3"
            self._backup_database(database_copy)
            self._prepare_database_copy(database_copy, operation_job_id)
            resources = self._resource_records(database_copy)

            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{archive_path.name}.",
                suffix=".building",
                dir=archive_path.parent,
            )
            os.close(descriptor)
            temporary_archive = Path(temporary_name)
            try:
                files: list[SnapshotFile] = []
                with ZipFile(
                    temporary_archive,
                    "w",
                    compression=ZIP_DEFLATED,
                    compresslevel=1,
                    allowZip64=True,
                ) as archive:
                    files.append(
                        self._write_file(
                            archive,
                            database_copy,
                            DATABASE_ARCHIVE_PATH,
                            should_cancel=should_cancel,
                        )
                    )
                    for resource in resources:
                        self._check_cancelled(should_cancel)
                        source = resolve_data_path(self.data_dir, resource.storage_key)
                        if not source.is_file():
                            raise SnapshotError(
                                f"数据库引用的文件不存在: {resource.storage_key}"
                            )
                        item = self._write_file(
                            archive,
                            source,
                            f"payload/{resource.storage_key}",
                            should_cancel=should_cancel,
                        )
                        if item.sha256 != resource.sha256 or item.size != resource.size:
                            raise SnapshotError(
                                "文件与数据库记录不一致，快照已取消: "
                                f"{resource.storage_key}"
                            )
                        files.append(item)
                    manifest = SnapshotManifest(
                        format=SNAPSHOT_FORMAT,
                        created_at=utc_now().isoformat(),
                        schema_version=V3Database(database_copy).schema_version(),
                        contract_version="4.0",
                        files=tuple(sorted(files, key=lambda item: item.path)),
                    )
                    archive.writestr(MANIFEST_PATH, manifest.to_json().encode("utf-8"))

                self._check_cancelled(should_cancel)
                if source_idle_check is not None:
                    source_idle_check()
                self._check_cancelled(should_cancel)
                # Windows requires a writable descriptor for fsync.
                with temporary_archive.open("r+b") as stream:
                    os.fsync(stream.fileno())
                os.replace(temporary_archive, archive_path)
                temporary_archive = None
            finally:
                if temporary_archive is not None:
                    temporary_archive.unlink(missing_ok=True)

        return SnapshotWriteResult(
            archive_path=archive_path,
            file_count=len(files),
            size=archive_path.stat().st_size,
        )

    def _backup_database(self, target: Path) -> None:
        try:
            with self.database.read() as source:
                destination = sqlite3.connect(target)
                try:
                    source.backup(destination)
                finally:
                    destination.close()
        except sqlite3.DatabaseError as error:
            raise SnapshotError("无法创建一致的数据库副本") from error

    @staticmethod
    def _prepare_database_copy(database_copy: Path, operation_job_id: str | None) -> None:
        try:
            connection = sqlite3.connect(database_copy)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            try:
                placeholders = ", ".join("?" for _ in _ACTIVE_JOB_STATUSES)
                rows = connection.execute(
                    f"SELECT id FROM jobs WHERE status IN ({placeholders})",  # noqa: S608
                    _ACTIVE_JOB_STATUSES,
                ).fetchall()
                other_jobs = [row["id"] for row in rows if row["id"] != operation_job_id]
                if other_jobs:
                    raise SnapshotError("数据库副本中存在其他尚未结束的任务")
                if operation_job_id is not None:
                    connection.execute("DELETE FROM jobs WHERE id = ?", (operation_job_id,))
                    connection.execute(
                        """
                        INSERT INTO audit_events(
                            id, occurred_at, actor_type, actor_id, action,
                            entity_type, entity_id, metadata_json
                        ) VALUES(
                            lower(hex(randomblob(16))), ?, 'system', 'snapshot',
                            'snapshot.control_job_omitted', 'workspace', 'local', ?
                        )
                        """,
                        (
                            utc_now().isoformat(),
                            json.dumps({"job_id": operation_job_id}, ensure_ascii=False),
                        ),
                    )
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()
            V3Database(database_copy).verify()
        except sqlite3.DatabaseError as error:
            raise SnapshotError("数据库副本不符合当前结构") from error

    @staticmethod
    def _resource_records(database_copy: Path) -> list[_ResourceRecord]:
        try:
            connection = sqlite3.connect(database_copy)
            connection.row_factory = sqlite3.Row
            try:
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
                    raise SnapshotError(
                        f"附件没有可备份的本地对象: {unavailable['id']}"
                    )
                rows = connection.execute(
                    """
                    SELECT bo.storage_key, b.sha256, b.size
                    FROM blob_objects bo
                    JOIN blobs b ON b.id = bo.blob_id
                    WHERE bo.storage_backend = 'local' AND bo.state = 'available'
                    ORDER BY bo.storage_key
                    """
                ).fetchall()
            finally:
                connection.close()
        except sqlite3.DatabaseError as error:
            raise SnapshotError("无法读取当前文件索引") from error

        records: list[_ResourceRecord] = []
        seen_paths = {DATABASE_ARCHIVE_PATH}
        for row in rows:
            archive_path = f"payload/{row['storage_key']}"
            safe_archive_path(archive_path)
            if archive_path in seen_paths:
                raise SnapshotError(f"文件索引包含保留或重复路径: {row['storage_key']}")
            seen_paths.add(archive_path)
            records.append(
                _ResourceRecord(
                    storage_key=str(row["storage_key"]),
                    sha256=str(row["sha256"]),
                    size=int(row["size"]),
                )
            )
        return records

    @staticmethod
    def _write_file(
        archive: ZipFile,
        source: Path,
        archive_path: str,
        *,
        should_cancel: Callable[[], bool] | None,
    ) -> SnapshotFile:
        safe_archive_path(archive_path)
        digest = hashlib.sha256()
        size = 0
        with source.open("rb") as input_stream, archive.open(archive_path, "w") as output:
            while chunk := input_stream.read(_COPY_CHUNK_SIZE):
                SnapshotWriter._check_cancelled(should_cancel)
                output.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        return SnapshotFile(path=archive_path, sha256=digest.hexdigest(), size=size)

    @staticmethod
    def _check_cancelled(should_cancel: Callable[[], bool] | None) -> None:
        if should_cancel is not None and should_cancel():
            raise SnapshotCancelled("快照操作已取消")

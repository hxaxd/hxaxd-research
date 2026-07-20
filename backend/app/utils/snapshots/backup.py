from __future__ import annotations

import shutil
import sqlite3
import tempfile
from dataclasses import dataclass
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from app.utils.time import utc_now

from .contract import (
    DATABASE_ARCHIVE_PATH,
    MANIFEST_PATH,
    SNAPSHOT_FORMAT,
    SnapshotFile,
    SnapshotManifest,
)
from .database_validation import validate_database
from .errors import SnapshotError
from .hashing import sha256_file
from .paths import resolve_data_path


@dataclass(frozen=True)
class SnapshotWriteResult:
    archive_path: Path
    file_count: int


class SnapshotWriter:
    def __init__(self, data_dir: Path, database_path: Path, schema_path: Path):
        self.data_dir = data_dir.resolve()
        self.database_path = database_path.resolve()
        self.schema_path = schema_path.resolve()

    def write(self, archive_path: Path) -> SnapshotWriteResult:
        if not self.database_path.is_file():
            raise SnapshotError("数据目录中不存在学习数据库")
        archive_path = archive_path.resolve()
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        if archive_path.exists():
            raise SnapshotError(f"快照文件已存在: {archive_path}")

        with tempfile.TemporaryDirectory(prefix="learning-snapshot-") as temporary:
            stage = Path(temporary)
            database_copy = stage / DATABASE_ARCHIVE_PATH
            database_copy.parent.mkdir(parents=True)
            self._backup_database(database_copy)
            validate_database(database_copy)
            files = [self._stage_database(database_copy)]
            files.extend(self._stage_resources(database_copy, stage))
            manifest = SnapshotManifest(
                format=SNAPSHOT_FORMAT,
                created_at=utc_now().isoformat(),
                schema_version=self._schema_version(database_copy),
                contract_version="2.0",
                schema_sha256=None,
                files=tuple(sorted(files, key=lambda item: item.path)),
            )
            (stage / MANIFEST_PATH).write_text(manifest.to_json(), encoding="utf-8")
            temporary_archive = archive_path.with_suffix(f"{archive_path.suffix}.building")
            try:
                with ZipFile(temporary_archive, "w", compression=ZIP_DEFLATED) as archive:
                    archive.write(stage / MANIFEST_PATH, MANIFEST_PATH)
                    for item in manifest.files:
                        archive.write(stage / item.path, item.path)
                temporary_archive.replace(archive_path)
            finally:
                temporary_archive.unlink(missing_ok=True)
        return SnapshotWriteResult(archive_path=archive_path, file_count=len(files))

    def _backup_database(self, target: Path) -> None:
        source = sqlite3.connect(self.database_path, timeout=30)
        destination = sqlite3.connect(target)
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()

    @staticmethod
    def _stage_database(database_copy: Path) -> SnapshotFile:
        return SnapshotFile(
            path=DATABASE_ARCHIVE_PATH,
            sha256=sha256_file(database_copy),
            size=database_copy.stat().st_size,
        )

    @staticmethod
    def _schema_version(database_copy: Path) -> int:
        connection = sqlite3.connect(database_copy)
        try:
            row = connection.execute(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations"
            ).fetchone()
        finally:
            connection.close()
        return int(row[0])

    def _stage_resources(self, database_copy: Path, stage: Path) -> list[SnapshotFile]:
        connection = sqlite3.connect(database_copy)
        try:
            active_jobs = connection.execute(
                "SELECT COUNT(*) FROM jobs WHERE status IN ('queued', 'running')"
            ).fetchone()[0]
            if active_jobs:
                raise SnapshotError("存在尚未结束的翻译任务，请等待任务结束后再备份")
            rows = connection.execute(
                "SELECT relative_path, sha256, size FROM resources ORDER BY relative_path"
            ).fetchall()
        finally:
            connection.close()

        files: list[SnapshotFile] = []
        for relative_path, expected_sha256, expected_size in rows:
            source = resolve_data_path(self.data_dir, relative_path)
            if not source.is_file():
                raise SnapshotError(f"数据库引用的文件不存在: {relative_path}")
            archive_path = f"payload/{relative_path}"
            target = stage / archive_path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            actual_size = target.stat().st_size
            actual_sha256 = sha256_file(target)
            if actual_size != expected_size or actual_sha256 != expected_sha256:
                raise SnapshotError(f"文件与数据库记录不一致，快照已取消: {relative_path}")
            files.append(SnapshotFile(path=archive_path, sha256=actual_sha256, size=actual_size))
        return files

from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from .contract import (
    DATABASE_ARCHIVE_PATH,
    MANIFEST_PATH,
    SnapshotManifest,
)
from .database_validation import validate_database
from .errors import SnapshotError
from .hashing import sha256_file
from .paths import (
    payload_relative_path,
    resolve_data_path,
    safe_archive_path,
)


@dataclass(frozen=True)
class SnapshotRestoreResult:
    data_dir: Path
    recovery_dir: Path | None
    file_count: int


class SnapshotRestorer:
    def __init__(self, schema_path: Path):
        self.schema_path = schema_path.resolve()

    def restore(
        self,
        archive_path: Path,
        data_dir: Path,
        *,
        replace: bool = False,
    ) -> SnapshotRestoreResult:
        archive_path = archive_path.resolve()
        data_dir = data_dir.resolve()
        if not archive_path.is_file():
            raise SnapshotError(f"快照文件不存在: {archive_path}")
        data_dir.parent.mkdir(parents=True, exist_ok=True)
        if data_dir.exists() and any(data_dir.iterdir()) and not replace:
            raise SnapshotError("目标数据目录非空；如需重建，必须显式使用 --replace")

        with tempfile.TemporaryDirectory(
            prefix="research-restore-", dir=data_dir.parent
        ) as temporary:
            stage = Path(temporary) / "data"
            stage.mkdir()
            manifest = self._extract_verified(archive_path, stage)
            self._validate_payload(stage, manifest)
            recovery = self._activate(stage, data_dir, replace=replace)
        return SnapshotRestoreResult(
            data_dir=data_dir,
            recovery_dir=recovery,
            file_count=len(manifest.files),
        )

    def _extract_verified(self, archive_path: Path, stage: Path) -> SnapshotManifest:
        try:
            with ZipFile(archive_path) as archive:
                members = [name for name in archive.namelist() if not name.endswith("/")]
                for name in members:
                    safe_archive_path(name)
                if MANIFEST_PATH not in members:
                    raise SnapshotError("快照缺少清单")
                manifest = SnapshotManifest.from_json(
                    archive.read(MANIFEST_PATH).decode("utf-8")
                )
                if manifest.schema_sha256 != sha256_file(self.schema_path):
                    raise SnapshotError("数据库结构与当前程序不一致；不执行兼容或迁移")
                expected = {MANIFEST_PATH, *(item.path for item in manifest.files)}
                if set(members) != expected:
                    raise SnapshotError("快照内容与清单不一致")
                for item in manifest.files:
                    target = stage / payload_relative_path(item.path)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item.path) as source, target.open("wb") as output:
                        shutil.copyfileobj(source, output)
                    if target.stat().st_size != item.size or sha256_file(target) != item.sha256:
                        raise SnapshotError(f"快照文件校验失败: {item.path}")
                return manifest
        except (BadZipFile, UnicodeDecodeError) as error:
            raise SnapshotError("快照压缩包损坏") from error

    @staticmethod
    def _validate_payload(stage: Path, manifest: SnapshotManifest) -> None:
        database_path = stage / Path(DATABASE_ARCHIVE_PATH).relative_to("payload")
        validate_database(database_path)
        file_records = {
            item.path.removeprefix("payload/"): item for item in manifest.files
        }
        connection = sqlite3.connect(database_path)
        try:
            rows = connection.execute(
                "SELECT relative_path, sha256, size FROM artifacts ORDER BY relative_path"
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise SnapshotError("快照数据库不符合当前结构") from error
        finally:
            connection.close()
        expected_paths = {DATABASE_ARCHIVE_PATH.removeprefix("payload/")}
        for relative_path, expected_sha256, expected_size in rows:
            resolve_data_path(stage, relative_path)
            record = file_records.get(relative_path)
            if (
                record is None
                or record.sha256 != expected_sha256
                or record.size != expected_size
            ):
                raise SnapshotError(f"PDF 文件与数据库记录不一致: {relative_path}")
            expected_paths.add(relative_path)
        if set(file_records) != expected_paths:
            raise SnapshotError("快照包含数据库未引用的文件")

    @staticmethod
    def _activate(stage: Path, data_dir: Path, *, replace: bool) -> Path | None:
        recovery: Path | None = None
        if data_dir.exists():
            if any(data_dir.iterdir()):
                if not replace:
                    raise SnapshotError("目标数据目录非空")
                timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
                recovery = data_dir.with_name(f"{data_dir.name}.before-restore-{timestamp}")
                if recovery.exists():
                    raise SnapshotError(f"恢复目录已存在: {recovery}")
                os.replace(data_dir, recovery)
            else:
                data_dir.rmdir()
        try:
            os.replace(stage, data_dir)
        except Exception:
            if recovery is not None and not data_dir.exists():
                os.replace(recovery, data_dir)
            raise
        return recovery

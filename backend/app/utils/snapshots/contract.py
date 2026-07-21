from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .errors import SnapshotError

SNAPSHOT_FORMAT = "hxaxd-research-v3"
V2_SNAPSHOT_FORMAT = "hxaxd-learning-v2"
SUPPORTED_SNAPSHOT_FORMATS = frozenset({SNAPSHOT_FORMAT, V2_SNAPSHOT_FORMAT})
MANIFEST_PATH = "manifest.json"
DATABASE_ARCHIVE_PATH = "payload/research.sqlite3"


@dataclass(frozen=True)
class SnapshotFile:
    path: str
    sha256: str
    size: int

    @classmethod
    def from_dict(cls, value: Any) -> SnapshotFile:
        if not isinstance(value, dict) or set(value) != {"path", "sha256", "size"}:
            raise SnapshotError("快照文件记录不符合当前格式")
        path = value["path"]
        sha256 = value["sha256"]
        size = value["size"]
        if (
            not isinstance(path, str)
            or not isinstance(sha256, str)
            or not isinstance(size, int)
            or isinstance(size, bool)
        ):
            raise SnapshotError("快照文件记录字段类型错误")
        if len(sha256) != 64 or any(character not in "0123456789abcdef" for character in sha256):
            raise SnapshotError("快照文件散列不是规范的 SHA-256")
        if size < 0:
            raise SnapshotError("快照文件大小不能为负数")
        return cls(path=path, sha256=sha256, size=size)


@dataclass(frozen=True)
class SnapshotManifest:
    format: str
    created_at: str
    schema_version: int
    contract_version: str
    files: tuple[SnapshotFile, ...]

    def to_json(self) -> str:
        payload = {
            "format": self.format,
            "created_at": self.created_at,
            "schema_version": self.schema_version,
            "contract_version": self.contract_version,
            "files": [
                {"path": item.path, "sha256": item.sha256, "size": item.size}
                for item in self.files
            ],
        }
        return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)

    @classmethod
    def from_json(cls, content: str) -> SnapshotManifest:
        try:
            payload = json.loads(content)
        except json.JSONDecodeError as error:
            raise SnapshotError("快照清单不是有效 JSON") from error
        expected = {"format", "created_at", "schema_version", "contract_version", "files"}
        if not isinstance(payload, dict) or set(payload) != expected:
            raise SnapshotError("快照清单不符合当前格式")
        format_ = payload["format"]
        created_at = payload["created_at"]
        schema_version = payload["schema_version"]
        contract_version = payload["contract_version"]
        if format_ not in SUPPORTED_SNAPSHOT_FORMATS:
            raise SnapshotError("快照容器格式不受支持")
        if (
            not isinstance(created_at, str)
            or not isinstance(schema_version, int)
            or isinstance(schema_version, bool)
            or not isinstance(contract_version, str)
        ):
            raise SnapshotError("快照版本字段类型错误")
        if format_ == SNAPSHOT_FORMAT and (schema_version != 3 or contract_version != "3.0"):
            raise SnapshotError("v3 快照契约版本不受支持")
        if format_ == V2_SNAPSHOT_FORMAT and schema_version != 2:
            raise SnapshotError("v2 快照结构版本不受支持")
        raw_files = payload["files"]
        if not isinstance(raw_files, list):
            raise SnapshotError("快照文件列表类型错误")
        files = tuple(SnapshotFile.from_dict(item) for item in raw_files)
        if len({item.path for item in files}) != len(files):
            raise SnapshotError("快照包含重复文件路径")
        if DATABASE_ARCHIVE_PATH not in {item.path for item in files}:
            raise SnapshotError("快照清单缺少数据库")
        return cls(
            format=format_,
            created_at=created_at,
            schema_version=schema_version,
            contract_version=contract_version,
            files=files,
        )

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .errors import SnapshotError

SNAPSHOT_FORMAT = "hxaxd-learning-v2"
LEGACY_SNAPSHOT_FORMAT = "hxaxd-learning-exact-v1"
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
        if not isinstance(path, str) or not isinstance(sha256, str) or not isinstance(size, int):
            raise SnapshotError("快照文件记录字段类型错误")
        return cls(path=path, sha256=sha256, size=size)


@dataclass(frozen=True)
class SnapshotManifest:
    format: str
    created_at: str
    schema_version: int
    contract_version: str
    schema_sha256: str | None
    files: tuple[SnapshotFile, ...]

    def to_json(self) -> str:
        payload = {
            "format": self.format,
            "created_at": self.created_at,
            "schema_version": self.schema_version,
            "contract_version": self.contract_version,
            "files": [
                {"path": item.path, "sha256": item.sha256, "size": item.size} for item in self.files
            ],
        }
        return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)

    @classmethod
    def from_json(cls, content: str) -> SnapshotManifest:
        try:
            payload = json.loads(content)
        except json.JSONDecodeError as error:
            raise SnapshotError("快照清单不是有效 JSON") from error
        if not isinstance(payload, dict):
            raise SnapshotError("快照清单不符合当前格式")
        format_ = payload.get("format")
        if format_ == LEGACY_SNAPSHOT_FORMAT:
            expected = {"format", "created_at", "schema_sha256", "files"}
            schema_version = 1
            contract_version = "1.0"
            schema_sha256 = payload.get("schema_sha256")
        elif format_ == SNAPSHOT_FORMAT:
            expected = {"format", "created_at", "schema_version", "contract_version", "files"}
            schema_version = payload.get("schema_version")
            contract_version = payload.get("contract_version")
            schema_sha256 = None
        else:
            raise SnapshotError("快照容器格式不受支持")
        if set(payload) != expected:
            raise SnapshotError("快照清单不符合当前格式")
        if not isinstance(payload.get("created_at"), str):
            raise SnapshotError("快照清单字段类型错误")
        if not isinstance(schema_version, int) or not isinstance(contract_version, str):
            raise SnapshotError("快照版本字段类型错误")
        if schema_sha256 is not None and not isinstance(schema_sha256, str):
            raise SnapshotError("旧快照结构散列字段类型错误")
        if not isinstance(payload["files"], list):
            raise SnapshotError("快照文件列表类型错误")
        files = tuple(SnapshotFile.from_dict(item) for item in payload["files"])
        if len({item.path for item in files}) != len(files):
            raise SnapshotError("快照包含重复文件路径")
        return cls(
            format=format_,
            created_at=payload["created_at"],
            schema_version=schema_version,
            contract_version=contract_version,
            schema_sha256=schema_sha256,
            files=files,
        )

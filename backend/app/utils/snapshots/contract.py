from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .errors import SnapshotError

SNAPSHOT_FORMAT = "hxaxd-learning-exact-v1"
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
    schema_sha256: str
    files: tuple[SnapshotFile, ...]

    def to_json(self) -> str:
        payload = {
            "format": self.format,
            "created_at": self.created_at,
            "schema_sha256": self.schema_sha256,
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
        expected = {"format", "created_at", "schema_sha256", "files"}
        if not isinstance(payload, dict) or set(payload) != expected:
            raise SnapshotError("快照清单不符合当前格式")
        if payload["format"] != SNAPSHOT_FORMAT:
            raise SnapshotError("快照格式与当前程序不一致；不执行兼容或迁移")
        if not isinstance(payload["created_at"], str) or not isinstance(
            payload["schema_sha256"], str
        ):
            raise SnapshotError("快照清单字段类型错误")
        if not isinstance(payload["files"], list):
            raise SnapshotError("快照文件列表类型错误")
        files = tuple(SnapshotFile.from_dict(item) for item in payload["files"])
        if len({item.path for item in files}) != len(files):
            raise SnapshotError("快照包含重复文件路径")
        return cls(
            format=payload["format"],
            created_at=payload["created_at"],
            schema_sha256=payload["schema_sha256"],
            files=files,
        )

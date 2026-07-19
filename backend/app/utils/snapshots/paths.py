from __future__ import annotations

from pathlib import Path, PurePosixPath

from .errors import SnapshotError


def safe_archive_path(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "\\" in value or not path.parts:
        raise SnapshotError(f"快照包含非法路径: {value}")
    return path


def payload_relative_path(value: str) -> Path:
    path = safe_archive_path(value)
    if len(path.parts) < 2 or path.parts[0] != "payload":
        raise SnapshotError(f"数据文件不在 payload 目录内: {value}")
    return Path(*path.parts[1:])


def resolve_data_path(data_dir: Path, relative_path: str) -> Path:
    relative = safe_archive_path(relative_path)
    target = (data_dir / Path(*relative.parts)).resolve()
    root = data_dir.resolve()
    if target == root or root not in target.parents:
        raise SnapshotError(f"数据库包含越界文件路径: {relative_path}")
    return target

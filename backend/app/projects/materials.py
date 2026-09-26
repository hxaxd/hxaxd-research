"""Project materials: adding local files into the managed directory.

The project directory is the source of truth for files, so this module keeps
no separate inventory. One add is one atomic file write:

- the stored name is the sanitized basename of the upload;
- an identical file (same SHA-256) already present under the same name is a
  duplicate and is skipped, so a repeated add does not copy anything;
- the same name with different content is never overwritten: the incoming
  file lands next to it as "name (1).ext", "name (2).ext", ...;
- writes go to a temp file in the target directory and `os.replace` into
  place, so a failure never leaves a half-written material behind.
"""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from .errors import ProjectValidationError

# Generous local-workbench guard: one material larger than this is refused
# with a clear error instead of filling the disk silently.
MAX_MATERIAL_BYTES = 2 * 1024 * 1024 * 1024
_MAX_NAME_CODEPOINTS = 200
_SUFFIX_PATTERN = re.compile(r"^(.*) \((\d+)\)$")


@dataclass(frozen=True)
class AddedMaterial:
    """One material the backend accepted."""

    name: str
    size: int
    duplicate: bool


def sanitize_material_name(raw_name: str) -> str:
    """Reduce an upload name to a safe single path segment."""
    name = os.path.basename(raw_name.replace("\\", "/")).strip()
    if name in ("", ".", ".."):
        raise ProjectValidationError("材料文件名无效")
    if len(name) > _MAX_NAME_CODEPOINTS:
        stem, suffix = os.path.splitext(name)
        keep = _MAX_NAME_CODEPOINTS - len(suffix)
        name = stem[:keep] + suffix
    return name


def next_free_name(directory: Path, name: str) -> str:
    """First free "name (n).ext" variant of `name` inside `directory`."""
    stem, suffix = os.path.splitext(name)
    match = _SUFFIX_PATTERN.match(stem)
    if match is not None:
        stem = match.group(1)
    counter = 1
    while True:
        candidate = f"{stem} ({counter}){suffix}"
        if not (directory / candidate).exists():
            return candidate
        counter += 1


def hash_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def add_material(directory: Path, raw_name: str, chunks: Iterable[bytes]) -> AddedMaterial:
    """Store one uploaded file in `directory` under a non-conflicting name."""
    name = sanitize_material_name(raw_name)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    digest = hashlib.sha256()
    size = 0
    temp = directory / f".{name}.tmp-{uuid4().hex}"
    try:
        with temp.open("wb") as handle:
            for chunk in chunks:
                size += len(chunk)
                if size > MAX_MATERIAL_BYTES:
                    raise ProjectValidationError(
                        f"材料 {name} 超过单文件大小上限"
                    )
                digest.update(chunk)
                handle.write(chunk)
        if target.exists() and hash_of(target) == digest.hexdigest():
            temp.unlink()
            return AddedMaterial(name=name, size=size, duplicate=True)
        final_name = name
        if target.exists():
            final_name = next_free_name(directory, name)
        os.replace(temp, directory / final_name)
        return AddedMaterial(name=final_name, size=size, duplicate=False)
    finally:
        if temp.exists():
            temp.unlink()

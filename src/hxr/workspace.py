from __future__ import annotations

import os
import tempfile
from pathlib import Path

from .errors import HxrError


def require_workspace_path(path: Path, workspace: Path, label: str) -> Path:
    resolved = path.resolve()
    root = workspace.resolve()
    if not resolved.is_relative_to(root):
        raise HxrError(f"{label} must be inside the configured workspace: {root}")
    return resolved


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        newline="\n",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def atomic_replace_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, target)

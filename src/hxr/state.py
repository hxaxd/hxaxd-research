from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STATE_FILE = ".hxr.json"
STATE_VERSION = 2


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_state(paper_dir: Path) -> dict[str, Any]:
    path = paper_dir / STATE_FILE
    if not path.exists():
        return {"version": STATE_VERSION, "operations": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") != STATE_VERSION:
        return {"version": STATE_VERSION, "operations": {}}
    return data


def save_state(paper_dir: Path, state: dict[str, Any]) -> None:
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    path = paper_dir / STATE_FILE
    temp = path.with_suffix(".tmp")
    temp.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temp.replace(path)


def operation_key(operation: str, document_format: str, output: Path) -> str:
    return f"{operation}:{document_format}:{output.resolve()}"


def cache_hit(
    state: dict[str, Any],
    key: str,
    input_hash: str,
    config_hash: str,
    output: Path,
) -> bool:
    saved = state.get("operations", {}).get(key, {})
    return (
        saved.get("status") == "complete"
        and saved.get("input_hash") == input_hash
        and saved.get("config_hash") == config_hash
        and output.exists()
        and saved.get("output_hash") == file_hash(output)
    )


def complete_stage(
    state: dict[str, Any],
    key: str,
    input_hash: str,
    config_hash: str,
    output: Path,
) -> None:
    state.setdefault("operations", {})[key] = {
        "status": "complete",
        "input_hash": input_hash,
        "config_hash": config_hash,
        "output": str(output.resolve()),
        "output_hash": file_hash(output),
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }


def fail_stage(
    state: dict[str, Any],
    key: str,
    input_hash: str,
    config_hash: str,
    error: Exception,
) -> None:
    state.setdefault("operations", {})[key] = {
        "status": "failed",
        "input_hash": input_hash,
        "config_hash": config_hash,
        "error_type": type(error).__name__,
        "error": str(error),
        "failed_at": datetime.now(timezone.utc).isoformat(),
    }

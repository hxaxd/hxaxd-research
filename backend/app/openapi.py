"""Dump the OpenAPI schema as the pinned frontend contract.

`uv run python -m app.openapi` regenerates
`frontend/src/shared/api/openapi.json`; the backend contract test fails when
the live schema drifts from that pinned file, and the frontend contract test
validates its handwritten types against the same file.
"""

from __future__ import annotations

import json
from pathlib import Path

from .main import app

FRONTEND_CONTRACT_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "frontend"
    / "src"
    / "shared"
    / "api"
    / "openapi.json"
)


def dump_openapi(path: Path | None = None) -> Path:
    target = path or FRONTEND_CONTRACT_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return target


if __name__ == "__main__":
    print(dump_openapi())

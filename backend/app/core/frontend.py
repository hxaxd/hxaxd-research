from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse


def mount_frontend(application: FastAPI, distribution: Path) -> None:
    index = distribution / "index.html"
    if not index.is_file():
        return
    root = distribution.resolve()

    @application.get("/{frontend_path:path}", include_in_schema=False)
    def frontend(frontend_path: str) -> FileResponse:
        requested = (root / frontend_path).resolve()
        if requested != root and root not in requested.parents:
            raise HTTPException(status_code=404)
        if frontend_path and requested.is_file():
            return FileResponse(requested)
        return FileResponse(index)

"""Local launcher: `uv run python -m app` starts the workbench backend."""

from __future__ import annotations

import uvicorn

from .config import load_settings


def main() -> None:
    settings = load_settings()
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=settings.backend_port,
        log_level="info",
    )


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn

from app.core.config import Settings
from app.jobs.models import JobFailure
from app.main import create_app
from app.operations import handlers

from .sample_data import PDF


def _fixture_download(
    _url: str,
    target: Path,
    *,
    cancellation,
    **_kwargs,
) -> None:
    if cancellation():
        raise JobFailure("canceled", "下载已取消", retryable=True)
    target.write_bytes(PDF)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4174)
    arguments = parser.parse_args()
    handlers._download_https = _fixture_download
    with TemporaryDirectory(prefix="hxaxd-fullstack-") as temporary:
        root = Path(temporary).resolve()
        data = root / "data"
        base = Settings.from_environment()
        url = f"http://127.0.0.1:{arguments.port}"
        settings = replace(
            base,
            data_dir=data,
            database_path=data / "research.sqlite3",
            artifact_dir=data / "artifacts",
            snapshot_dir=root / "snapshots",
            agent_runtime_dir=root / "agent-runs",
            public_base_url=url,
            agent_base_url=url,
            allowed_hosts=("127.0.0.1", "localhost"),
        )
        uvicorn.run(create_app(settings), host="127.0.0.1", port=arguments.port)


if __name__ == "__main__":
    main()

"""Application settings resolved from the environment.

Single-user, local-first: every path lives under a configurable data
directory so the workbench keeps its own DSH state and project files away
from any other DSH installation on this machine.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_DSH_BASE_URL = "http://127.0.0.1:3080"
DEFAULT_BACKEND_PORT = 8642
# The UI plugin runs inside the DSH web app origin and calls this backend
# cross-origin; loopback DSH origins are the only expected callers.
DEFAULT_ALLOWED_ORIGINS = "http://127.0.0.1:3080,http://localhost:3080"


@dataclass(frozen=True)
class Settings:
    """Resolved configuration for one backend process."""

    data_dir: Path
    projects_root: Path
    dsh_base_url: str
    backend_port: int
    allowed_origins: list[str]

    @property
    def registry_path(self) -> Path:
        return self.data_dir / "projects.sqlite3"


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Build settings from environment variables with local defaults."""
    values = os.environ if env is None else env
    data_dir = Path(values.get("HXAXD_DATA_DIR", str(_BACKEND_ROOT / "data")))
    projects_root = Path(
        values.get("HXAXD_PROJECTS_ROOT", str(data_dir / "projects"))
    )
    allowed_origins = [
        origin.strip()
        for origin in values.get("HXAXD_ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS).split(  # noqa: E501
            ","
        )
        if origin.strip()
    ]
    return Settings(
        data_dir=data_dir,
        projects_root=projects_root,
        dsh_base_url=values.get("HXAXD_DSH_BASE_URL", DEFAULT_DSH_BASE_URL),
        backend_port=int(
            values.get("HXAXD_BACKEND_PORT", str(DEFAULT_BACKEND_PORT))
        ),
        allowed_origins=allowed_origins,
    )

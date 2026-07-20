from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = BACKEND_ROOT.parent


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    database_path: Path
    artifact_dir: Path
    tools_dir: Path
    snapshot_dir: Path
    frontend_origins: tuple[str, ...]

    @property
    def pdf2zh_dir(self) -> Path:
        return self.tools_dir / "pdf2zh"

    @property
    def pdf2zh_executable(self) -> Path:
        executable = "pdf2zh_next.exe" if os.name == "nt" else "pdf2zh_next"
        scripts_directory = "Scripts" if os.name == "nt" else "bin"
        return self.pdf2zh_dir / ".venv" / scripts_directory / executable

    @property
    def tex_dir(self) -> Path:
        return self.tools_dir / "tex"

    @classmethod
    def from_environment(cls) -> Settings:
        data_dir = Path(os.environ.get("RESEARCH_APP_DATA_DIR", BACKEND_ROOT / "data")).resolve()
        return cls(
            data_dir=data_dir,
            database_path=data_dir / "research.sqlite3",
            artifact_dir=data_dir / "artifacts",
            tools_dir=REPOSITORY_ROOT / ".tools",
            snapshot_dir=BACKEND_ROOT / "snapshots",
            frontend_origins=("http://127.0.0.1:5173", "http://localhost:5173"),
        )

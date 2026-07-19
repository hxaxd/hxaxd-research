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
    translate_script: Path
    frontend_origins: tuple[str, ...]

    @classmethod
    def from_environment(cls) -> Settings:
        data_dir = Path(os.environ.get("RESEARCH_APP_DATA_DIR", BACKEND_ROOT / "data")).resolve()
        return cls(
            data_dir=data_dir,
            database_path=data_dir / "research.sqlite3",
            artifact_dir=data_dir / "artifacts",
            translate_script=REPOSITORY_ROOT / "scripts" / "translate-pdf.ps1",
            frontend_origins=("http://127.0.0.1:5173", "http://localhost:5173"),
        )

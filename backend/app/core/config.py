from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

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
    agent_runtime_dir: Path | None = None
    public_base_url: str = "http://127.0.0.1:8000"
    agent_base_url: str = "http://127.0.0.1:8000"
    codex_executable: Path | None = None
    zotero_local_url: str = "http://127.0.0.1:23119/api/"
    zotero_api_key: str | None = None
    translation_api_base_url: str = "https://api.deepseek.com"
    translation_api_key: str | None = None
    translation_provider: str = "deepseek"
    translation_model: str = "deepseek-v4-flash"
    lan_access_enabled: bool = False
    device_session_days: int = 90
    device_cookie_secure: bool = False
    allowed_hosts: tuple[str, ...] = ("127.0.0.1", "localhost")

    @property
    def frontend_dist_dir(self) -> Path:
        return REPOSITORY_ROOT / "frontend" / "dist"

    @property
    def pdf2zh_dir(self) -> Path:
        return self.tools_dir / "pdf2zh"

    @property
    def pdf2zh_executable(self) -> Path:
        executable = "pdf2zh_next.exe" if os.name == "nt" else "pdf2zh_next"
        scripts_directory = "Scripts" if os.name == "nt" else "bin"
        return self.pdf2zh_dir / ".venv" / scripts_directory / executable

    @property
    def babeldoc_executable(self) -> Path:
        executable = "babeldoc.exe" if os.name == "nt" else "babeldoc"
        scripts_directory = "Scripts" if os.name == "nt" else "bin"
        return self.pdf2zh_dir / ".venv" / scripts_directory / executable

    @property
    def pdf2zh_python(self) -> Path:
        executable = "python.exe" if os.name == "nt" else "python"
        scripts_directory = "Scripts" if os.name == "nt" else "bin"
        return self.pdf2zh_dir / ".venv" / scripts_directory / executable

    @property
    def rapidocr_package_dir(self) -> Path | None:
        virtual_environment = self.pdf2zh_dir / ".venv"
        candidates = [virtual_environment / "Lib" / "site-packages" / "rapidocr"]
        candidates.extend(
            virtual_environment.glob("lib/python*/site-packages/rapidocr")
        )
        return next((candidate for candidate in candidates if candidate.is_dir()), None)

    @property
    def tex_dir(self) -> Path:
        return self.tools_dir / "tex"

    @property
    def runtime_dir(self) -> Path:
        return self.data_dir.parent / ".runtime"

    @property
    def activation_journal_path(self) -> Path:
        return self.runtime_dir / "workspace-activation.json"

    @property
    def agent_work_dir(self) -> Path:
        if self.agent_runtime_dir is not None:
            return self.agent_runtime_dir.resolve()
        return self.runtime_dir / "agent-runs"

    @property
    def operation_staging_dir(self) -> Path:
        return self.runtime_dir / "operations"

    @classmethod
    def from_environment(cls) -> Settings:
        data_dir = Path(os.environ.get("RESEARCH_APP_DATA_DIR", BACKEND_ROOT / "data")).resolve()
        agent_runtime_value = os.environ.get("RESEARCH_APP_AGENT_RUNTIME_DIR", "").strip()
        if agent_runtime_value:
            agent_runtime_dir = Path(agent_runtime_value).resolve()
        else:
            local_state_root = os.environ.get("LOCALAPPDATA") or os.environ.get(
                "XDG_STATE_HOME"
            )
            if local_state_root:
                agent_runtime_dir = (
                    Path(local_state_root) / "HxaxdResearch" / "agent-runs"
                ).resolve()
            else:
                agent_runtime_dir = (
                    Path.home() / ".local" / "state" / "HxaxdResearch" / "agent-runs"
                ).resolve()
        codex_value = os.environ.get("HXAXD_CODEX_EXECUTABLE", "").strip()
        public_base_url = os.environ.get(
            "RESEARCH_APP_PUBLIC_URL", "http://127.0.0.1:8000"
        ).rstrip("/")
        public_host = urlsplit(public_base_url).hostname or "127.0.0.1"
        configured_hosts = tuple(
            host.strip()
            for host in os.environ.get("RESEARCH_APP_ALLOWED_HOSTS", "").split(",")
            if host.strip()
        )
        return cls(
            data_dir=data_dir,
            database_path=data_dir / "research.sqlite3",
            artifact_dir=data_dir / "artifacts",
            tools_dir=REPOSITORY_ROOT / ".tools",
            snapshot_dir=BACKEND_ROOT / "snapshots",
            frontend_origins=("http://127.0.0.1:5173", "http://localhost:5173"),
            agent_runtime_dir=agent_runtime_dir,
            public_base_url=public_base_url,
            agent_base_url=os.environ.get(
                "RESEARCH_APP_AGENT_URL", "http://127.0.0.1:8000"
            ).rstrip("/"),
            codex_executable=Path(codex_value).resolve() if codex_value else None,
            zotero_local_url=os.environ.get(
                "RESEARCH_ZOTERO_LOCAL_URL", "http://127.0.0.1:23119/api/"
            ),
            zotero_api_key=os.environ.get("RESEARCH_ZOTERO_API_KEY") or None,
            translation_api_base_url=os.environ.get(
                "RESEARCH_TRANSLATION_API_BASE_URL", "https://api.deepseek.com"
            ).rstrip("/"),
            translation_api_key=(
                os.environ.get("RESEARCH_TRANSLATION_API_KEY")
                or os.environ.get("PDF2ZH_DEEPSEEK_API_KEY")
                or os.environ.get("DEEPSEEK_API_KEY")
                or None
            ),
            translation_provider=os.environ.get(
                "RESEARCH_TRANSLATION_PROVIDER", "deepseek"
            ).strip(),
            translation_model=os.environ.get(
                "RESEARCH_TRANSLATION_MODEL", "deepseek-v4-flash"
            ).strip(),
            lan_access_enabled=os.environ.get("RESEARCH_APP_LAN_ACCESS", "").strip()
            in {"1", "true", "yes", "on"},
            device_session_days=int(
                os.environ.get("RESEARCH_APP_DEVICE_SESSION_DAYS", "90")
            ),
            device_cookie_secure=urlsplit(public_base_url).scheme == "https",
            allowed_hosts=tuple(
                dict.fromkeys(("127.0.0.1", "localhost", public_host, *configured_hosts))
            ),
        )

from __future__ import annotations

from pathlib import Path

from app.core.config import REPOSITORY_ROOT, Settings


def test_environment_settings_keep_agent_runtime_outside_repository(monkeypatch, tmp_path) -> None:
    local_app_data = tmp_path / "local-app-data"
    monkeypatch.setenv("LOCALAPPDATA", str(local_app_data))
    monkeypatch.delenv("RESEARCH_APP_AGENT_RUNTIME_DIR", raising=False)

    settings = Settings.from_environment()

    assert settings.agent_work_dir == (
        local_app_data / "HxaxdResearch" / "agent-runs"
    ).resolve()
    assert settings.agent_work_dir != REPOSITORY_ROOT
    assert REPOSITORY_ROOT not in settings.agent_work_dir.parents


def test_environment_settings_allow_explicit_agent_runtime(monkeypatch, tmp_path) -> None:
    configured = tmp_path / "dedicated-agent-runtime"
    monkeypatch.setenv("RESEARCH_APP_AGENT_RUNTIME_DIR", str(configured))

    settings = Settings.from_environment()

    assert settings.agent_work_dir == configured.resolve()


def test_direct_settings_keep_test_runtime_next_to_data(tmp_path) -> None:
    data_dir = (tmp_path / "data").resolve()
    settings = Settings(
        data_dir=data_dir,
        database_path=data_dir / "research.sqlite3",
        artifact_dir=data_dir / "artifacts",
        tools_dir=tmp_path / ".tools",
        snapshot_dir=tmp_path / "snapshots",
        frontend_origins=("http://testserver",),
    )

    assert settings.agent_work_dir == tmp_path / ".runtime" / "agent-runs"


def test_agent_runtime_path_is_normalized(monkeypatch, tmp_path) -> None:
    configured = tmp_path / "one" / ".." / "agent-runtime"
    monkeypatch.setenv("RESEARCH_APP_AGENT_RUNTIME_DIR", str(configured))

    settings = Settings.from_environment()

    assert settings.agent_work_dir == Path(configured).resolve()

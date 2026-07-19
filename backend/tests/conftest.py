from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture()
def app_settings(tmp_path):
    data_dir = (tmp_path / "data").resolve()
    return Settings(
        data_dir=data_dir,
        database_path=data_dir / "research.sqlite3",
        artifact_dir=data_dir / "artifacts",
        translate_script=tmp_path / "missing-translate-script.ps1",
        frontend_origins=("http://testserver",),
    )


@pytest.fixture()
def client(app_settings):
    with TestClient(create_app(app_settings)) as test_client:
        yield test_client

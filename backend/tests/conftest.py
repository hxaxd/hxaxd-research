"""Shared fixtures: isolated settings, app, and client per test."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        projects_root=tmp_path / "projects",
        dsh_base_url="http://127.0.0.1:3080",
        backend_port=8642,
        allowed_origins=["http://127.0.0.1:3080"],
    )


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)

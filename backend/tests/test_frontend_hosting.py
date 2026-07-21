from __future__ import annotations

from argparse import Namespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.__main__ import _is_loopback, _tls_files, _validate_agent_url
from app.core.frontend import mount_frontend


def test_built_frontend_serves_assets_and_spa_routes_without_path_escape(tmp_path) -> None:
    distribution = tmp_path / "dist"
    distribution.mkdir()
    (distribution / "index.html").write_text("<main>workspace shell</main>", "utf-8")
    (distribution / "asset.js").write_text("globalThis.ready = true", "utf-8")
    (distribution / "worker.mjs").write_text("export const ready = true", "utf-8")
    (tmp_path / "outside.txt").write_text("private data", "utf-8")
    application = FastAPI()
    mount_frontend(application, distribution)

    with TestClient(application) as client:
        assert "workspace shell" in client.get("/").text
        assert "workspace shell" in client.get("/projects/project-1").text
        assert client.get("/asset.js").text == "globalThis.ready = true"
        assert client.get("/worker.mjs").headers["content-type"].startswith(
            "application/javascript"
        )
        escaped = client.get("/%2E%2E/outside.txt")
        assert "private data" not in escaped.text


def test_lan_address_validation_rejects_loopback_names_and_addresses() -> None:
    assert _is_loopback("127.0.0.1") is True
    assert _is_loopback("::1") is True
    assert _is_loopback("localhost") is True
    assert _is_loopback("192.168.1.42") is False


def test_https_arguments_require_a_complete_existing_certificate_pair(tmp_path) -> None:
    certificate = tmp_path / "workspace.pem"
    private_key = tmp_path / "workspace-key.pem"
    certificate.write_text("certificate", encoding="utf-8")
    private_key.write_text("private key", encoding="utf-8")
    resolved = _tls_files(
        Namespace(ssl_certfile=str(certificate), ssl_keyfile=str(private_key))
    )
    assert resolved == (certificate.resolve(), private_key.resolve())
    with pytest.raises(SystemExit, match="必须同时提供"):
        _tls_files(Namespace(ssl_certfile=str(certificate), ssl_keyfile=None))
    with pytest.raises(SystemExit, match="必须是纯"):
        _validate_agent_url("https://workspace.test/private")

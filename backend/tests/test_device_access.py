from __future__ import annotations

import json
from contextlib import closing
from dataclasses import replace
from time import sleep
from urllib.request import Request, urlopen

from fastapi.testclient import TestClient

from app.__main__ import _reserve_loopback_socket, _start_internal_agent_listener
from app.core.config import Settings
from app.device_access.models import PairingCreate
from app.main import create_app


def _lan_settings(settings: Settings) -> Settings:
    return replace(
        settings,
        lan_access_enabled=True,
        public_base_url="https://workspace.test",
        device_cookie_secure=True,
        allowed_hosts=("workspace.test", "testserver", "127.0.0.1", "localhost"),
    )


def test_pairing_codes_can_only_be_created_locally(app_settings) -> None:
    with TestClient(create_app(_lan_settings(app_settings))) as local:
        created = local.post(
            "/api/device-access/pairings",
            json={"label": "Living room tablet", "ttl_seconds": 120},
        )
        assert created.status_code == 201, created.text
        assert len(created.json()["code"]) == 9
        assert created.json()["code"][4] == "-"


def test_secure_lan_keeps_the_embedded_agent_mcp_on_loopback(app_settings) -> None:
    listener = _reserve_loopback_socket()
    internal_port = int(listener.getsockname()[1])
    settings = replace(
        _lan_settings(app_settings),
        agent_base_url=f"http://127.0.0.1:{internal_port}",
    )
    application = create_app(settings)
    with TestClient(
        application,
        base_url="https://127.0.0.1:8000",
        client=("127.0.0.1", 51001),
    ) as local:
        del local
        server, thread = _start_internal_agent_listener(application, listener)
        for _ in range(100):
            if server.started:
                break
            sleep(0.01)
        registry = application.state.context.agent_capabilities
        token = registry.issue(
            "secure-lan-agent",
            project_id=None,
            scopes=frozenset({"literature:read"}),
        )
        payload = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "secure-lan-test", "version": "1"},
                },
            }
        ).encode("utf-8")
        try:
            request = Request(
                f"http://127.0.0.1:{internal_port}/mcp/",
                data=payload,
                method="POST",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json, text/event-stream",
                    "Content-Type": "application/json",
                },
            )
            with closing(urlopen(request, timeout=5)) as initialized:  # noqa: S310
                assert initialized.status == 200
                response = json.loads(initialized.read())
            assert response["result"]["serverInfo"]["name"] == "hxaxd-literature"
            assert application.state.context.settings.public_base_url == (
                "https://workspace.test"
            )
            assert application.state.context.settings.agent_base_url == (
                f"http://127.0.0.1:{internal_port}"
            )
        finally:
            server.should_exit = True
            thread.join(timeout=5)
            listener.close()


def test_remote_device_requires_one_time_pairing_and_revocable_cookie(app_settings) -> None:
    application = create_app(_lan_settings(app_settings))
    with TestClient(
        application,
        base_url="https://workspace.test",
        client=("192.168.1.42", 51000),
    ) as remote:
        status = remote.get("/api/device-access/status")
        assert status.status_code == 200
        assert status.json() == {
            "lan_enabled": True,
            "local_request": False,
            "authenticated": False,
            "pairing_required": True,
            "session_id": None,
            "cookie_secure": True,
        }
        assert remote.get("/api/workspace").status_code == 401
        assert remote.get("/openapi.json").status_code == 403
        assert remote.get("/docs").status_code == 403
        assert remote.post(
            "/api/device-access/pairings", json={"ttl_seconds": 600}
        ).status_code == 403

        ticket = application.state.context.device_access.create_pairing(
            PairingCreate(label="Tablet", ttl_seconds=600)
        )
        no_origin = remote.post(
            "/api/device-access/pair",
            json={"code": ticket.code, "label": "iPad"},
        )
        assert no_origin.status_code == 403
        paired = remote.post(
            "/api/device-access/pair",
            headers={"Origin": "https://workspace.test"},
            json={"code": ticket.code.lower().replace("-", " "), "label": "iPad"},
        )
        assert paired.status_code == 200, paired.text
        session_id = paired.json()["session"]["id"]
        cookie = paired.headers["set-cookie"]
        assert "HttpOnly" in cookie
        assert "SameSite=strict" in cookie
        assert "Secure" in cookie
        assert "hxaxd_device_session=" in cookie
        assert ticket.code not in cookie

        assert remote.get("/api/workspace").status_code == 200
        assert remote.get("/mcp").status_code == 403
        cross_site = remote.put(
            "/api/user-preferences",
            headers={"Origin": "https://attacker.test"},
            json={"expected_revision": 0, "reader": {}},
        )
        assert cross_site.status_code == 403
        sessions = remote.get("/api/device-access/sessions")
        assert sessions.status_code == 200
        assert sessions.json()[0]["current"] is True
        assert sessions.json()[0]["id"] == session_id

        revoked = remote.delete(
            f"/api/device-access/sessions/{session_id}",
            headers={"Origin": "https://workspace.test"},
        )
        assert revoked.status_code == 200, revoked.text
        assert revoked.json()["revoked_at"] is not None
        assert remote.get("/api/workspace").status_code == 401
        reused = remote.post(
            "/api/device-access/pair",
            headers={"Origin": "https://workspace.test"},
            json={"code": ticket.code, "label": "Second device"},
        )
        assert reused.status_code == 401

        with application.state.context.database.read() as connection:
            actions = {
                row["action"]
                for row in connection.execute(
                    "SELECT action FROM audit_events WHERE entity_id IN (?, ?)",
                    (ticket.id, session_id),
                )
            }
        assert {
            "device_pairing.created",
            "device_session.created",
            "device_session.revoked",
        } <= actions


def test_pairing_failures_are_rate_limited_without_logging_codes(app_settings) -> None:
    application = create_app(_lan_settings(app_settings))
    with TestClient(
        application,
        base_url="https://workspace.test",
        client=("192.168.1.88", 52000),
    ) as remote:
        responses = [
            remote.post(
                "/api/device-access/pair",
                headers={"Origin": "https://workspace.test"},
                json={"code": "WRONG-CODE", "label": "Unknown tablet"},
            )
            for _ in range(6)
        ]
        assert [response.status_code for response in responses] == [
            401,
            401,
            401,
            401,
            401,
            429,
        ]
        assert responses[-1].headers["retry-after"] == "60"
        with application.state.context.database.read() as connection:
            serialized = "\n".join(
                str(tuple(row)) for row in connection.execute("SELECT * FROM audit_events")
            )
        assert "WRONGCODE" not in serialized
        assert "WRONG-CODE" not in serialized

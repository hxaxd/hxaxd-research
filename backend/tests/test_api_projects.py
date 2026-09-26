"""HTTP API tests: project creation, listing, binding, reveal, CORS."""

from __future__ import annotations

import subprocess

import pytest
from fastapi.testclient import TestClient


def create_project(client: TestClient, name: str, request_id: str) -> dict:
    response = client.post(
        "/api/projects", json={"name": name, "requestId": request_id}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_create_project_returns_camel_case_contract(
    client: TestClient, settings
) -> None:
    project = create_project(client, "论文阅读", "req-1")

    assert set(project) == {
        "id",
        "name",
        "directory",
        "workspaceId",
        "createdAt",
        "updatedAt",
    }
    assert project["workspaceId"] is None
    assert project["directory"].startswith(str(settings.projects_root))


def test_repeated_submission_does_not_duplicate(client: TestClient) -> None:
    first = create_project(client, "论文阅读", "req-1")
    second = create_project(client, "论文阅读", "req-1")

    assert first["id"] == second["id"]
    assert first["directory"] == second["directory"]
    listed = client.get("/api/projects").json()["projects"]
    assert [item["id"] for item in listed] == [first["id"]]


def test_same_name_projects_are_independent(client: TestClient) -> None:
    first = create_project(client, "同名项目", "req-1")
    second = create_project(client, "同名项目", "req-2")

    assert first["id"] != second["id"]
    assert first["directory"] != second["directory"]


def test_bind_workspace_and_read_project(client: TestClient) -> None:
    project = create_project(client, "论文阅读", "req-1")
    workspace_id = "3f2a1b4c-1111-2222-3333-444455556666"

    bound = client.patch(
        f"/api/projects/{project['id']}/workspace",
        json={"workspaceId": workspace_id},
    )
    assert bound.status_code == 200, bound.text
    assert bound.json()["workspaceId"] == workspace_id

    read = client.get(f"/api/projects/{project['id']}")
    assert read.json()["workspaceId"] == workspace_id


def test_bind_workspace_rejections(client: TestClient) -> None:
    project = create_project(client, "论文阅读", "req-1")
    workspace_id = "3f2a1b4c-1111-2222-3333-444455556666"

    assert (
        client.patch(
            f"/api/projects/{project['id']}/workspace",
            json={"workspaceId": "not-a-uuid"},
        ).status_code
        == 422
    )
    assert client.patch(
        "/api/projects/missing/workspace", json={"workspaceId": workspace_id}
    ).status_code == 404

    assert client.patch(
        f"/api/projects/{project['id']}/workspace",
        json={"workspaceId": workspace_id},
    ).status_code == 200
    assert (
        client.patch(
            f"/api/projects/{project['id']}/workspace",
            json={"workspaceId": "aaaaaaaa-1111-2222-3333-444455556666"},
        ).status_code
        == 422
    )


def test_invalid_requests_fail_cleanly(client: TestClient) -> None:
    assert (
        client.post("/api/projects", json={"name": " ", "requestId": "req-1"}).status_code
        == 422
    )
    assert (
        client.post("/api/projects", json={"name": "x", "requestId": ""}).status_code
        == 422
    )
    assert client.get("/api/projects/missing").status_code == 404


def test_reveal_opens_the_registered_directory(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = create_project(client, "论文阅读", "req-1")
    calls: list[list[str]] = []

    def fake_run(command: list[str], **_: object) -> None:
        calls.append(command)

    monkeypatch.setattr(subprocess, "run", fake_run)

    assert client.post(f"/api/projects/{project['id']}/reveal").status_code == 204
    assert calls and calls[0][0] in ("open", "xdg-open") and calls[0][1] == project[
        "directory"
    ]

    assert client.post("/api/projects/missing/reveal").status_code == 404


def test_cors_allows_configured_dsh_origin(client: TestClient) -> None:
    response = client.options(
        "/api/projects",
        headers={
            "Origin": "http://127.0.0.1:3080",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:3080"


def test_health(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}

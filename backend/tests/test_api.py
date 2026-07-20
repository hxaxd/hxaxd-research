from __future__ import annotations

import os
import time

from tests.sample_data import PAPER, PDF


def test_create_projects_and_papers(client):
    project = client.post(
        "/api/projects",
        json={"name": "测试领域", "description": "端到端测试"},
    ).json()

    response = client.post(f"/api/projects/{project['id']}/papers/batch", json={"papers": [PAPER]})
    assert response.status_code == 201, response.text
    assert response.json()["created"][0]["title_zh"] == PAPER["title_zh"]

    projects = client.get("/api/projects").json()
    assert projects[0]["paper_count"] == 1


def test_batch_is_atomic_on_duplicate_key(client):
    project = client.post(
        "/api/projects",
        json={"name": "测试领域"},
    ).json()

    response = client.post(
        f"/api/projects/{project['id']}/papers/batch",
        json={"papers": [PAPER, PAPER]},
    )
    assert response.status_code == 409
    assert client.get(f"/api/projects/{project['id']}/papers").json() == []


def test_paper_schema_and_pdf_artifacts(client):
    schema = client.get("/api/schema/paper")
    assert schema.status_code == 200
    assert "selection_reason" in schema.json()["properties"]

    project = client.post(
        "/api/projects",
        json={"name": "测试领域"},
    ).json()
    paper = client.post(
        f"/api/projects/{project['id']}/papers/batch", json={"papers": [PAPER]}
    ).json()["created"][0]

    for kind in ("original", "chinese", "bilingual"):
        upload = client.post(
            f"/api/papers/{paper['id']}/artifacts/{kind}",
            files={"upload": (f"{kind}.pdf", PDF, "application/pdf")},
        )
        assert upload.status_code == 201, upload.text
        assert upload.json()["kind"] == kind

    artifacts = client.get(f"/api/papers/{paper['id']}/artifacts").json()
    assert {artifact["kind"] for artifact in artifacts} == {
        "original",
        "chinese",
        "bilingual",
    }
    for kind in ("original", "chinese", "bilingual"):
        response = client.get(f"/api/papers/{paper['id']}/artifacts/{kind}")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"


def test_translation_requires_original_pdf(client):
    project = client.post(
        "/api/projects",
        json={"name": "测试领域"},
    ).json()
    paper = client.post(
        f"/api/projects/{project['id']}/papers/batch", json={"papers": [PAPER]}
    ).json()["created"][0]

    response = client.post(f"/api/papers/{paper['id']}/translate", json={})
    assert response.status_code == 404


def test_workspace_returns_projects_papers_and_resources(client):
    project = client.post("/api/projects", json={"name": "测试领域"}).json()
    paper = client.post(
        f"/api/projects/{project['id']}/papers/batch",
        json={"papers": [PAPER]},
    ).json()["created"][0]
    client.post(
        f"/api/papers/{paper['id']}/artifacts/original",
        files={"upload": ("paper.pdf", PDF, "application/pdf")},
    )

    response = client.get("/api/workspace")

    assert response.status_code == 200
    state = response.json()
    assert state["projects"][0]["name"] == "测试领域"
    assert state["projects"][0]["status_counts"] == {PAPER["status"]: 1}
    assert state["projects"][0]["papers"][0]["artifacts"][0]["kind"] == "original"
    assert {tool["name"] for tool in state["tools"]} == {"pdf2zh", "tex"}


def test_tools_use_the_managed_directory(client, app_settings):
    missing = client.get("/api/tools").json()
    assert {tool["status"] for tool in missing} == {"missing"}
    assert all(tool["install_path"].startswith(str(app_settings.tools_dir)) for tool in missing)

    executable = (
        app_settings.tex_dir / "texlive" / "bin" / "windows" / "latexmk.exe"
        if os.name == "nt"
        else app_settings.tex_dir / "texlive" / "bin" / "x86_64-linux" / "latexmk"
    )
    executable.parent.mkdir(parents=True)
    executable.touch()

    response = client.post("/api/tools/tex/install")
    assert response.status_code == 202
    assert response.json()["status"] == "installed"
    assert response.json()["executable_path"] == str(executable)


def test_snapshot_api_creates_downloads_and_restores(client):
    project = client.post("/api/projects", json={"name": "备份测试"}).json()

    started = client.post("/api/snapshots")
    assert started.status_code == 202
    overview = _wait_for_snapshot_operation(client)
    assert overview["operation"]["status"] == "succeeded"
    snapshot = overview["snapshots"][0]

    download = client.get(snapshot["download_url"])
    assert download.status_code == 200
    assert download.content.startswith(b"PK")

    client.post("/api/projects", json={"name": "恢复后应消失"})
    rejected = client.post(
        f"/api/snapshots/{snapshot['filename']}/restore",
        json={"confirmation": "错误确认"},
    )
    assert rejected.status_code == 400

    restored = client.post(
        f"/api/snapshots/{snapshot['filename']}/restore",
        json={"confirmation": snapshot["filename"]},
    )
    assert restored.status_code == 202
    overview = _wait_for_snapshot_operation(client)
    assert overview["operation"]["status"] == "succeeded"
    projects = client.get("/api/projects").json()
    assert [item["id"] for item in projects] == [project["id"]]


def _wait_for_snapshot_operation(client) -> dict:
    for _ in range(200):
        overview = client.get("/api/snapshots").json()
        if overview["operation"]["status"] != "running":
            return overview
        time.sleep(0.01)
    raise AssertionError("snapshot operation did not finish")

from __future__ import annotations

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

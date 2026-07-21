from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.catalog.api import router as catalog_router
from app.platform.db import WorkspaceDatabase
from app.screening.api import router as screening_router
from app.screening.commands import ScreeningCommands
from app.screening.domain import ScreeningConflictError
from app.screening.models import ProjectWorkDecision


def _client(tmp_path) -> tuple[TestClient, WorkspaceDatabase]:
    database = WorkspaceDatabase(tmp_path / "research.sqlite3")
    database.initialize()
    app = FastAPI()
    app.state.workspace_database = database
    app.include_router(catalog_router, prefix="/api")
    app.include_router(screening_router, prefix="/api")
    return TestClient(app), database


CANDIDATE = {
    "item": {
        "item_type": "preprint",
        "title": "A Staged Candidate",
        "translated_title": "一个候选文献",
        "issued_year": 2026,
        "publication_state": "preprint",
        "creators": [
            {
                "creator_type": "literal",
                "literal_name": "Ada Example",
                "raw_name": "Ada Example",
            }
        ],
        "identifiers": [
            {
                "scheme": "doi",
                "value": "https://doi.org/10.0000/CANDIDATE",
                "is_primary": True,
            }
        ],
        "links": [
            {
                "relation_type": "paper",
                "url": "https://example.com/candidate",
            }
        ],
    },
    "source_provider": "test-index",
    "source_external_key": "candidate-1",
    "raw_payload": {"source": "fixture"},
    "rank": 1,
    "rationale": "relevant",
}


def test_candidate_is_staged_then_promoted_and_explicitly_decided(tmp_path):
    client, database = _client(tmp_path)
    project = client.post(
        "/api/projects", json={"name": "Agent Research", "description": "scope"}
    ).json()

    staged = client.post(f"/api/projects/{project['id']}/candidates", json=CANDIDATE)
    assert staged.status_code == 201, staged.text
    candidate = staged.json()
    assert candidate["state"] == "staged"
    assert client.get(f"/api/projects/{project['id']}/works").json() == []

    promoted = client.post(
        f"/api/projects/{project['id']}/candidates/{candidate['id']}/promote",
        json={},
    )
    assert promoted.status_code == 200, promoted.text
    membership = promoted.json()
    assert membership["status"] == "discovered"
    assert membership["title"] == "A Staged Candidate"

    works = client.get("/api/works").json()
    assert works["total"] == 1
    item = works["items"][0]["items"][0]
    assert item["identifiers"][0]["normalized_value"] == "10.0000/candidate"
    assert item["creators"][0]["raw_name"] == "Ada Example"

    rejected = client.patch(
        f"/api/projects/{project['id']}/works/{membership['work_id']}",
        json={"status": "included"},
    )
    assert rejected.status_code == 409
    included = client.patch(
        f"/api/projects/{project['id']}/works/{membership['work_id']}",
        json={
            "status": "included",
            "relevance": "directly addresses the project",
            "roles": ["method"],
            "contributions": ["a contribution"],
            "reading_focus": ["evaluation"],
        },
    )
    assert included.status_code == 200, included.text
    assert included.json()["status"] == "included"

    commands = ScreeningCommands(database)
    try:
        commands.decide_project_work(
            project["id"],
            membership["work_id"],
            ProjectWorkDecision(status="excluded"),
            actor_type="agent",
        )
    except ScreeningConflictError:
        pass
    else:
        raise AssertionError("agent must not change a user screening decision")


def test_identifier_match_is_visible_before_candidate_promotion(tmp_path):
    client, _ = _client(tmp_path)
    project = client.post("/api/projects", json={"name": "One"}).json()
    first = client.post(f"/api/projects/{project['id']}/candidates", json=CANDIDATE).json()
    promoted = client.post(
        f"/api/projects/{project['id']}/candidates/{first['id']}/promote", json={}
    ).json()

    other_project = client.post("/api/projects", json={"name": "Two"}).json()
    matched = client.post(f"/api/projects/{other_project['id']}/candidates", json=CANDIDATE)
    assert matched.status_code == 201, matched.text
    payload = matched.json()
    assert payload["state"] == "matched"
    assert payload["matched_work_id"] == promoted["work_id"]
    assert payload["matched_item"]["id"] == promoted["preferred_item_id"]
    assert payload["matched_item"]["title"] == CANDIDATE["item"]["title"]
    assert payload["matched_item"]["identifiers"][0]["normalized_value"] == ("10.0000/candidate")

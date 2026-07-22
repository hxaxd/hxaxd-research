from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agents.models import AgentRunCreate, AgentRunStatus
from app.agents.repository import SqliteAgentRunRepository
from app.catalog.api import router as catalog_router
from app.platform.db import WorkspaceDatabase
from app.screening.api import router as screening_router
from app.screening.commands import ScreeningCommands
from app.screening.domain import ScreeningConflictError
from app.screening.models import (
    CandidateCreate,
    CandidatePromotionRequest,
    ProjectCreate,
    ProjectWorkDecision,
)
from app.screening.queries import ScreeningQueries


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


def test_candidate_rank_is_a_one_based_source_position(tmp_path):
    client, _ = _client(tmp_path)
    project = client.post("/api/projects", json={"name": "Rank semantics"}).json()
    payload = deepcopy(CANDIDATE)
    payload["rank"] = 0.9

    response = client.post(f"/api/projects/{project['id']}/candidates", json=payload)

    assert response.status_code == 422
    assert client.get(f"/api/projects/{project['id']}/candidates").json()["total"] == 0


def test_candidate_is_staged_then_promoted_and_explicitly_decided(tmp_path):
    client, database = _client(tmp_path)
    project = client.post(
        "/api/projects", json={"name": "Agent Research", "description": "scope"}
    ).json()

    staged = client.post(f"/api/projects/{project['id']}/candidates", json=CANDIDATE)
    assert staged.status_code == 201, staged.text
    candidate = staged.json()
    assert candidate["state"] == "staged"
    assert client.get(f"/api/projects/{project['id']}/items").json() == {
        "items": [],
        "total": 0,
        "limit": 100,
        "offset": 0,
    }

    membership = ScreeningCommands(database).promote_candidate(
        project["id"], candidate["id"], CandidatePromotionRequest()
    ).model_dump(mode="json")
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
    client, database = _client(tmp_path)
    project = client.post("/api/projects", json={"name": "One"}).json()
    first = client.post(f"/api/projects/{project['id']}/candidates", json=CANDIDATE).json()
    promoted = ScreeningCommands(database).promote_candidate(
        project["id"], first["id"], CandidatePromotionRequest()
    ).model_dump(mode="json")

    other_project = client.post("/api/projects", json={"name": "Two"}).json()
    matched = client.post(f"/api/projects/{other_project['id']}/candidates", json=CANDIDATE)
    assert matched.status_code == 201, matched.text
    payload = matched.json()
    assert payload["state"] == "matched"
    assert payload["matched_work_id"] == promoted["work_id"]
    assert payload["matched_item"]["id"] == promoted["preferred_item_id"]
    assert payload["matched_item"]["title"] == CANDIDATE["item"]["title"]
    assert payload["matched_item"]["identifiers"][0]["normalized_value"] == ("10.0000/candidate")


def test_candidate_and_project_item_pages_are_counted_filtered_and_idempotent(tmp_path):
    client, database = _client(tmp_path)
    project = client.post("/api/projects", json={"name": "Paged"}).json()

    first = client.post(f"/api/projects/{project['id']}/candidates", json=CANDIDATE).json()
    replay = client.post(f"/api/projects/{project['id']}/candidates", json=CANDIDATE).json()
    assert replay["id"] == first["id"]
    assert client.get(f"/api/projects/{project['id']}").json()["candidate_count"] == 1

    second_payload = deepcopy(CANDIDATE)
    second_payload["item"]["title"] = "A Second Candidate"
    second_payload["item"]["identifiers"][0]["value"] = "10.0000/second"
    second_payload["source_external_key"] = "candidate-2"
    second = client.post(
        f"/api/projects/{project['id']}/candidates", json=second_payload
    ).json()

    first_page = client.get(
        f"/api/projects/{project['id']}/candidates?state=staged&limit=1&offset=0"
    ).json()
    second_page = client.get(
        f"/api/projects/{project['id']}/candidates?state=staged&limit=1&offset=1"
    ).json()
    assert (first_page["total"], first_page["limit"], first_page["offset"]) == (2, 1, 0)
    assert len(first_page["items"]) == len(second_page["items"]) == 1
    assert first_page["items"][0]["id"] != second_page["items"][0]["id"]

    ScreeningCommands(database).dismiss_candidate(project["id"], second["id"])
    dismissed = client.get(
        f"/api/projects/{project['id']}/candidates?state=dismissed"
    ).json()
    assert dismissed["total"] == 1
    assert dismissed["items"][0]["id"] == second["id"]
    assert client.get(f"/api/projects/{project['id']}").json()["candidate_count"] == 1

    ScreeningCommands(database).promote_candidate(
        project["id"], first["id"], CandidatePromotionRequest()
    )
    items = client.get(f"/api/projects/{project['id']}/items?limit=1").json()
    assert (items["total"], items["limit"], items["offset"]) == (1, 1, 0)
    assert len(items["items"]) == 1


def test_agent_candidate_staging_owns_a_finished_discovery_session(tmp_path):
    _, database = _client(tmp_path)
    commands = ScreeningCommands(database)
    project = commands.create_project(ProjectCreate(name="Agent discovery"))
    run_repository = SqliteAgentRunRepository(database.path)
    run_repository.initialize_schema()
    run = run_repository.create(
        AgentRunCreate(
            id="discovery-run",
            task_kind="literature_search",
            goal="寻找文献",
            prompt="寻找文献",
            prompt_version="test",
            context_hash="context",
            cwd=str(tmp_path),
            project_id=project.id,
            tool_scopes=("catalog.read", "screening.candidate.stage"),
            runtime="test",
        )
    )

    candidate = commands.stage_candidate(
        project.id,
        CandidateCreate.model_validate(CANDIDATE),
        actor_type="agent",
        actor_id=run.id,
        correlation_id=run.id,
    )
    assert candidate.discovery_session_id is not None
    assert commands.finish_discovery_sessions(run.id, "succeeded") == 1
    with database.read() as connection:
        session = connection.execute(
            "SELECT * FROM discovery_sessions WHERE id = ?",
            (candidate.discovery_session_id,),
        ).fetchone()
    assert session["agent_run_id"] == run.id
    assert session["status"] == "succeeded"
    assert session["finished_at"] is not None

    with database.transaction() as connection:
        connection.execute(
            "UPDATE discovery_sessions SET status = 'running', finished_at = NULL WHERE id = ?",
            (candidate.discovery_session_id,),
        )
    run_repository.transition(run.id, AgentRunStatus.STARTING)
    run_repository.transition(run.id, AgentRunStatus.RUNNING)
    run_repository.transition(run.id, AgentRunStatus.COMPLETED)
    assert commands.reconcile_discovery_sessions() == 1
    with database.read() as connection:
        status = connection.execute(
            "SELECT status FROM discovery_sessions WHERE id = ?",
            (candidate.discovery_session_id,),
        ).fetchone()["status"]
    assert status == "succeeded"


def test_concurrent_candidate_staging_converges_on_one_active_record(tmp_path):
    _, database = _client(tmp_path)
    project = ScreeningCommands(database).create_project(ProjectCreate(name="Concurrent"))
    payload = CandidateCreate.model_validate(CANDIDATE)

    def stage(_: int) -> str:
        return ScreeningCommands(database).stage_candidate(project.id, payload).id

    with ThreadPoolExecutor(max_workers=4) as pool:
        candidate_ids = set(pool.map(stage, range(8)))

    assert len(candidate_ids) == 1
    page = ScreeningQueries(database).list_candidates(project.id)
    assert page.total == 1
    assert page.items[0].id in candidate_ids

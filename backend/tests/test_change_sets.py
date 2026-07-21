from __future__ import annotations

from app.changes.repository import ChangeSetRepository
from tests.test_api_v3 import _candidate


def _indexed_item(client):
    project = client.post("/api/projects", json={"name": "Changes"}).json()
    candidate = client.post(f"/api/projects/{project['id']}/candidates", json=_candidate()).json()
    membership = client.post(
        f"/api/projects/{project['id']}/candidates/{candidate['id']}/promote",
        json={},
    ).json()
    item = client.get(f"/api/items/{membership['preferred_item_id']}").json()
    return project, membership, item


def _add_indexed_item(client, project_id: str, title: str, suffix: str):
    payload = _candidate(title)
    payload["item"]["identifiers"][0]["value"] = f"10.0000/{suffix}"
    payload["source_external_key"] = f"10.0000/{suffix}"
    candidate = client.post(f"/api/projects/{project_id}/candidates", json=payload).json()
    membership = client.post(
        f"/api/projects/{project_id}/candidates/{candidate['id']}/promote",
        json={},
    ).json()
    return client.get(f"/api/items/{membership['preferred_item_id']}").json()


def _approve(client, change_set):
    result = client.post(
        f"/api/change-sets/{change_set['id']}/review",
        json={
            "expected_content_hash": change_set["content_hash"],
            "decisions": [
                {
                    "change_item_id": change_set["items"][0]["id"],
                    "decision": "approve",
                }
            ],
        },
    )
    assert result.status_code == 200, result.text
    return result.json()


def _apply(client, change_set):
    return client.post(
        f"/api/change-sets/{change_set['id']}/apply",
        json={"expected_content_hash": change_set["content_hash"]},
    )


def test_metadata_change_requires_review_and_records_revision(client):
    project, _, item = _indexed_item(client)
    proposed = client.post(
        "/api/change-sets",
        json={
            "kind": "metadata_patch",
            "summary": "Use the publisher title.",
            "project_id": project["id"],
            "item_id": item["id"],
            "source_version": "crossref-2026-07",
            "items": [
                {
                    "operation": "metadata.patch",
                    "target_id": item["id"],
                    "base_revision": item["revision"],
                    "payload": {"patch": {"title": "A Corrected Title"}},
                    "evidence": [
                        {
                            "source": "publisher",
                            "url": "https://example.org/record",
                            "locator": "title",
                        }
                    ],
                    "rationale": "Publisher metadata is authoritative.",
                }
            ],
        },
    )
    assert proposed.status_code == 201, proposed.text
    change_set = proposed.json()
    assert change_set["status"] == "submitted"
    assert client.get(f"/api/items/{item['id']}").json()["title"] != "A Corrected Title"
    reopened = ChangeSetRepository(client.app.state.context.database).get(change_set["id"])
    assert reopened.status.value == "submitted"
    assert reopened.items[0].evidence[0].source == "publisher"

    rejected_apply = _apply(client, change_set)
    assert rejected_apply.status_code == 409
    reviewed = _approve(client, change_set)
    assert reviewed["items"][0]["status"] == "approved"

    applied = _apply(client, reviewed)
    assert applied.status_code == 200, applied.text
    result = applied.json()
    assert result["status"] == "applied", result["items"][0]["error_message"]
    assert result["items"][0]["result"] == {"item_id": item["id"], "revision": 2}
    current = client.get(f"/api/items/{item['id']}").json()
    assert (current["title"], current["revision"]) == ("A Corrected Title", 2)

    replay = _apply(client, result)
    assert replay.status_code == 200
    assert replay.json()["items"][0]["result"]["revision"] == 2
    with client.app.state.context.database.read() as connection:
        revisions = connection.execute(
            """
            SELECT revision, change_set_id FROM item_revisions
            WHERE item_id = ? ORDER BY revision
            """,
            (item["id"],),
        ).fetchall()
        reviews = connection.execute(
            "SELECT COUNT(*) FROM audit_events WHERE action = 'changes.reviewed'"
        ).fetchone()[0]
    assert [(row["revision"], row["change_set_id"]) for row in revisions] == [
        (1, None),
        (2, result["id"]),
    ]
    assert reviews == 1


def test_stale_metadata_change_is_not_applied(client):
    project, _, item = _indexed_item(client)

    def proposal(title: str):
        response = client.post(
            "/api/change-sets",
            json={
                "kind": "metadata_patch",
                "summary": title,
                "project_id": project["id"],
                "item_id": item["id"],
                "items": [
                    {
                        "operation": "metadata.patch",
                        "target_id": item["id"],
                        "base_revision": 1,
                        "payload": {"patch": {"title": title}},
                    }
                ],
            },
        )
        assert response.status_code == 201, response.text
        return _approve(client, response.json())

    first = proposal("First")
    second = proposal("Second")
    first_result = _apply(client, first).json()
    assert first_result["status"] == "applied", first_result

    stale = _apply(client, second)
    assert stale.status_code == 200
    assert stale.json()["status"] == "stale"
    assert stale.json()["items"][0]["error_code"] == "stale_target"
    assert client.get(f"/api/items/{item['id']}").json()["title"] == "First"


def test_project_insight_change_cannot_modify_screening_status(client):
    project, membership, _ = _indexed_item(client)
    proposed = client.post(
        "/api/change-sets",
        json={
            "kind": "project_insights",
            "summary": "Summarize the paper for this project.",
            "project_id": project["id"],
            "items": [
                {
                    "operation": "project.insight.patch",
                    "target_id": membership["id"],
                    "base_revision": membership["updated_at"],
                    "payload": {
                        "project_id": project["id"],
                        "work_id": membership["work_id"],
                        "base_updated_at": membership["updated_at"],
                        "patch": {
                            "summary": "A concise project-specific summary.",
                            "roles": ["method"],
                            "reading_focus": ["evaluation"],
                        },
                    },
                }
            ],
        },
    )
    assert proposed.status_code == 201, proposed.text
    reviewed = _approve(client, proposed.json())
    applied = _apply(client, reviewed)
    assert applied.status_code == 200, applied.text
    current = client.get(f"/api/projects/{project['id']}/works?limit=10").json()[0]
    assert current["status"] == "discovered"
    assert current["summary"] == "A concise project-specific summary."
    assert current["roles"] == ["method"]


def test_approved_resource_proposal_enqueues_one_idempotent_job(client):
    client.app.state.context.job_worker.stop()
    project, _, item = _indexed_item(client)
    proposed = client.post(
        "/api/change-sets",
        json={
            "kind": "resource_acquisition",
            "summary": "Acquire the publisher PDF.",
            "project_id": project["id"],
            "item_id": item["id"],
            "items": [
                {
                    "operation": "resource.acquire",
                    "target_id": item["id"],
                    "base_revision": item["revision"],
                    "payload": {
                        "request": {
                            "url": "https://example.invalid/paper.pdf",
                            "filename": "paper.pdf",
                            "origin": "publisher",
                            "preferred_for": ["reading"],
                        }
                    },
                    "evidence": [
                        {
                            "source": "publisher",
                            "url": "https://example.invalid/paper.pdf",
                        }
                    ],
                }
            ],
        },
    )
    assert proposed.status_code == 201, proposed.text
    reviewed = _approve(client, proposed.json())
    applied = _apply(client, reviewed)
    assert applied.status_code == 200, applied.text
    result = applied.json()
    assert result["status"] == "applied"
    job_id = result["items"][0]["result"]["job_id"]
    assert result["items"][0]["result"]["job_status"] == "queued"

    replay = _apply(client, result)
    assert replay.json()["items"][0]["result"]["job_id"] == job_id
    with client.app.state.context.database.read() as connection:
        jobs = connection.execute(
            "SELECT id FROM jobs WHERE idempotency_key = ?",
            (f"change-item:{result['items'][0]['id']}",),
        ).fetchall()
    assert [row["id"] for row in jobs] == [job_id]


def test_resource_enqueue_failure_remains_reviewable_and_explainable(client, monkeypatch):
    client.app.state.context.job_worker.stop()
    project, _, item = _indexed_item(client)
    proposed = client.post(
        "/api/change-sets",
        json={
            "kind": "resource_acquisition",
            "summary": "Acquire a verified PDF.",
            "project_id": project["id"],
            "item_id": item["id"],
            "items": [
                {
                    "operation": "resource.acquire",
                    "target_id": item["id"],
                    "base_revision": item["revision"],
                    "payload": {
                        "request": {
                            "url": "https://example.invalid/failure.pdf",
                            "filename": "failure.pdf",
                            "origin": "publisher",
                        }
                    },
                }
            ],
        },
    ).json()
    reviewed = _approve(client, proposed)

    def fail_enqueue(*_args, **_kwargs):
        raise RuntimeError("job queue unavailable")

    monkeypatch.setattr(
        client.app.state.context.changes.operations,
        "download_attachment",
        fail_enqueue,
    )
    failed = _apply(client, reviewed)
    assert failed.status_code == 200, failed.text
    result = failed.json()
    assert result["status"] == "failed"
    assert result["items"][0]["status"] == "failed"
    assert result["items"][0]["error_code"] == "apply_failed"
    assert "job queue unavailable" in result["items"][0]["error_message"]
    assert client.get(f"/api/change-sets/{result['id']}").json() == result


def test_selected_database_changes_rollback_together_and_omit_is_rejected(client, monkeypatch):
    project, _, first = _indexed_item(client)
    second = _add_indexed_item(client, project["id"], "Second item", "second")
    omitted = _add_indexed_item(client, project["id"], "Omitted item", "omitted")
    items = [first, second, omitted]
    proposed = client.post(
        "/api/change-sets",
        json={
            "kind": "metadata_patch",
            "summary": "Apply the selected title corrections together.",
            "project_id": project["id"],
            "items": [
                {
                    "operation": "metadata.patch",
                    "target_id": item["id"],
                    "base_revision": item["revision"],
                    "payload": {"patch": {"title": f"Corrected {index}"}},
                }
                for index, item in enumerate(items, start=1)
            ],
        },
    )
    assert proposed.status_code == 201, proposed.text
    change_set = proposed.json()
    reviewed = client.post(
        f"/api/change-sets/{change_set['id']}/review",
        json={
            "expected_content_hash": change_set["content_hash"],
            "decisions": [
                {"change_item_id": entry["id"], "decision": "approve"}
                for entry in change_set["items"][:2]
            ],
        },
    ).json()

    commands = client.app.state.context.changes.catalog_commands
    apply_original = commands.apply_metadata_patch
    calls = 0

    def fail_second(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("injected second item failure")
        return apply_original(*args, **kwargs)

    monkeypatch.setattr(commands, "apply_metadata_patch", fail_second)
    applied = _apply(client, reviewed)
    assert applied.status_code == 200, applied.text
    result = applied.json()
    assert result["status"] == "failed"
    assert [entry["status"] for entry in result["items"]] == [
        "failed",
        "failed",
        "rejected",
    ]
    assert {entry["error_code"] for entry in result["items"][:2]} == {"atomic_apply_aborted"}
    assert calls == 2

    current = [client.get(f"/api/items/{item['id']}").json() for item in items]
    assert [(item["title"], item["revision"]) for item in current] == [
        (first["title"], 1),
        (second["title"], 1),
        (omitted["title"], 1),
    ]
    with client.app.state.context.database.read() as connection:
        revisions = connection.execute(
            "SELECT item_id, COUNT(*) AS count FROM item_revisions GROUP BY item_id"
        ).fetchall()
    assert {row["item_id"]: row["count"] for row in revisions} == {
        first["id"]: 1,
        second["id"]: 1,
        omitted["id"]: 1,
    }

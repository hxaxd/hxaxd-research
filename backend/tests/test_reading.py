from __future__ import annotations

from time import monotonic, sleep

from app.documents.models import BlockKind, ExtractedBlock, ExtractedDocument
from app.reading.repository import ReadingRepository

from .sample_data import PDF


class _ReadingExtractor:
    name = "reading-test-layout"
    version = "1.0"
    structure_version = "semantic-blocks-v1"
    ready = True

    def extract(self, _path, *, ocr_mode, callbacks):
        callbacks.emit("reading-test.extract", {"ocr_mode": ocr_mode.value}, "info")
        return ExtractedDocument(
            language="en",
            page_count=2,
            blocks=[
                ExtractedBlock(
                    kind=BlockKind.HEADING,
                    source_text="1 Method",
                    page_start=1,
                    page_end=1,
                    anchor={"page": 1, "bbox": {"x": 10, "y": 700}},
                    section_path=["1 Method"],
                ),
                ExtractedBlock(
                    kind=BlockKind.PARAGRAPH,
                    source_text="The semantic reader keeps a stable paragraph anchor.",
                    page_start=2,
                    page_end=2,
                    anchor={"page": 2, "bbox": {"x": 10, "y": 640}},
                    section_path=["1 Method"],
                ),
            ],
        )


def _included_item(client, title: str) -> tuple[str, str]:
    project = client.post(
        "/api/projects", json={"name": title, "description": "Reader fixture"}
    ).json()
    candidate = client.post(
        f"/api/projects/{project['id']}/candidates",
        json={
            "item": {"title": title, "language": "en"},
            "source_provider": "manual",
            "raw_payload": {"fixture": True},
        },
    ).json()
    decision = client.post(
        f"/api/projects/{project['id']}/candidate-decisions",
        json={
            "decisions": [
                {
                    "candidate_id": candidate["id"],
                    "decision": "include",
                    "reason": "Reader fixture",
                }
            ]
        },
    ).json()[0]
    return project["id"], decision["project_item"]["preferred_item_id"]


def _wait_for_job(client, job_id: str) -> dict:
    deadline = monotonic() + 5
    while monotonic() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in {"succeeded", "failed", "canceled"}:
            return job
        sleep(0.02)
    raise AssertionError(f"job did not finish: {job_id}")


def _document_fixture(client, title: str) -> dict:
    project_id, item_id = _included_item(client, title)
    upload = client.post(
        f"/api/items/{item_id}/attachments",
        files={"upload": ("paper.pdf", PDF, "application/pdf")},
    )
    assert upload.status_code == 201, upload.text
    client.app.state.context.documents.extractor = _ReadingExtractor()
    launched = client.post(
        f"/api/attachments/{upload.json()['id']}/documents",
        json={"ocr_mode": "auto"},
    )
    assert launched.status_code == 202, launched.text
    assert _wait_for_job(client, launched.json()["id"])["status"] == "succeeded"
    document = client.get(f"/api/items/{item_id}/documents").json()[0]
    blocks = client.get(f"/api/documents/{document['id']}/blocks").json()["items"]
    return {
        "project_id": project_id,
        "item_id": item_id,
        "attachment_id": upload.json()["id"],
        "document": document,
        "blocks": blocks,
    }


def test_annotations_derive_stable_anchor_and_enforce_optimistic_updates(client) -> None:
    fixture = _document_fixture(client, "Anchored annotation")
    block = fixture["blocks"][1]
    created = client.post(
        f"/api/projects/{fixture['project_id']}/items/{fixture['item_id']}/annotations",
        json={
            "block_id": block["id"],
            "kind": "method",
            "body": "  Preserve the method detail.  ",
            "tags": [" Method ", "Evidence"],
        },
    )
    assert created.status_code == 201, created.text
    annotation = created.json()
    assert annotation["body"] == "Preserve the method detail."
    assert annotation["quoted_text"] == block["source_text"]
    assert annotation["attachment_id"] == fixture["attachment_id"]
    assert annotation["source_sha256"] == fixture["document"]["source_sha256"]
    assert annotation["page_number"] == 2
    assert annotation["anchor"] == block["anchor"]
    assert annotation["tags"] == ["method", "evidence"]

    updated = client.put(
        f"/api/annotations/{annotation['id']}",
        json={
            "expected_updated_at": annotation["updated_at"],
            "kind": "result",
            "body": "Updated note",
            "tags": ["result"],
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["kind"] == "result"
    stale = client.put(
        f"/api/annotations/{annotation['id']}",
        json={
            "expected_updated_at": annotation["updated_at"],
            "kind": "question",
            "body": "Stale write",
            "tags": [],
        },
    )
    assert stale.status_code == 409
    stale_delete = client.delete(
        f"/api/annotations/{annotation['id']}",
        params={"expected_updated_at": annotation["updated_at"]},
    )
    assert stale_delete.status_code == 409
    deleted = client.delete(
        f"/api/annotations/{annotation['id']}",
        params={"expected_updated_at": updated.json()["updated_at"]},
    )
    assert deleted.status_code == 204
    assert client.get(
        f"/api/projects/{fixture['project_id']}/items/{fixture['item_id']}/annotations"
    ).json() == []

    with client.app.state.context.database.read() as connection:
        actions = [
            row["action"]
            for row in connection.execute(
                "SELECT action FROM audit_events WHERE entity_id = ? ORDER BY occurred_at",
                (annotation["id"],),
            )
        ]
    assert actions == ["annotation.created", "annotation.updated", "annotation.deleted"]

    selected = client.post(
        f"/api/projects/{fixture['project_id']}/items/{fixture['item_id']}/annotations",
        json={
            "block_id": block["id"],
            "kind": "excerpt",
            "quoted_text": "stable paragraph anchor",
            "anchor": {"selection_source": "source"},
        },
    )
    assert selected.status_code == 201, selected.text
    assert selected.json()["anchor"]["bbox"] == block["anchor"]["bbox"]
    assert selected.json()["anchor"]["text_quote"] == {
        "type": "TextQuoteSelector",
        "exact": "stable paragraph anchor",
    }
    invalid_quote = client.post(
        f"/api/projects/{fixture['project_id']}/items/{fixture['item_id']}/annotations",
        json={
            "block_id": block["id"],
            "kind": "excerpt",
            "quoted_text": "fabricated quotation",
        },
    )
    assert invalid_quote.status_code == 409


def test_annotation_and_reading_positions_reject_cross_item_anchors(client) -> None:
    first = _document_fixture(client, "First reader item")
    second = _document_fixture(client, "Second reader item")
    foreign_block_id = second["blocks"][0]["id"]

    annotation = client.post(
        f"/api/projects/{first['project_id']}/items/{first['item_id']}/annotations",
        json={"block_id": foreign_block_id, "kind": "highlight"},
    )
    assert annotation.status_code == 409
    position = client.put(
        f"/api/projects/{first['project_id']}/items/{first['item_id']}/reading-state",
        json={"block_id": foreign_block_id, "page_number": 1, "progress": 0.5},
    )
    assert position.status_code == 409
    assert client.get(
        f"/api/projects/{first['project_id']}/items/{first['item_id']}/annotations"
    ).json() == []


def test_reading_state_and_bookmarks_are_durable_idempotent_and_audited(client) -> None:
    fixture = _document_fixture(client, "Durable reading state")
    block = fixture["blocks"][1]
    state_url = (
        f"/api/projects/{fixture['project_id']}/items/{fixture['item_id']}/reading-state"
    )
    updated = client.put(
        state_url,
        json={
            "attachment_id": fixture["attachment_id"],
            "block_id": block["id"],
            "page_number": 2,
            "progress": 0.63,
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["progress"] == 0.63

    bookmark_url = f"{state_url}/bookmarks"
    first = client.post(
        bookmark_url,
        json={"block_id": block["id"], "page_number": 2, "label": "Method result"},
    )
    assert first.status_code == 200, first.text
    repeated = client.post(
        bookmark_url,
        json={"block_id": block["id"], "page_number": 2, "label": "Duplicate"},
    )
    assert repeated.status_code == 200
    assert len(repeated.json()["bookmarks"]) == 1

    restarted = ReadingRepository(client.app.state.context.database)
    durable = restarted.get_reading_state(fixture["project_id"], fixture["item_id"])
    assert durable.block_id == block["id"]
    assert durable.progress == 0.63
    assert len(durable.bookmarks) == 1

    bookmark_id = durable.bookmarks[0].id
    removed = client.delete(f"{bookmark_url}/{bookmark_id}")
    assert removed.status_code == 200
    assert removed.json()["bookmarks"] == []
    missing = client.delete(f"{bookmark_url}/{bookmark_id}")
    assert missing.status_code == 404

    with client.app.state.context.database.read() as connection:
        actions = {
            row["action"]
            for row in connection.execute(
                "SELECT action FROM audit_events WHERE entity_id = ?",
                (f"{fixture['project_id']}:{fixture['item_id']}",),
            )
        }
    assert {
        "reading_state.updated",
        "reading_bookmark.created",
        "reading_bookmark.deleted",
    } <= actions


def test_reader_preferences_use_revision_conflicts_and_survive_restart(client) -> None:
    initial = client.get("/api/user-preferences")
    assert initial.status_code == 200
    assert initial.json()["revision"] == 0
    reader = {
        **initial.json()["reader"],
        "target_language": "zh-TW",
        "default_mode": "bilingual",
        "font_size": "large",
        "show_outline": False,
    }
    update = {
        key: value
        for key, value in initial.json().items()
        if key not in {"revision", "updated_at"}
    }
    update["agent"] = {
        **update["agent"],
        "model": "gpt-5.6-sol",
        "reasoning_effort": "xhigh",
    }
    update.update({"expected_revision": 0, "reader": reader})
    saved = client.put("/api/user-preferences", json=update)
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == 1
    stale = client.put(
        "/api/user-preferences",
        json=update,
    )
    assert stale.status_code == 409

    restarted = client.app.state.context.preferences.get()
    assert restarted.revision == 1
    assert restarted.reader.target_language == "zh-TW"
    assert restarted.reader.default_mode == "bilingual"
    assert restarted.reader.font_size == "large"
    assert restarted.reader.show_outline is False
    assert restarted.agent.model == "gpt-5.6-sol"
    assert restarted.agent.reasoning_effort == "xhigh"

    client.app.state.context.job_worker.stop()
    project = client.post("/api/projects", json={"name": "Agent defaults"}).json()
    launched = client.post(
        "/api/agent-runs",
        json={
            "task_kind": "literature_search",
            "goal": "检索候选",
            "project_id": project["id"],
        },
    )
    assert launched.status_code == 202, launched.text
    assert launched.json()["run"]["model"] == "gpt-5.6-sol"
    assert launched.json()["run"]["reasoning_effort"] == "xhigh"

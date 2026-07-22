from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from itertools import count
from typing import Any

from app.integrations.zotero.models import (
    BibliographicDraft,
    TransferCandidate,
    TransferDirection,
    TransferPlanRequest,
    TransferStatus,
    ZoteroLibraryRef,
)
from app.integrations.zotero.planner import ZoteroDiffPlanner
from tests.test_api_v3 import _candidate

_REQUEST_IDS = count(1)


def _mcp_request(client, headers: dict[str, str], method: str, params: dict[str, Any]):
    response = client.post(
        "/mcp/",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": next(_REQUEST_IDS),
            "method": method,
            "params": params,
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "error" not in payload, payload
    return payload["result"]


def _mcp_call(
    client,
    headers: dict[str, str],
    name: str,
    arguments: dict[str, Any],
):
    return _mcp_request(
        client,
        headers,
        "tools/call",
        {"name": name, "arguments": arguments},
    )


def _assert_tool_error(result: dict[str, Any], message: str) -> None:
    assert result["isError"] is True, result
    assert message in result["content"][0]["text"]


def _candidate_payload(serial: str) -> dict[str, Any]:
    payload = deepcopy(_candidate(f"Agent closure {serial}"))
    doi = f"10.0000/agent-closure-{serial}"
    payload["item"]["identifiers"][0]["value"] = doi
    payload["item"]["links"][0]["url"] = f"https://example.org/{serial}"
    payload["source_external_key"] = doi
    payload["source_url"] = f"https://api.crossref.org/works/{doi}"
    payload["raw_payload"] = {"fixture": serial}
    return payload


def _create_project(client, serial: str) -> dict[str, Any]:
    response = client.post(
        "/api/projects",
        json={"name": f"Agent closure {serial}"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _create_indexed_item(client, serial: str):
    project = _create_project(client, serial)
    staged = client.post(
        f"/api/projects/{project['id']}/candidates",
        json=_candidate_payload(serial),
    )
    assert staged.status_code == 201, staged.text
    decided = client.post(
        f"/api/projects/{project['id']}/candidate-decisions",
        json={
            "decisions": [
                {"candidate_id": staged.json()["id"], "decision": "include"}
            ]
        },
    )
    assert decided.status_code == 200, decided.text
    project_work = decided.json()[0]["project_item"]
    item_response = client.get(f"/api/items/{project_work['preferred_item_id']}")
    assert item_response.status_code == 200, item_response.text
    return project, project_work, item_response.json()


def _agent_headers(
    client,
    *,
    task_kind: str,
    goal: str,
    project_id: str | None = None,
    item_id: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
):
    context = client.app.state.context
    task_context = context.agent_prompt_context.resolve(
        task_kind=task_kind,
        goal=goal,
        project_id=project_id,
        item_id=item_id,
        target_type=target_type,
        target_id=target_id,
    )
    scopes = context.agent_prompt_context.scopes_for(
        task_kind,
        project_id,
        item_id,
        target_type,
        target_id,
    )
    run = context.agent_supervisor.create(
        task_kind,
        task_context,
        project_id=project_id,
        item_id=item_id,
        target_type=target_type,
        target_id=target_id,
        tool_scopes=scopes,
    )
    token = context.agent_capabilities.issue(
        run.id,
        project_id=project_id,
        item_id=item_id,
        target_type=target_type,
        target_id=target_id,
        scopes=frozenset(scopes),
    )
    return run, {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Host": "127.0.0.1:8000",
    }


def test_literature_tool_stages_one_idempotent_candidate_without_a_decision(client) -> None:
    project = _create_project(client, "literature")
    outside = _create_project(client, "literature-outside")
    _, headers = _agent_headers(
        client,
        task_kind="literature_search",
        goal="Stage a sourced candidate",
        project_id=project["id"],
    )
    arguments = _candidate_payload("literature-result")

    first = _mcp_call(client, headers, "stage_candidate", arguments)
    second = _mcp_call(client, headers, "stage_candidate", arguments)

    assert first["isError"] is False, first
    assert second["isError"] is False, second
    candidate = first["structuredContent"]
    assert second["structuredContent"]["id"] == candidate["id"]
    assert candidate["state"] == "staged"
    assert candidate["discovery_session_id"] is not None

    staged = client.get(f"/api/projects/{project['id']}/candidates").json()
    assert staged["total"] == 1
    assert staged["items"][0]["id"] == candidate["id"]
    assert staged["items"][0]["discovery_session_id"] == candidate["discovery_session_id"]
    assert client.get(f"/api/projects/{project['id']}/items").json()["total"] == 0

    listed = _mcp_request(client, headers, "tools/list", {})
    tools = {tool["name"]: tool for tool in listed["tools"]}
    assert tools["stage_candidate"]["annotations"]["idempotentHint"] is True

    wrong_project = _mcp_call(
        client,
        headers,
        "stage_candidate",
        {**arguments, "project_id": outside["id"]},
    )
    _assert_tool_error(wrong_project, "different project")
    assert client.get(f"/api/projects/{outside['id']}/candidates").json()["total"] == 0
    assert client.app.state.context.changes.list(project_id=project["id"]).total == 0


def test_metadata_and_project_insight_proposals_are_idempotent_and_non_mutating(client) -> None:
    project, project_work, item = _create_indexed_item(client, "metadata")
    outside_project, outside_work, outside_item = _create_indexed_item(
        client, "metadata-outside"
    )
    run, headers = _agent_headers(
        client,
        task_kind="metadata_enrichment",
        goal="Propose metadata and project insights",
        project_id=project["id"],
        item_id=item["id"],
    )
    original_item = client.get(f"/api/items/{item['id']}").json()
    original_work = client.get(f"/api/projects/{project['id']}/items").json()["items"][0]

    metadata_arguments = {
        "base_revision": item["revision"],
        "patch": {"title": "A reviewed but unapplied title"},
        "summary": "Publisher metadata supports the corrected title.",
        "evidence": [{"source": "publisher", "url": "https://example.org/record"}],
    }
    metadata_first = _mcp_call(
        client, headers, "propose_metadata_patch", metadata_arguments
    )
    metadata_second = _mcp_call(
        client, headers, "propose_metadata_patch", metadata_arguments
    )

    insights_arguments = {
        "project_work_id": project_work["id"],
        "work_id": project_work["work_id"],
        "base_updated_at": project_work["updated_at"],
        "patch": {
            "summary": "Useful for the project's causal framing.",
            "reading_focus": ["Read the identification strategy first."],
        },
        "summary": "Project-specific reading guidance.",
    }
    insights_first = _mcp_call(
        client, headers, "propose_project_insights", insights_arguments
    )
    insights_second = _mcp_call(
        client, headers, "propose_project_insights", insights_arguments
    )

    for result in (metadata_first, metadata_second, insights_first, insights_second):
        assert result["isError"] is False, result
        assert result["structuredContent"]["agent_run_id"] == run.id
    assert metadata_second["structuredContent"]["id"] == metadata_first[
        "structuredContent"
    ]["id"]
    assert insights_second["structuredContent"]["id"] == insights_first[
        "structuredContent"
    ]["id"]
    assert metadata_first["structuredContent"]["id"] != insights_first[
        "structuredContent"
    ]["id"]

    proposals = client.app.state.context.changes.list(project_id=project["id"])
    assert proposals.total == 2
    assert {proposal.kind.value for proposal in proposals.items} == {
        "metadata_patch",
        "project_insights",
    }
    assert client.get(f"/api/items/{item['id']}").json() == original_item
    assert (
        client.get(f"/api/projects/{project['id']}/items").json()["items"][0]
        == original_work
    )

    wrong_item = _mcp_call(
        client,
        headers,
        "propose_metadata_patch",
        {
            **metadata_arguments,
            "item_id": outside_item["id"],
            "base_revision": outside_item["revision"],
        },
    )
    _assert_tool_error(wrong_item, "different item")
    wrong_project_work = _mcp_call(
        client,
        headers,
        "propose_project_insights",
        {
            **insights_arguments,
            "project_work_id": outside_work["id"],
            "work_id": outside_work["work_id"],
            "base_updated_at": outside_work["updated_at"],
        },
    )
    _assert_tool_error(wrong_project_work, "outside the bound item")
    assert client.app.state.context.changes.list(project_id=project["id"]).total == 2
    assert client.app.state.context.changes.list(project_id=outside_project["id"]).total == 0


def test_resource_proposal_neither_downloads_nor_creates_an_attachment(client) -> None:
    project, _, item = _create_indexed_item(client, "resource")
    _, _, outside_item = _create_indexed_item(client, "resource-outside")
    run, headers = _agent_headers(
        client,
        task_kind="resource_acquisition",
        goal="Propose a full-text source",
        project_id=project["id"],
        item_id=item["id"],
    )
    context = client.app.state.context
    original_attachments = client.get(f"/api/items/{item['id']}/attachments").json()
    original_job_ids = {job.id for job in context.job_repository.list_jobs(limit=1000)}
    arguments = {
        "base_revision": item["revision"],
        "request": {
            "url": "https://papers.example.test/agent-closure.pdf",
            "filename": "agent-closure.pdf",
            "preferred_for": ["reading"],
        },
        "summary": "A credential-free full-text source is available.",
        "evidence": [{"source": "repository", "url": "https://papers.example.test/"}],
    }

    first = _mcp_call(client, headers, "propose_resource_acquisition", arguments)
    second = _mcp_call(client, headers, "propose_resource_acquisition", arguments)

    assert first["isError"] is False, first
    assert second["isError"] is False, second
    assert second["structuredContent"]["id"] == first["structuredContent"]["id"]
    assert first["structuredContent"]["agent_run_id"] == run.id
    proposals = context.changes.list(project_id=project["id"], item_id=item["id"])
    assert proposals.total == 1
    assert proposals.items[0].kind.value == "resource_acquisition"
    assert client.get(f"/api/items/{item['id']}/attachments").json() == original_attachments
    assert {
        job.id for job in context.job_repository.list_jobs(limit=1000)
    } == original_job_ids

    wrong_item = _mcp_call(
        client,
        headers,
        "propose_resource_acquisition",
        {
            **arguments,
            "item_id": outside_item["id"],
            "base_revision": outside_item["revision"],
        },
    )
    _assert_tool_error(wrong_item, "different item")
    assert context.changes.list(project_id=project["id"], item_id=item["id"]).total == 1
    assert client.get(f"/api/items/{item['id']}/attachments").json() == original_attachments
    assert {
        job.id for job in context.job_repository.list_jobs(limit=1000)
    } == original_job_ids


def _conflict_preview(serial: str):
    now = datetime.now(UTC)
    return ZoteroDiffPlanner(clock=lambda: now).plan(
        TransferPlanRequest(
            direction=TransferDirection.IMPORT,
            library=ZoteroLibraryRef(kind="users", id="1"),
            project_id=f"zotero-project-{serial}",
            ttl_seconds=int(timedelta(minutes=15).total_seconds()),
            items=[
                TransferCandidate(
                    item_id=f"zotero-item-{serial}",
                    source=BibliographicDraft(
                        item_type="journalArticle",
                        title=f"Source title {serial}",
                    ),
                    target=BibliographicDraft(
                        item_type="journalArticle",
                        title=f"Target title {serial}",
                    ),
                )
            ],
        )
    )


def test_zotero_preview_and_conflict_proposal_are_idempotent_without_sync(client) -> None:
    context = client.app.state.context
    preview = _conflict_preview("bound")
    outside = _conflict_preview("outside")
    assert preview.items[0].conflicts
    assert outside.items[0].conflicts
    repository = context.zotero_service.repository
    repository.save_preview(preview)
    repository.save_preview(outside)
    run, headers = _agent_headers(
        client,
        task_kind="conflict_resolution",
        goal="Suggest a resolution for the immutable preview",
        target_type="zotero_preview",
        target_id=preview.id,
    )

    read_first = _mcp_call(client, headers, "get_zotero_transfer_preview", {})
    read_second = _mcp_call(client, headers, "get_zotero_transfer_preview", {})
    assert read_first["isError"] is False, read_first
    assert read_second["structuredContent"] == read_first["structuredContent"]
    assert read_first["structuredContent"]["id"] == preview.id
    assert read_first["structuredContent"]["state"] == TransferStatus.PREVIEW_READY.value

    conflict = preview.items[0].conflicts[0]
    arguments = {
        "preview_id": preview.id,
        "expected_preview_hash": preview.preview_hash,
        "resolution": {"conflict_id": conflict.id, "choice": "source"},
        "summary": "Prefer the reviewed source metadata.",
    }
    proposal_first = _mcp_call(
        client, headers, "propose_zotero_conflict_resolution", arguments
    )
    proposal_second = _mcp_call(
        client, headers, "propose_zotero_conflict_resolution", arguments
    )
    assert proposal_first["isError"] is False, proposal_first
    assert proposal_second["isError"] is False, proposal_second
    assert proposal_second["structuredContent"]["id"] == proposal_first[
        "structuredContent"
    ]["id"]
    assert proposal_first["structuredContent"]["agent_run_id"] == run.id
    proposals = context.changes.list()
    assert proposals.total == 1
    assert proposals.items[0].kind.value == "zotero_conflict_resolution"

    assert repository.get_execution_state(preview.id) is TransferStatus.PREVIEW_READY
    assert repository.list_resolutions(preview.id) == []
    assert repository.get_receipt(preview.id) is None

    wrong_read = _mcp_call(
        client,
        headers,
        "get_zotero_transfer_preview",
        {"preview_id": outside.id},
    )
    _assert_tool_error(wrong_read, "different target")
    outside_conflict = outside.items[0].conflicts[0]
    wrong_proposal = _mcp_call(
        client,
        headers,
        "propose_zotero_conflict_resolution",
        {
            **arguments,
            "preview_id": outside.id,
            "expected_preview_hash": outside.preview_hash,
            "resolution": {
                "conflict_id": outside_conflict.id,
                "choice": "source",
            },
        },
    )
    _assert_tool_error(wrong_proposal, "different target")
    assert context.changes.list().total == 1
    assert repository.get_execution_state(outside.id) is TransferStatus.PREVIEW_READY
    assert repository.list_resolutions(outside.id) == []
    assert repository.get_receipt(outside.id) is None

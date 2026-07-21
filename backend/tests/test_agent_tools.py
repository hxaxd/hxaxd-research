from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from app.agent_tools.capabilities import AgentCapabilityRegistry
from app.agents import WEB_SEARCH_SCOPE, AgentPromptContextBuilder
from app.agents.prompting import READ_SCOPE
from app.documents.models import BlockKind, ExtractedBlock, ExtractedDocument
from app.integrations.zotero.models import (
    TransferDirection,
    TransferPreview,
    TransferSummary,
    ZoteroLibraryRef,
)
from tests.sample_data import PDF
from tests.test_api_v3 import _candidate


def test_capability_registry_issues_verifies_and_revokes_run_tokens() -> None:
    registry = AgentCapabilityRegistry(default_ttl_seconds=60)
    token = registry.issue(
        "run-1",
        project_id="project-1",
        scopes=frozenset({"literature:read", "candidates:stage"}),
    )

    verified = asyncio.run(registry.verify_token(token))
    assert verified is not None
    assert verified.subject == "run-1"
    assert verified.claims == {
        "run_id": "run-1",
        "project_id": "project-1",
        "item_id": None,
        "target_type": None,
        "target_id": None,
    }
    assert set(verified.scopes) == {"literature:read", "candidates:stage"}

    registry.revoke_run("run-1")
    assert asyncio.run(registry.verify_token(token)) is None


def test_web_search_scope_is_granted_only_to_literature_discovery_tasks() -> None:
    context = AgentPromptContextBuilder(None, None, None)  # type: ignore[arg-type]

    assert WEB_SEARCH_SCOPE in context.scopes_for("literature_search", "project-1")
    assert WEB_SEARCH_SCOPE in context.scopes_for("candidate-search", "project-1")
    assert WEB_SEARCH_SCOPE not in context.scopes_for("paper_summary", "project-1")


def test_mcp_tool_allowlist_is_derived_from_run_scopes() -> None:
    context = AgentPromptContextBuilder(None, None, None)  # type: ignore[arg-type]
    read_scopes = context.scopes_for("paper_summary", "project-1")
    discovery_scopes = context.scopes_for("literature_search", "project-1")

    assert context.tools_for_scopes(read_scopes) == (
        "workspace_summary",
        "get_project",
        "list_project_works",
        "get_bibliographic_item",
        "list_candidates",
    )
    assert context.tools_for_scopes(discovery_scopes)[-1] == "stage_candidate"


def test_non_search_task_context_uses_central_task_constraints() -> None:
    context = AgentPromptContextBuilder(None, None, None)  # type: ignore[arg-type]

    scopes = context.scopes_for("metadata_enrichment", None, "item-1")
    assert context.tools_for_scopes(scopes) == (
        "workspace_summary",
        "get_project",
        "list_project_works",
        "get_bibliographic_item",
        "list_candidates",
        "propose_metadata_patch",
        "propose_project_insights",
    )


def test_all_four_agent_task_types_have_explicit_tools_and_context_requirements() -> None:
    context = AgentPromptContextBuilder(None, None, None)  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="绑定文献条目"):
        context.scopes_for("resource_acquisition", None)
    resource = context.scopes_for("resource_acquisition", None, "item-1")
    assert context.tools_for_scopes(resource)[-1] == "propose_resource_acquisition"

    with pytest.raises(ValueError, match="领域目标"):
        context.scopes_for("conflict_resolution", None)
    conflict = context.scopes_for(
        "conflict_resolution",
        None,
        target_type="zotero_preview",
        target_id="preview-1",
    )
    assert context.tools_for_scopes(conflict)[-2:] == (
        "get_zotero_transfer_preview",
        "propose_zotero_conflict_resolution",
    )


def test_conflict_task_context_contains_the_bound_immutable_preview() -> None:
    now = datetime.now(UTC)
    preview = TransferPreview(
        id="preview-1",
        direction=TransferDirection.IMPORT,
        library=ZoteroLibraryRef(kind="users", id="1"),
        project_id="project-1",
        created_at=now,
        expires_at=now + timedelta(minutes=15),
        items=[],
        summary=TransferSummary(total=0),
        preview_hash="a" * 64,
    )

    class _Zotero:
        @staticmethod
        def get_preview(preview_id: str):
            assert preview_id == preview.id
            return preview

    context = AgentPromptContextBuilder(
        None, None, None, _Zotero()  # type: ignore[arg-type]
    )
    resolved = context.resolve(
        task_kind="conflict_resolution",
        goal="分析冲突",
        project_id=None,
        item_id=None,
        target_type="zotero_preview",
        target_id=preview.id,
    )

    injected = resolved.task_data["zotero_transfer_preview"]
    assert injected["id"] == preview.id
    assert injected["preview_hash"] == preview.preview_hash
    assert "library" not in injected


def test_streamable_http_mcp_authenticates_and_calls_domain_tool(client) -> None:
    registry = client.app.state.context.agent_capabilities
    token = registry.issue(
        "transport-test-run",
        project_id=None,
        scopes=frozenset({READ_SCOPE}),
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Host": "127.0.0.1:8000",
    }
    initialize = client.post(
        "/mcp/",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "transport-test", "version": "1"},
            },
        },
    )
    assert initialize.status_code == 200

    listed = client.post(
        "/mcp/",
        headers=headers,
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    assert listed.status_code == 200
    tools = {item["name"]: item for item in listed.json()["result"]["tools"]}
    assert tools["workspace_summary"]["annotations"] == {
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }

    called = client.post(
        "/mcp/",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "workspace_summary", "arguments": {}},
        },
    )
    assert called.status_code == 200
    result = called.json()["result"]
    assert result["isError"] is False
    assert result["structuredContent"]["counts"]["projects"] == 0
    registry.revoke_run("transport-test-run")


def test_bound_agent_can_only_submit_an_idempotent_metadata_proposal(client) -> None:
    project = client.post("/api/projects", json={"name": "Agent changes"}).json()
    candidate = client.post(
        f"/api/projects/{project['id']}/candidates", json=_candidate()
    ).json()
    membership = client.post(
        f"/api/projects/{project['id']}/candidates/{candidate['id']}/promote",
        json={},
    ).json()
    item_id = membership["preferred_item_id"]
    item = client.get(f"/api/items/{item_id}").json()
    context = client.app.state.context
    uploaded = client.post(
        f"/api/items/{item_id}/attachments",
        files={"upload": ("agent-context.pdf", PDF, "application/pdf")},
    ).json()
    attachment, _ = context.attachments.locate(uploaded["id"])
    document = context.documents.repository.commit_extraction(
        item_id=item_id,
        source_attachment_id=attachment.id,
        source_sha256=attachment.sha256,
        extractor="context-fixture",
        extractor_version="1",
        structure_version="semantic-blocks-v2",
        structure_hash="d" * 64,
        extracted=ExtractedDocument(
            language="en",
            page_count=1,
            blocks=[
                ExtractedBlock(
                    kind=BlockKind.PARAGRAPH,
                    source_text="A structured paragraph is injected into the task snapshot.",
                    page_start=1,
                    page_end=1,
                    anchor={"page": 1},
                )
            ],
        ),
        job_id=None,
    )
    block = context.documents.blocks(
        document.id, offset=0, limit=10, target_language=None
    ).items[0]
    annotation = client.post(
        f"/api/projects/{project['id']}/items/{item_id}/annotations",
        json={"block_id": block.id, "kind": "claim", "body": "Keep this claim."},
    )
    assert annotation.status_code == 201, annotation.text
    task_context = context.agent_prompt_context.resolve(
        task_kind="metadata_enrichment",
        goal="核验并补全标题",
        project_id=project["id"],
        item_id=item_id,
    )
    assert task_context.documents[0]["blocks"][0]["id"] == block.id
    assert task_context.documents[0]["blocks"][0]["source_text"].startswith(
        "A structured paragraph"
    )
    assert task_context.reading_memory["annotations"][0]["body"] == "Keep this claim."
    scopes = context.agent_prompt_context.scopes_for(
        "metadata_enrichment", project["id"], item_id
    )
    run = context.agent_supervisor.create(
        "metadata_enrichment",
        task_context,
        project_id=project["id"],
        item_id=item_id,
        tool_scopes=scopes,
    )
    token = context.agent_capabilities.issue(
        run.id,
        project_id=project["id"],
        item_id=item_id,
        scopes=frozenset(scopes),
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Host": "127.0.0.1:8000",
    }
    arguments = {
        "base_revision": item["revision"],
        "patch": {"title": "Agent-proposed title"},
        "summary": "Publisher record uses a corrected title.",
        "evidence": [
            {
                "source": "publisher",
                "url": "https://example.org/publisher-record",
            }
        ],
    }

    def call(arguments_override=None):
        return client.post(
            "/mcp/",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 10,
                "method": "tools/call",
                "params": {
                    "name": "propose_metadata_patch",
                    "arguments": arguments_override or arguments,
                },
            },
        ).json()["result"]

    first = call()
    second = call()
    assert first["isError"] is False
    assert second["structuredContent"]["id"] == first["structuredContent"]["id"]
    assert first["structuredContent"]["agent_run_id"] == run.id
    assert first["structuredContent"]["status"] == "submitted"
    assert client.get(f"/api/items/{item_id}").json()["title"] != "Agent-proposed title"

    wrong_item = call({**arguments, "item_id": "outside-item"})
    assert wrong_item["isError"] is True
    assert "different item" in wrong_item["content"][0]["text"]

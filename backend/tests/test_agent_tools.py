from __future__ import annotations

import asyncio

from app.agent_tools.capabilities import AgentCapabilityRegistry
from app.agents import WEB_SEARCH_SCOPE, AgentPromptContextBuilder
from app.agents.prompting import READ_SCOPE


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
    assert verified.claims == {"run_id": "run-1", "project_id": "project-1"}
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

    prompt_context = context.resolve(
        task_kind="metadata_enrichment",
        goal="补全缺失的作者信息",
        project_id=None,
        item_id=None,
    )

    assert prompt_context.capabilities["mcp_tools"] == [
        "workspace_summary",
        "get_project",
        "list_project_works",
        "get_bibliographic_item",
        "list_candidates",
    ]
    assert any("元数据补全建议" in item for item in prompt_context.constraints)
    assert all("自行下载" not in item for item in prompt_context.constraints)


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

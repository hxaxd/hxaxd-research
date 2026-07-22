from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from threading import Thread
from time import sleep

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agents import (
    AGENT_RUN_JOB_KIND,
    WEB_SEARCH_SCOPE,
    AgentRunJobHandler,
    AgentRunStatus,
    AgentSupervisor,
    ApprovalDecision,
    ApprovalStatus,
    CodexWebSearchMode,
    PromptAssembler,
    PromptContext,
    RuntimeApprovalRequest,
    RuntimeEvent,
    RuntimeMcpCredentials,
    RuntimeOutcome,
    RuntimeRequest,
    SqliteAgentRunRepository,
)
from app.agents.codex_app_server import (
    CodexAppServerRuntime,
    CodexProtocolError,
    _mcp_audit_event,
    _validate_instruction_sources,
    normalize_codex_event,
)
from app.agents.router import create_agent_router
from app.agents.runtime import RuntimeOutcomeStatus
from app.agents.streaming import stream_agent_events
from app.jobs import (
    JobCreate,
    JobRegistry,
    JobScheduler,
    JobStatus,
    JobWorker,
    SqliteJobRepository,
)
from app.platform.db import WorkspaceDatabase
from app.platform.processes import (
    ExecutableIdentity,
    ExecutableRegistry,
    ProcessRunner,
)


class _FakeRuntime:
    name = "fake"
    version = "1"

    def __init__(self, request_approval: bool = False) -> None:
        self.request_approval = request_approval

    def run(self, request, emit, approve, cancellation):
        emit(RuntimeEvent("turn.started", {"prompt": request.prompt[:20]}))
        if self.request_approval:
            decision = approve(
                RuntimeApprovalRequest("provider-1", "domain_write", {"paper_id": "p1"}, True)
            )
            assert decision is ApprovalDecision.APPROVE
        emit(RuntimeEvent("agent.message.delta", {"delta": "完成"}))
        return RuntimeOutcome(
            RuntimeOutcomeStatus.COMPLETED,
            "thread-1",
            "turn-1",
            final_message="完成",
        )

    def interrupt(self, run_id):
        return None


def test_codex_instruction_sources_allow_only_global_guidance(tmp_path) -> None:
    codex_home = tmp_path / "codex-home"
    _validate_instruction_sources(
        [str(codex_home / "AGENTS.md")],
        {"codexHome": str(codex_home)},
    )
    _validate_instruction_sources(
        [str(codex_home / "AGENTS.override.md")],
        {"codexHome": str(codex_home)},
    )

    with pytest.raises(CodexProtocolError, match="external instruction files"):
        _validate_instruction_sources(
            [str(tmp_path / "project" / "AGENTS.md")],
            {"codexHome": str(codex_home)},
        )


def test_codex_instruction_sources_reject_invalid_metadata(tmp_path) -> None:
    with pytest.raises(CodexProtocolError, match="invalid instruction source metadata"):
        _validate_instruction_sources(
            [str(tmp_path / "AGENTS.md"), {"path": "unexpected"}],
            {"codexHome": str(tmp_path / "codex-home")},
        )


def test_codex_mcp_events_split_public_status_from_internal_audit() -> None:
    params = {
        "item": {
            "id": "provider-item-private",
            "type": "mcpToolCall",
            "server": "hxaxd",
            "tool": "workspace_summary",
            "status": "failed",
            "durationMs": 12,
            "arguments": {"project_id": "project-1"},
            "error": {"message": "user cancelled MCP tool call"},
        }
    }

    public = normalize_codex_event("item/completed", params)
    audit = _mcp_audit_event("item/completed", params)

    assert public is not None
    assert public.event_type == "tool.failed"
    assert public.visibility == "public"
    assert public.payload == {
        "type": "mcpToolCall",
        "status": "failed",
        "tool": "workspace_summary",
        "duration_ms": 12,
        "error_code": "mcp_tool_failed",
    }
    assert audit is not None
    assert audit.event_type == "mcp_tool.audit.failed"
    assert audit.visibility == "internal"
    assert audit.payload["provider_item_id"] == "provider-item-private"
    assert audit.payload["error_message"] == "user cancelled MCP tool call"
    assert audit.payload["arguments"]["sha256"]


def _supervisor(tmp_path, runtime):
    database_path = tmp_path / "agents.sqlite3"
    WorkspaceDatabase(database_path).initialize()
    repository = SqliteAgentRunRepository(database_path)
    repository.initialize_schema()
    supervisor = AgentSupervisor(
        repository,
        runtime,
        PromptAssembler(),
        tmp_path / "agent-workspaces",
        approval_timeout_seconds=2,
    )
    return repository, supervisor


def test_prompt_is_deterministic_user_context_without_api_prose():
    assembler = PromptAssembler()
    context = PromptContext(
        objective="筛选候选论文",
        project={"id": "p1", "name": "智能体"},
        capabilities={"paper.stage": {"write": True}},
    )
    first = assembler.assemble(context)
    second = assembler.assemble(context)
    assert first.context_hash == second.context_hash
    assert first.prompt == second.prompt
    assert "筛选候选论文" in first.prompt
    assert "API.md" not in first.prompt


def test_supervisor_persists_runtime_events_and_approval(tmp_path):
    repository, supervisor = _supervisor(tmp_path, _FakeRuntime(request_approval=True))
    run = supervisor.create("literature.search", PromptContext(objective="找论文"))
    results = []
    thread = Thread(target=lambda: results.append(supervisor.execute(run.id)))
    thread.start()
    for _ in range(200):
        pending = repository.pending_approvals(run.id)
        if pending:
            break
        sleep(0.01)
    assert pending[0].kind == "domain_write"
    supervisor.resolve_approval(pending[0].id, ApprovalDecision.APPROVE)
    thread.join(timeout=3)
    assert results[0].status is AgentRunStatus.COMPLETED
    assert results[0].provider_thread_id == "thread-1"
    assert any(event.event_type == "approval.resolved" for event in repository.list_events(run.id))


def test_supervisor_revokes_run_capability_after_execution(tmp_path):
    database_path = tmp_path / "agents.sqlite3"
    WorkspaceDatabase(database_path).initialize()
    repository = SqliteAgentRunRepository(database_path)
    repository.initialize_schema()
    revoked = []
    supervisor = AgentSupervisor(
        repository,
        _FakeRuntime(),
        PromptAssembler(),
        tmp_path / "agent-workspaces",
        mcp_credentials=lambda run: RuntimeMcpCredentials(
            "http://127.0.0.1:8765/mcp",
            f"token-for-{run.id}",
        ),
        mcp_revoke=revoked.append,
    )
    run = supervisor.create("literature.search", PromptContext(objective="找论文"))

    completed = supervisor.execute(run.id)

    assert completed.status is AgentRunStatus.COMPLETED
    assert revoked == [run.id]


def test_cancel_resolves_pending_approval_and_finishes_run(tmp_path):
    class WaitingRuntime:
        name = "waiting"
        version = "1"

        def run(self, request, emit, approve, cancellation):
            decision = approve(RuntimeApprovalRequest("provider-cancel", "domain_write", {}, True))
            assert decision is ApprovalDecision.CANCEL
            return RuntimeOutcome(RuntimeOutcomeStatus.CANCELED, "thread-cancel", "turn-cancel")

        def interrupt(self, run_id):
            return None

    repository, supervisor = _supervisor(tmp_path, WaitingRuntime())
    run = supervisor.create("literature.search", PromptContext(objective="找论文"))
    results = []
    thread = Thread(target=lambda: results.append(supervisor.execute(run.id)))
    thread.start()
    for _ in range(200):
        pending = repository.pending_approvals(run.id)
        if pending:
            break
        sleep(0.01)
    assert pending
    supervisor.cancel(run.id)
    thread.join(timeout=3)

    approval = repository.get_approval(pending[0].id)
    assert approval.status is ApprovalStatus.DENIED
    assert approval.decision is ApprovalDecision.CANCEL
    assert results[0].status is AgentRunStatus.CANCELED


def test_restart_reconciles_agent_and_recovered_job_then_allows_new_thread(tmp_path):
    database_path = tmp_path / "agents.sqlite3"
    WorkspaceDatabase(database_path).initialize()
    repository = SqliteAgentRunRepository(database_path)
    repository.initialize_schema()
    supervisor = AgentSupervisor(
        repository,
        _FakeRuntime(),
        PromptAssembler(),
        tmp_path / "agent-workspaces",
    )
    jobs = SqliteJobRepository(database_path)
    jobs.initialize_schema()

    run = supervisor.create("literature.search", PromptContext(objective="找论文"))
    interrupted_job = jobs.enqueue(
        JobCreate(
            kind=AGENT_RUN_JOB_KIND,
            input={"run_id": run.id},
            subject_type="agent_run",
            subject_id=run.id,
            concurrency_key=f"agent-run:{run.id}",
            max_attempts=2,
        )
    )
    assert jobs.claim_next("dead-worker") is not None
    repository.transition(run.id, AgentRunStatus.STARTING)
    repository.transition(run.id, AgentRunStatus.RUNNING)
    approval = repository.create_approval(
        run.id,
        "provider-before-restart",
        "domain_write",
        {},
        approvable=True,
    )
    repository.transition(run.id, AgentRunStatus.WAITING_APPROVAL)

    canceling = supervisor.create("literature.search", PromptContext(objective="停止"))
    repository.transition(canceling.id, AgentRunStatus.STARTING)
    repository.transition(canceling.id, AgentRunStatus.RUNNING)
    repository.request_cancel(canceling.id)

    restarted_repository = SqliteAgentRunRepository(database_path)
    restarted_repository.initialize_schema()
    assert restarted_repository.reconcile_interrupted() == 2
    recovered_run = restarted_repository.get(run.id)
    assert recovered_run.status is AgentRunStatus.FAILED
    assert recovered_run.error_code == "agent_worker_restarted"
    resolved = restarted_repository.get_approval(approval.id)
    assert resolved.status is ApprovalStatus.DENIED
    assert resolved.decision is ApprovalDecision.CANCEL
    assert restarted_repository.get(canceling.id).status is AgentRunStatus.CANCELED

    restarted_jobs = SqliteJobRepository(database_path)
    restarted_jobs.initialize_schema()
    assert restarted_jobs.recover_interrupted() == 1
    assert restarted_jobs.get(interrupted_job.id).status is JobStatus.QUEUED

    restarted_supervisor = AgentSupervisor(
        restarted_repository,
        _FakeRuntime(),
        PromptAssembler(),
        tmp_path / "agent-workspaces",
    )
    registry = JobRegistry()
    registry.register(AGENT_RUN_JOB_KIND, AgentRunJobHandler(restarted_supervisor))
    worker = JobWorker(restarted_jobs, registry, worker_id="worker-after-restart")
    assert worker.run_once()
    failed_job = restarted_jobs.get(interrupted_job.id)
    assert failed_job.status is JobStatus.FAILED
    assert failed_job.error_code == "agent_worker_restarted"

    resumed = restarted_supervisor.prepare_resume(run.id)
    assert resumed.status is AgentRunStatus.CREATED
    assert resumed.provider_thread_id is None
    assert restarted_repository.list_events(run.id)[-1].payload == {"mode": "new_provider_thread"}
    replacement_job = restarted_jobs.enqueue(
        JobCreate(
            kind=AGENT_RUN_JOB_KIND,
            input={"run_id": run.id},
            subject_type="agent_run",
            subject_id=run.id,
            concurrency_key=f"agent-run:{run.id}",
        )
    )
    assert worker.run_once()
    assert restarted_jobs.get(replacement_job.id).status is JobStatus.SUCCEEDED
    assert restarted_repository.get(run.id).status is AgentRunStatus.COMPLETED


def test_codex_runtime_uses_jsonl_handshake_and_denies_sandbox_escape(tmp_path):
    fake_server = tmp_path / "fake_app_server.py"
    fake_server.write_text(_FAKE_APP_SERVER, encoding="utf-8")
    executable = Path(sys.executable).resolve()
    registry = ExecutableRegistry((ExecutableIdentity("codex", executable, executable.parent),))
    runner = ProcessRunner(registry)
    workspace_root = tmp_path / "runs"
    cwd = workspace_root / "run-1"
    cwd.mkdir(parents=True)
    runtime = CodexAppServerRuntime(
        runner,
        workspace_root,
        executable="codex",
        command_prefix=(str(fake_server),),
        web_search=CodexWebSearchMode.LIVE,
    )
    events = []
    approvals = []

    def approve(request):
        approvals.append(request)
        return ApprovalDecision.APPROVE

    outcome = runtime.run(
        RuntimeRequest(
            "run-1",
            "hello",
            cwd,
            tool_scopes=(WEB_SEARCH_SCOPE,),
            mcp=RuntimeMcpCredentials(
                "http://127.0.0.1:8765/mcp",
                "short-token",
                enabled_tools=("workspace_summary",),
            ),
            timeout_seconds=10,
        ),
        events.append,
        approve,
        cancellation=_never_cancelled(),
    )
    assert outcome.status is RuntimeOutcomeStatus.COMPLETED
    assert outcome.thread_id == "thread-fake"
    assert outcome.turn_id == "turn-fake"
    assert outcome.final_message == "hello from fake [REDACTED]"
    assert "short-token" not in repr(outcome)
    assert "short-token" not in repr(events)
    assert approvals[0].kind == "command"
    assert approvals[0].approvable is False
    assert any(event.event_type == "agent.message.delta" for event in events)
    assert any(event.event_type == "web_search.started" for event in events)

    no_web_cwd = workspace_root / "run-2"
    no_web_cwd.mkdir()
    no_web_events = []
    no_web_outcome = runtime.run(
        RuntimeRequest(
            "run-2",
            "no-web",
            no_web_cwd,
            mcp=RuntimeMcpCredentials(
                "http://127.0.0.1:8765/mcp",
                "short-token",
                enabled_tools=("workspace_summary",),
            ),
            timeout_seconds=10,
        ),
        no_web_events.append,
        approve,
        cancellation=_never_cancelled(),
    )
    assert no_web_outcome.status is RuntimeOutcomeStatus.COMPLETED
    assert not any(event.event_type.startswith("web_search.") for event in no_web_events)


def test_agent_router_launches_and_cancels_a_durable_job(tmp_path):
    repository, supervisor = _supervisor(tmp_path, _FakeRuntime())
    jobs = SqliteJobRepository(repository.database_path)
    jobs.initialize_schema()
    scheduler = JobScheduler(jobs)
    app = FastAPI()
    app.include_router(
        create_agent_router(
            lambda: supervisor,
            lambda: repository,
            lambda: scheduler,
            context_resolver=lambda request: PromptContext(
                objective=request.goal,
                project={"id": request.project_id} if request.project_id else None,
            ),
            scope_resolver=lambda request: ("catalog.read",),
        ),
        prefix="/api",
    )
    client = TestClient(app)
    launched = client.post(
        "/api/agent-runs",
        json={"task_kind": "literature.search", "goal": "找论文"},
    )
    assert launched.status_code == 202, launched.text
    payload = launched.json()
    run_id = payload["run"]["id"]
    assert payload["run"]["goal"] == "找论文"
    assert payload["run"]["tool_scopes"] == ["catalog.read"]
    assert "prompt" not in payload["run"]
    assert "cwd" not in payload["run"]
    assert "context_hash" not in payload["run"]
    assert "provider_thread_id" not in payload["run"]
    assert jobs.get(payload["job_id"]).status is JobStatus.QUEUED
    listed = client.get("/api/agent-runs")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["items"]] == [run_id]
    assert listed.json()["total"] == 1
    canceled = client.post(f"/api/agent-runs/{run_id}/interrupt")
    assert canceled.status_code == 202
    assert jobs.get(payload["job_id"]).status is JobStatus.CANCELED

    repository.append_event(run_id, "runtime.private", {}, visibility="internal")

    async def collect():
        return [event async for event in stream_agent_events(repository, run_id, poll_interval=0)]

    streamed = asyncio.run(collect())
    assert any("event: run.canceled" in event for event in streamed)
    assert not any("runtime.private" in event for event in streamed)


def test_agent_approval_routes_expose_only_public_fields(tmp_path):
    repository, supervisor = _supervisor(tmp_path, _FakeRuntime(request_approval=True))
    jobs = SqliteJobRepository(repository.database_path)
    jobs.initialize_schema()
    scheduler = JobScheduler(jobs)
    app = FastAPI()
    app.include_router(
        create_agent_router(
            lambda: supervisor,
            lambda: repository,
            lambda: scheduler,
            context_resolver=lambda request: PromptContext(objective=request.goal),
            scope_resolver=lambda request: ("catalog.read",),
        ),
        prefix="/api",
    )
    client = TestClient(app)
    launched = client.post(
        "/api/agent-runs",
        json={"task_kind": "literature.search", "goal": "核验论文"},
    ).json()
    run_id = launched["run"]["id"]
    results = []
    thread = Thread(target=lambda: results.append(supervisor.execute(run_id)))
    thread.start()
    for _ in range(200):
        response = client.get(f"/api/agent-runs/{run_id}/approvals")
        if response.json():
            break
        sleep(0.01)
    public_approval = response.json()[0]
    assert "provider_request_id" not in public_approval
    resolved = client.post(f"/api/approvals/{public_approval['id']}/approve")
    assert resolved.status_code == 200
    assert resolved.json()["decision"] == "approve"
    history = client.get(f"/api/agent-runs/{run_id}/approvals").json()
    assert history == [resolved.json()]
    assert client.get(
        f"/api/agent-runs/{run_id}/approvals?status=pending"
    ).json() == []
    thread.join(timeout=3)
    assert results[0].status is AgentRunStatus.COMPLETED


def _never_cancelled():
    from app.platform.processes import CancellationToken

    return CancellationToken()


_FAKE_APP_SERVER = r"""
import json
import os
import sys

if sys.argv[1:] == ["mcp", "list", "--json"]:
    print(json.dumps([
        {
            "name": "external",
            "transport": {"type": "stdio", "command": "external-mcp", "args": []},
        },
        {
            "name": "figma",
            "transport": {"type": "streamable_http", "url": "https://mcp.figma.test"},
        },
    ]), flush=True)
    raise SystemExit(0)

def send(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        assert message["params"]["capabilities"] == {"experimentalApi": True}
        send({"id": message["id"], "result": {"platformFamily": "windows", "platformOs": "test"}})
    elif method == "initialized":
        continue
    elif method in {"thread/start", "thread/resume"}:
        params = message["params"]
        assert params["sandbox"] == "read-only"
        assert params["config"]["project_doc_max_bytes"] == 0
        assert params["dynamicTools"] == []
        assert params["environments"] == []
        assert params["selectedCapabilityRoots"] == []
        assert params["config"]["agents"] == {"enabled": False}
        assert params["config"]["apps"] == {"_default": {"enabled": False}}
        assert params["config"]["features"]["shell_tool"] is False
        assert params["config"]["features"]["plugins"] is False
        assert params["config"]["mcp_servers"] == {
            "external": {"command": "external-mcp", "enabled": False},
            "figma": {"url": "https://mcp.figma.test", "enabled": False},
            "hxaxd": {
                "url": "http://127.0.0.1:8765/mcp",
                "bearer_token_env_var": "HXAXD_MCP_TOKEN",
                "enabled": True,
                "required": True,
                "enabled_tools": ["workspace_summary"],
                "default_tools_approval_mode": "approve",
            }
        }
        assert os.environ["HXAXD_MCP_TOKEN"] == "short-token"
        send({"id": message["id"], "result": {"thread": {"id": "thread-fake"}}})
    elif method == "turn/start":
        params = message["params"]
        prompt = params["input"][0]["text"]
        expected_web_mode = "disabled" if prompt == "no-web" else "live"
        assert f'web_search="{expected_web_mode}"' in sys.argv
        assert params["sandboxPolicy"] == {"type": "readOnly", "networkAccess": False}
        send({"id": message["id"], "result": {"turn": {"id": "turn-fake"}}})
        send({
            "method": "turn/started",
            "params": {"turn": {"id": "turn-fake", "status": "inProgress"}},
        })
        if expected_web_mode == "live":
            send({
                "method": "item/started",
                "params": {
                    "item": {
                        "id": "search-1",
                        "type": "webSearch",
                        "query": "site:arxiv.org agent systems",
                        "action": {"type": "search", "query": "agent systems"},
                    }
                },
            })
        send({
            "id": 900,
            "method": "item/commandExecution/requestApproval",
            "params": {"itemId": "cmd-1", "command": "whoami"},
        })
    elif message.get("id") == 900 and "result" in message:
        assert message["result"] == {"decision": "decline"}
        send({
            "method": "item/agentMessage/delta",
            "params": {"delta": "hello from fake short-token"},
        })
        send({
            "method": "turn/completed",
            "params": {
                "turn": {"id": "turn-fake", "status": "completed"},
                "usage": {"inputTokens": 1},
            },
        })
"""

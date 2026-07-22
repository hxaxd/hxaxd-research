from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path
from threading import Timer

import pytest

from app.agents.models import ApprovalDecision
from app.agents.pi_rpc import PI_MODEL, PiProtocolError, PiRpcRuntime, render_pi_mcp_bridge
from app.agents.runtime import (
    RuntimeMcpCredentials,
    RuntimeOutcomeStatus,
    RuntimeRequest,
)
from app.platform.processes import (
    CancellationToken,
    ExecutableIdentity,
    ExecutableRegistry,
    ProcessRunner,
)

_SESSION_ID = "12345678-1234-4234-8234-123456789abc"

_FAKE_PI = r'''
import json
import os
from pathlib import Path
import sys

SESSION_ID = "12345678-1234-4234-8234-123456789abc"
args = sys.argv[1:]
assert args[args.index("--mode") + 1] == "rpc"
assert args[args.index("--provider") + 1] == "deepseek"
assert args[args.index("--model") + 1] == "deepseek-v4-flash"
assert args[args.index("--thinking") + 1] == "high"
assert "--no-session" not in args
assert "--no-builtin-tools" in args
assert "--no-extensions" in args
assert "--no-skills" in args
assert "--no-context-files" in args
assert args[args.index("--tools") + 1] == "workspace_summary,web_search"
session_dir = Path(args[args.index("--session-dir") + 1]).resolve()
assert session_dir.name == ".pi-sessions"
session_dir.mkdir(parents=True, exist_ok=True)
if "--session" in args:
    assert args[args.index("--session") + 1] == SESSION_ID
extension = Path(args[args.index("--extension") + 1])
source = extension.read_text(encoding="utf-8")
token = os.environ["HXAXD_MCP_TOKEN"]
assert token not in source
assert "http://127.0.0.1:8765/mcp" in source
assert "AbortController" in source
assert "signal: linked.signal" in source
assert 'pi.on("session_start", () => pi.setActiveTools([...ENABLED_TOOLS]))' in source

def send(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)

waiting = None
for line in sys.stdin:
    message = json.loads(line)
    kind = message.get("type")
    if kind == "get_state":
        send({
            "id": message["id"],
            "type": "response",
            "command": "get_state",
            "success": True,
            "data": {
                "model": {"provider": "deepseek", "id": "deepseek-v4-flash"},
                "sessionId": SESSION_ID,
                "sessionFile": str(session_dir / "session.jsonl"),
            },
        })
    elif kind == "prompt":
        waiting = message["message"]
        send({
            "id": message["id"],
            "type": "response",
            "command": "prompt",
            "success": True,
        })
        send({"type": "agent_start"})
        if waiting == "cancel-me":
            continue
        if waiting == "unauthorized":
            send({
                "type": "tool_execution_start",
                "toolCallId": "bad-1",
                "toolName": "bash",
                "args": {"command": "whoami"},
            })
            continue
        if waiting == "unknown-terminal":
            send({
                "type": "tool_execution_end",
                "toolCallId": "missing-start",
                "toolName": "workspace_summary",
                "result": {},
                "isError": False,
            })
            continue
        if waiting in {"duplicate-tool", "incomplete-tool"}:
            tool_start = {
                "type": "tool_execution_start",
                "toolCallId": "incomplete-1",
                "toolName": "workspace_summary",
                "args": {},
            }
            send(tool_start)
            if waiting == "duplicate-tool":
                send(tool_start)
                continue
            assistant = {
                "role": "assistant",
                "content": [],
                "stopReason": "stop",
                "usage": {"input": 1, "output": 0},
            }
            send({"type": "agent_end", "messages": [assistant]})
            continue
        send({
            "type": "extension_ui_request",
            "id": "ui-1",
            "method": "confirm",
            "title": "Unexpected prompt",
        })
    elif kind == "extension_ui_response":
        assert message == {
            "type": "extension_ui_response",
            "id": "ui-1",
            "cancelled": True,
        }
        send({
            "type": "tool_execution_start",
            "toolCallId": "tool-1",
            "toolName": "web_search",
            "args": {"query": "agent systems"},
        })
        send({
            "type": "tool_execution_end",
            "toolCallId": "tool-1",
            "toolName": "web_search",
            "result": {"content": [{"type": "text", "text": "result " + token}]},
            "isError": False,
        })
        send({
            "type": "message_update",
            "message": {},
            "assistantMessageEvent": {
                "type": "text_delta",
                "delta": "completed " + token,
            },
        })
        assistant = {
            "role": "assistant",
            "content": [{"type": "text", "text": "completed " + token}],
            "stopReason": "stop",
            "usage": {"input": 10, "output": 2},
        }
        send({"type": "message_end", "message": assistant})
        send({"type": "agent_end", "messages": [assistant]})
    elif kind == "abort":
        assert waiting == "cancel-me"
        send({
            "id": message["id"],
            "type": "response",
            "command": "abort",
            "success": True,
        })
        assistant = {
            "role": "assistant",
            "content": [],
            "stopReason": "aborted",
            "usage": {"input": 1, "output": 0},
        }
        send({"type": "agent_end", "messages": [assistant]})
'''


def _runtime(tmp_path: Path) -> tuple[PiRpcRuntime, Path]:
    fake = tmp_path / "fake_pi.py"
    fake.write_text(_FAKE_PI, encoding="utf-8")
    executable = Path(sys.executable).resolve()
    runner = ProcessRunner(
        ExecutableRegistry((ExecutableIdentity("pi", executable, executable.parent),))
    )
    workspace = tmp_path / "runs"
    cwd = workspace / "run-1"
    cwd.mkdir(parents=True)
    return (
        PiRpcRuntime(
            runner,
            workspace,
            executable="pi",
            command_prefix=(str(fake),),
            interrupt_grace_seconds=1,
        ),
        cwd,
    )


def _request(cwd: Path, prompt: str, *, thread_id: str | None = None) -> RuntimeRequest:
    return RuntimeRequest(
        "run-1",
        prompt,
        cwd,
        thread_id=thread_id,
        model=PI_MODEL,
        reasoning_effort="xhigh",
        mcp=RuntimeMcpCredentials(
            "http://127.0.0.1:8765/mcp",
            "short-lived-token",
            enabled_tools=("workspace_summary", "web_search"),
        ),
        timeout_seconds=10,
    )


def test_pi_rpc_pins_flash_bridges_only_enabled_tools_and_redacts_audit(tmp_path: Path) -> None:
    runtime, cwd = _runtime(tmp_path)
    events = []
    approvals = []

    def approve(request):
        approvals.append(request)
        return ApprovalDecision.APPROVE

    outcome = runtime.run(
        _request(cwd, "complete"),
        events.append,
        approve,
        CancellationToken(),
    )

    assert outcome.status is RuntimeOutcomeStatus.COMPLETED
    assert outcome.thread_id == _SESSION_ID
    assert outcome.turn_id
    assert outcome.final_message == "completed [REDACTED]"
    assert outcome.usage == {"input": 10, "output": 2}
    assert approvals[0].kind == "extension_ui"
    assert approvals[0].approvable is False
    assert "short-lived-token" not in repr(outcome)
    assert "short-lived-token" not in repr(events)
    thread_event = next(event for event in events if event.event_type == "thread.started")
    assert thread_event.visibility == "internal"
    turn_event = next(event for event in events if event.event_type == "turn.started")
    assert turn_event.visibility == "internal"
    assert all(
        "provider_item_id" not in event.payload
        for event in events
        if event.visibility == "public"
    )
    assert any(event.event_type == "mcp_tool.audit.started" for event in events)
    assert any(event.event_type == "mcp_tool.audit.completed" for event in events)
    assert any(event.event_type == "web_search.completed" for event in events)


def test_pi_rpc_resumes_full_uuid_session_and_creates_a_new_turn_id(tmp_path: Path) -> None:
    runtime, cwd = _runtime(tmp_path)
    first = runtime.run(
        _request(cwd, "complete"),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )
    resumed = runtime.run(
        _request(cwd, "complete", thread_id=first.thread_id),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )

    assert resumed.status is RuntimeOutcomeStatus.COMPLETED
    assert resumed.thread_id == first.thread_id == _SESSION_ID
    assert resumed.turn_id != first.turn_id


def test_pi_rpc_abort_reaches_rpc_and_returns_canceled(tmp_path: Path) -> None:
    runtime, cwd = _runtime(tmp_path)
    cancellation = CancellationToken()
    timer = Timer(0.2, cancellation.cancel)
    timer.start()
    try:
        outcome = runtime.run(
            _request(cwd, "cancel-me"),
            lambda _event: None,
            lambda _request: ApprovalDecision.DENY,
            cancellation,
        )
    finally:
        timer.cancel()

    assert outcome.status is RuntimeOutcomeStatus.CANCELED


def test_pi_rpc_fails_closed_for_unauthorized_tool_event(tmp_path: Path) -> None:
    runtime, cwd = _runtime(tmp_path)

    outcome = runtime.run(
        _request(cwd, "unauthorized"),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )

    assert outcome.status is RuntimeOutcomeStatus.FAILED
    assert outcome.error_code == "pi_protocol_error"
    assert "outside the run capability" in (outcome.error_message or "")


@pytest.mark.parametrize(
    ("prompt", "message"),
    (
        ("duplicate-tool", "duplicate tool start"),
        ("unknown-terminal", "unknown tool call"),
        ("incomplete-tool", "unfinished tool calls"),
    ),
)
def test_pi_rpc_requires_paired_stable_tool_events(
    tmp_path: Path,
    prompt: str,
    message: str,
) -> None:
    runtime, cwd = _runtime(tmp_path)

    outcome = runtime.run(
        _request(cwd, prompt),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )

    assert outcome.status is RuntimeOutcomeStatus.FAILED
    assert outcome.error_code == "pi_protocol_error"
    assert message in (outcome.error_message or "")


def test_pi_rpc_rejects_non_flash_model_before_starting_process(tmp_path: Path) -> None:
    runtime, cwd = _runtime(tmp_path)
    request = _request(cwd, "complete")
    request = replace(request, model="deepseek-v4-pro")

    outcome = runtime.run(
        request,
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )

    assert outcome.status is RuntimeOutcomeStatus.FAILED
    assert outcome.error_code == "pi_model_mismatch"


def test_pi_rpc_rejects_noncanonical_resume_identity(tmp_path: Path) -> None:
    runtime, cwd = _runtime(tmp_path)

    with pytest.raises(PiProtocolError, match="full UUID"):
        runtime.run(
            _request(cwd, "complete", thread_id="short-id"),
            lambda _event: None,
            lambda _request: ApprovalDecision.DENY,
            CancellationToken(),
        )


def test_pi_bridge_source_never_contains_bearer_token() -> None:
    source = render_pi_mcp_bridge(
        "http://127.0.0.1:8000/mcp/",
        "HXAXD_MCP_TOKEN",
        ("workspace_summary",),
    )

    assert "secret-token" not in source
    assert "process.env[TOKEN_ENV]" in source
    assert "parent?.addEventListener(\"abort\"" in source

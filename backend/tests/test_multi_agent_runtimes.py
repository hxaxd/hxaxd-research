from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path
from threading import Timer

from app.agents.claude_code import (
    ClaudeCodeRuntime,
    discover_claude_deepseek_environment,
)
from app.agents.models import ApprovalDecision
from app.agents.open_code_acp import OpenCodeAcpRuntime
from app.agents.runtime import (
    DEEPSEEK_V4_FLASH,
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
from app.platform.processes.runner import DEFAULT_ENVIRONMENT_ALLOWLIST

_THREAD_ID = "12345678-1234-4234-8234-123456789abc"

_FAKE_OPENCODE = r'''
import json
import os
import sys

args = sys.argv[1:]
assert args[:4] == ["acp", "--pure", "--cwd", os.getcwd()]
config_source = os.environ["OPENCODE_CONFIG_CONTENT"]
config = json.loads(config_source)
token = os.environ["HXAXD_MCP_TOKEN"]
assert token not in config_source
assert config["model"] == "deepseek/deepseek-v4-flash"
assert config["small_model"] == "deepseek/deepseek-v4-flash"
assert config["share"] == "disabled"
assert config["autoupdate"] is False
assert config["default_agent"] == "build"
assert config["instructions"] == []
assert config["plugin"] == []
assert config["permission"]["*"] == "deny"
assert config["permission"]["hxaxd_workspace_summary"] == "ask"
assert config["mcp"]["hxaxd"]["headers"]["Authorization"] == "Bearer {env:HXAXD_MCP_TOKEN}"

THREAD_ID = "12345678-1234-4234-8234-123456789abc"
pending_prompt = None
pending_kind = None

def send(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params", {})
    if method == "initialize":
        send({"jsonrpc":"2.0","id":request_id,"result":{"protocolVersion":1}})
    elif method == "session/new":
        send({"jsonrpc":"2.0","id":request_id,"result":{"sessionId":THREAD_ID}})
    elif method == "session/resume":
        assert params["sessionId"] == THREAD_ID
        send({"jsonrpc":"2.0","id":request_id,"result":{}})
    elif method == "session/set_config_option":
        assert params == {
            "sessionId": THREAD_ID,
            "configId": "model",
            "value": "deepseek/deepseek-v4-flash",
        }
        send({"jsonrpc":"2.0","id":request_id,"result":{"configOptions":[{
            "id":"model","currentValue":"deepseek/deepseek-v4-flash"
        }]}})
    elif method == "session/set_mode":
        assert params == {"sessionId": THREAD_ID, "modeId": "build"}
        send({"jsonrpc":"2.0","id":request_id,"result":{}})
    elif method == "session/prompt":
        prompt = params["prompt"][0]["text"]
        if prompt == "cancel-me":
            pending_prompt = request_id
            continue
        if prompt == "unauthorized-event":
            send({"jsonrpc":"2.0","method":"session/update","params":{"update":{
                "sessionUpdate":"tool_call","toolCallId":"call-bypass",
                "title":"bash","kind":"execute","status":"in_progress",
                "rawInput":{"command":"whoami"}
            }}})
            send({"jsonrpc":"2.0","id":request_id,"result":{"stopReason":"end_turn"}})
            continue
        pending_prompt = request_id
        pending_kind = prompt
        send({"jsonrpc":"2.0","method":"session/update","params":{"update":{
            "sessionUpdate":"tool_call","toolCallId":"call-private",
            "title":"Human-readable label","kind":"other","status":"in_progress",
            "rawInput":{"project":"p1"}
        }}})
        permission_options = [
            {"optionId":"reject","kind":"reject_once","name":"Reject"}
        ] if prompt == "no-allow-option" else [
            {"optionId":"once","kind":"allow_once","name":"Allow once"},
            {"optionId":"reject","kind":"reject_once","name":"Reject"}
        ]
        send({"jsonrpc":"2.0","id":900,"method":"session/request_permission","params":{
            "toolCall":{"toolCallId":"call-private","title":"hxaxd_workspace_summary",
                "kind":"other","status":"pending","rawInput":{"project":"p1"}},
            "options":permission_options
        }})
    elif request_id == 900 and method is None:
        if pending_kind == "no-allow-option":
            assert message["result"]["outcome"] == {"outcome":"cancelled"}
            continue
        assert message["result"]["outcome"] == {"outcome":"selected","optionId":"once"}
        send({"jsonrpc":"2.0","method":"session/update","params":{"update":{
            "sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"OK " + token}
        }}})
        if pending_kind != "incomplete-tool":
            send({"jsonrpc":"2.0","method":"session/update","params":{"update":{
                "sessionUpdate":"tool_call_update","toolCallId":"call-private",
                "status":"completed",
                "rawOutput":{"ok":True}
            }}})
        send({"jsonrpc":"2.0","id":pending_prompt,"result":{
            "stopReason":"end_turn","usage":{"inputTokens":3,"outputTokens":1}
        }})
    elif method == "session/cancel":
        assert pending_prompt is not None
        send({"jsonrpc":"2.0","id":pending_prompt,"result":{"stopReason":"cancelled"}})
'''

_FAKE_CLAUDE = r'''
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
assert "--bare" in args
assert args[args.index("--model") + 1] == "deepseek-v4-flash"
assert args[args.index("--effort") + 1] == "max"
assert args[args.index("--permission-mode") + 1] == "manual"
assert args[args.index("--permission-prompt-tool") + 1] == "stdio"
assert "--strict-mcp-config" in args
assert "--allowedTools=mcp__hxaxd__workspace_summary" in args
assert os.environ["ANTHROPIC_API_KEY"] == os.environ["ANTHROPIC_AUTH_TOKEN"]
assert os.environ["ANTHROPIC_BASE_URL"] == "https://api.deepseek.com/anthropic"
for name in (
    "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
):
    assert os.environ[name] == "deepseek-v4-flash"
mcp_source = Path(args[args.index("--mcp-config") + 1]).read_text(encoding="utf-8")
token = os.environ["HXAXD_MCP_TOKEN"]
assert token not in mcp_source
assert "${HXAXD_MCP_TOKEN}" in mcp_source
thread_id = (
    args[args.index("--resume") + 1]
    if "--resume" in args
    else args[args.index("--session-id") + 1]
)
waiting_prompt = None
active_prompt = None

def send(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)

def finish(*, canceled=False):
    send({
        "type":"result",
        "subtype":"error" if canceled else "success",
        "is_error":canceled,
        "result":"interrupted" if canceled else "OK " + token,
        "usage":{"input_tokens":3,"output_tokens":1},
        "modelUsage":{"deepseek-v4-flash":{"inputTokens":3,"outputTokens":1}},
    })

for line in sys.stdin:
    value = json.loads(line)
    if value.get("type") == "control_request":
        request = value["request"]
        request_id = value["request_id"]
        if request.get("subtype") == "initialize":
            send({"type":"control_response","response":{
                "subtype":"success","request_id":request_id,
                "response":{"account":{"apiKeySource":"ANTHROPIC_API_KEY"}}
            }})
        elif request.get("subtype") == "interrupt":
            send({"type":"control_response","response":{
                "subtype":"success","request_id":request_id,"response":{}
            }})
            finish(canceled=True)
    elif value.get("type") == "user":
        assert value["session_id"] == ""
        assert value["parent_tool_use_id"] is None
        prompt = value["message"]["content"]
        active_prompt = prompt
        send({"type":"system","subtype":"init","session_id":thread_id,"model":"deepseek-v4-flash"})
        if prompt == "cancel-me":
            waiting_prompt = prompt
            continue
        if prompt == "unauthorized-event":
            send({"type":"assistant","message":{"content":[{
                "type":"tool_use","id":"tool-bypass","name":"Bash",
                "input":{"command":"whoami"}
            }]}})
            continue
        if prompt == "unknown-tool-result":
            send({"type":"user","message":{"content":[{
                "type":"tool_result","tool_use_id":"unknown-call","content":{"ok":True}
            }]}})
            continue
        tool_name = "Bash" if prompt == "unknown-tool" else "mcp__hxaxd__workspace_summary"
        send({"type":"control_request","request_id":"permission-1","request":{
            "subtype":"can_use_tool","tool_name":tool_name,
            "input":{"project_id":"p1"},"title":"proof"
        }})
    elif (
        value.get("type") == "control_response"
        and value["response"]["request_id"] == "permission-1"
    ):
        behavior = value["response"]["response"]["behavior"]
        expected = "deny" if waiting_prompt == "unknown-tool" else "allow"
        # The unknown-tool branch records its prompt via the tool name instead.
        if behavior == "deny":
            assert value["response"]["response"]["message"]
        else:
            assert behavior == "allow"
        send({"type":"assistant","message":{"content":[{
            "type":"tool_use","id":"tool-private","name":"mcp__hxaxd__workspace_summary",
            "input":{"project_id":"p1"}
        }]}})
        if active_prompt != "incomplete-tool":
            send({"type":"user","message":{"content":[{
                "type":"tool_result","tool_use_id":"tool-private","content":{"ok":True}
            }]}})
        send({"type":"stream_event","event":{"type":"content_block_delta","delta":{
            "type":"text_delta","text":"OK " + token
        }}})
        finish()
'''


def _runner(identity: str) -> ProcessRunner:
    executable = Path(sys.executable).resolve()
    allowed = DEFAULT_ENVIRONMENT_ALLOWLIST | frozenset(
        {
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
            "CLAUDE_CONFIG_DIR",
            "DEEPSEEK_API_KEY",
            "OPENCODE_CONFIG_CONTENT",
            "XDG_CACHE_HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
        }
    )
    return ProcessRunner(
        ExecutableRegistry((ExecutableIdentity(identity, executable, executable.parent),)),
        allowed_environment=allowed,
    )


def _request(cwd: Path, prompt: str, *, thread_id: str | None = None) -> RuntimeRequest:
    return RuntimeRequest(
        "run-1",
        prompt,
        cwd,
        thread_id=thread_id,
        model=DEEPSEEK_V4_FLASH,
        reasoning_effort="xhigh",
        mcp=RuntimeMcpCredentials(
            "http://127.0.0.1:8765/mcp",
            "short-lived-token",
            enabled_tools=("workspace_summary",),
        ),
        timeout_seconds=10,
    )


def _runtime_root(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "runs"
    cwd = workspace / "run-1"
    cwd.mkdir(parents=True)
    return workspace, cwd


def test_opencode_acp_pins_model_isolates_config_and_redacts_events(tmp_path: Path) -> None:
    fake = tmp_path / "fake_opencode.py"
    fake.write_text(_FAKE_OPENCODE, encoding="utf-8")
    workspace, cwd = _runtime_root(tmp_path)
    runtime = OpenCodeAcpRuntime(
        _runner("opencode"),
        workspace,
        deepseek_api_key="provider-secret",
        executable="opencode",
        command_prefix=(str(fake),),
    )
    events = []

    outcome = runtime.run(
        _request(cwd, "complete"),
        events.append,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )

    assert outcome.status is RuntimeOutcomeStatus.COMPLETED
    assert outcome.thread_id == _THREAD_ID
    assert outcome.final_message == "OK [REDACTED]"
    assert "short-lived-token" not in repr(events)
    assert "short-lived-token" not in repr(outcome)
    assert all(
        event.visibility == "internal"
        for event in events
        if event.event_type in {"thread.started", "turn.started"}
    )
    assert any(event.event_type == "mcp_tool.audit.started" for event in events)
    assert any(event.event_type == "mcp_tool.audit.completed" for event in events)
    assert [event.event_type for event in events].count("tool.started") == 1


def test_opencode_acp_resume_and_cancel_are_protocol_operations(tmp_path: Path) -> None:
    fake = tmp_path / "fake_opencode.py"
    fake.write_text(_FAKE_OPENCODE, encoding="utf-8")
    workspace, cwd = _runtime_root(tmp_path)
    runtime = OpenCodeAcpRuntime(
        _runner("opencode"),
        workspace,
        deepseek_api_key="provider-secret",
        executable="opencode",
        command_prefix=(str(fake),),
        interrupt_grace_seconds=1,
    )
    resumed = runtime.run(
        _request(cwd, "complete", thread_id=_THREAD_ID),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )
    cancellation = CancellationToken()
    timer = Timer(0.2, cancellation.cancel)
    timer.start()
    try:
        canceled = runtime.run(
            _request(cwd, "cancel-me", thread_id=_THREAD_ID),
            lambda _event: None,
            lambda _request: ApprovalDecision.DENY,
            cancellation,
        )
    finally:
        timer.cancel()

    assert resumed.status is RuntimeOutcomeStatus.COMPLETED
    assert resumed.thread_id == _THREAD_ID
    assert canceled.status is RuntimeOutcomeStatus.CANCELED


def test_opencode_acp_rejects_conflicting_model_before_process_start(tmp_path: Path) -> None:
    fake = tmp_path / "fake_opencode.py"
    fake.write_text(_FAKE_OPENCODE, encoding="utf-8")
    workspace, cwd = _runtime_root(tmp_path)
    runtime = OpenCodeAcpRuntime(
        _runner("opencode"),
        workspace,
        deepseek_api_key="provider-secret",
        executable="opencode",
        command_prefix=(str(fake),),
    )

    outcome = runtime.run(
        replace(_request(cwd, "complete"), model="deepseek-v4-pro"),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )

    assert outcome.status is RuntimeOutcomeStatus.FAILED
    assert outcome.error_code == "runtime_model_conflict"


def test_opencode_acp_fails_closed_without_stable_authorized_tool_mapping(
    tmp_path: Path,
) -> None:
    fake = tmp_path / "fake_opencode.py"
    fake.write_text(_FAKE_OPENCODE, encoding="utf-8")
    workspace, cwd = _runtime_root(tmp_path)
    runtime = OpenCodeAcpRuntime(
        _runner("opencode"),
        workspace,
        deepseek_api_key="provider-secret",
        executable="opencode",
        command_prefix=(str(fake),),
    )

    outcome = runtime.run(
        _request(cwd, "unauthorized-event"),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )

    assert outcome.status is RuntimeOutcomeStatus.FAILED
    assert outcome.error_code == "opencode_protocol_error"
    assert "authorized stable tool identity" in (outcome.error_message or "")


def test_opencode_acp_requires_terminal_tool_event_and_allow_once_option(
    tmp_path: Path,
) -> None:
    fake = tmp_path / "fake_opencode.py"
    fake.write_text(_FAKE_OPENCODE, encoding="utf-8")
    workspace, cwd = _runtime_root(tmp_path)
    runtime = OpenCodeAcpRuntime(
        _runner("opencode"),
        workspace,
        deepseek_api_key="provider-secret",
        executable="opencode",
        command_prefix=(str(fake),),
    )

    incomplete = runtime.run(
        _request(cwd, "incomplete-tool"),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )
    no_allow = runtime.run(
        _request(cwd, "no-allow-option"),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )

    assert incomplete.status is RuntimeOutcomeStatus.FAILED
    assert "authorized stable tool identity" in (incomplete.error_message or "")
    assert no_allow.status is RuntimeOutcomeStatus.FAILED
    assert "one-turn approval" in (no_allow.error_message or "")


def test_claude_stream_json_pins_model_scopes_tools_and_redacts_events(tmp_path: Path) -> None:
    fake = tmp_path / "fake_claude.py"
    fake.write_text(_FAKE_CLAUDE, encoding="utf-8")
    workspace, cwd = _runtime_root(tmp_path)
    runtime = ClaudeCodeRuntime(
        _runner("claude-code"),
        workspace,
        provider_environment={
            "ANTHROPIC_AUTH_TOKEN": "provider-secret",
            "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        },
        executable="claude-code",
        command_prefix=(str(fake),),
    )
    events = []
    approvals = []

    outcome = runtime.run(
        _request(cwd, "complete"),
        events.append,
        lambda request: approvals.append(request) or ApprovalDecision.DENY,
        CancellationToken(),
    )

    assert outcome.status is RuntimeOutcomeStatus.COMPLETED
    assert outcome.final_message == "OK [REDACTED]"
    assert approvals == []
    assert "short-lived-token" not in repr(events)
    assert "short-lived-token" not in repr(outcome)
    assert all(
        event.visibility == "internal"
        for event in events
        if event.event_type in {"thread.started", "turn.started"}
    )
    assert any(event.event_type == "mcp_tool.audit.started" for event in events)
    assert any(event.event_type == "mcp_tool.audit.completed" for event in events)


def test_claude_stream_json_resume_unknown_tool_and_acknowledged_cancel(tmp_path: Path) -> None:
    fake = tmp_path / "fake_claude.py"
    fake.write_text(_FAKE_CLAUDE, encoding="utf-8")
    workspace, cwd = _runtime_root(tmp_path)
    runtime = ClaudeCodeRuntime(
        _runner("claude-code"),
        workspace,
        provider_environment={
            "ANTHROPIC_API_KEY": "provider-secret",
            "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        },
        executable="claude-code",
        command_prefix=(str(fake),),
    )
    approvals = []
    resumed = runtime.run(
        _request(cwd, "unknown-tool", thread_id=_THREAD_ID),
        lambda _event: None,
        lambda request: approvals.append(request) or ApprovalDecision.DENY,
        CancellationToken(),
    )
    cancellation = CancellationToken()
    timer = Timer(0.2, cancellation.cancel)
    timer.start()
    try:
        canceled = runtime.run(
            _request(cwd, "cancel-me", thread_id=_THREAD_ID),
            lambda _event: None,
            lambda _request: ApprovalDecision.DENY,
            cancellation,
        )
    finally:
        timer.cancel()

    assert resumed.status is RuntimeOutcomeStatus.COMPLETED
    assert resumed.thread_id == _THREAD_ID
    assert approvals[0].kind == "tool_permission"
    assert approvals[0].approvable is False
    assert canceled.status is RuntimeOutcomeStatus.CANCELED


def test_claude_stream_json_fails_closed_for_unauthorized_tool_event(
    tmp_path: Path,
) -> None:
    fake = tmp_path / "fake_claude.py"
    fake.write_text(_FAKE_CLAUDE, encoding="utf-8")
    workspace, cwd = _runtime_root(tmp_path)
    runtime = ClaudeCodeRuntime(
        _runner("claude-code"),
        workspace,
        provider_environment={
            "ANTHROPIC_API_KEY": "provider-secret",
            "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        },
        executable="claude-code",
        command_prefix=(str(fake),),
    )

    outcome = runtime.run(
        _request(cwd, "unauthorized-event"),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )

    assert outcome.status is RuntimeOutcomeStatus.FAILED
    assert outcome.error_code == "claude_code_protocol_error"
    assert "outside the run capability scope" in (outcome.error_message or "")


def test_claude_stream_json_requires_paired_tool_terminal_events(tmp_path: Path) -> None:
    fake = tmp_path / "fake_claude.py"
    fake.write_text(_FAKE_CLAUDE, encoding="utf-8")
    workspace, cwd = _runtime_root(tmp_path)
    runtime = ClaudeCodeRuntime(
        _runner("claude-code"),
        workspace,
        provider_environment={
            "ANTHROPIC_API_KEY": "provider-secret",
            "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        },
        executable="claude-code",
        command_prefix=(str(fake),),
    )

    incomplete = runtime.run(
        _request(cwd, "incomplete-tool"),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )
    unknown = runtime.run(
        _request(cwd, "unknown-tool-result"),
        lambda _event: None,
        lambda _request: ApprovalDecision.DENY,
        CancellationToken(),
    )

    assert incomplete.status is RuntimeOutcomeStatus.FAILED
    assert "unfinished tool calls" in (incomplete.error_message or "")
    assert unknown.status is RuntimeOutcomeStatus.FAILED
    assert "unknown tool call" in (unknown.error_message or "")


def test_claude_credential_discovery_never_cross_wires_provider_sources(
    tmp_path: Path,
) -> None:
    settings = tmp_path / ".claude"
    settings.mkdir()
    (settings / "settings.json").write_text(
        '{"env":{"ANTHROPIC_AUTH_TOKEN":"deepseek-secret",'
        '"ANTHROPIC_BASE_URL":"https://api.deepseek.com/anthropic"}}',
        encoding="utf-8",
    )

    discovered = discover_claude_deepseek_environment(
        environment={
            "ANTHROPIC_API_KEY": "unrelated-secret",
            "ANTHROPIC_BASE_URL": "https://openrouter.ai/api/v1/",
        },
        user_profile=tmp_path,
    )

    assert discovered["ANTHROPIC_API_KEY"] == "deepseek-secret"
    assert discovered["ANTHROPIC_AUTH_TOKEN"] == "deepseek-secret"
    assert discovered["ANTHROPIC_BASE_URL"] == "https://api.deepseek.com/anthropic"


def test_claude_credential_discovery_prefers_same_source_api_key(tmp_path: Path) -> None:
    discovered = discover_claude_deepseek_environment(
        environment={
            "ANTHROPIC_API_KEY": "current-api-key",
            "ANTHROPIC_AUTH_TOKEN": "stale-auth-token",
            "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        },
        user_profile=tmp_path,
    )

    assert discovered["ANTHROPIC_API_KEY"] == "current-api-key"
    assert discovered["ANTHROPIC_AUTH_TOKEN"] == "current-api-key"


def test_claude_runtime_drops_unapproved_provider_routing_environment(
    tmp_path: Path,
) -> None:
    workspace, _cwd = _runtime_root(tmp_path)
    runtime = ClaudeCodeRuntime(
        _runner("claude-code"),
        workspace,
        provider_environment={
            "ANTHROPIC_API_KEY": "provider-secret",
            "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "HTTPS_PROXY": "http://untrusted.invalid",
        },
    )

    assert "CLAUDE_CODE_USE_BEDROCK" not in runtime.provider_environment
    assert "HTTPS_PROXY" not in runtime.provider_environment

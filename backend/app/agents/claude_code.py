from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

from app.platform.processes import (
    CancellationToken,
    ExecutableIdentity,
    ExecutableRegistry,
    ProcessHandle,
    ProcessLogEvent,
    ProcessRunner,
    ProcessSpec,
)

from .models import ApprovalDecision
from .runtime import (
    DEEPSEEK_V4_FLASH,
    RuntimeApprovalHandler,
    RuntimeApprovalRequest,
    RuntimeEvent,
    RuntimeEventSink,
    RuntimeOutcome,
    RuntimeOutcomeStatus,
    RuntimeRequest,
    validate_runtime_mcp_credentials,
)

_MODEL_ENVIRONMENT = (
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
)


class ClaudeCodeProtocolError(RuntimeError):
    pass


def discover_claude_code_path(
    configured_path: Path | None = None,
    *,
    environment: dict[str, str] | None = None,
) -> Path:
    source = os.environ if environment is None else environment
    candidates: list[Path] = []
    if configured_path is not None:
        candidates.append(configured_path)
    if source.get("HXAXD_CLAUDE_EXECUTABLE"):
        candidates.append(Path(source["HXAXD_CLAUDE_EXECUTABLE"]))
    discovered = shutil.which("claude", path=source.get("PATH"))
    if discovered:
        candidates.append(Path(discovered))
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved.is_file():
            return resolved
    raise FileNotFoundError(
        "Claude Code executable was not found; configure HXAXD_CLAUDE_EXECUTABLE explicitly"
    )


def register_claude_code_executable(
    registry: ExecutableRegistry,
    configured_path: Path | None = None,
    *,
    environment: dict[str, str] | None = None,
    identity: str = "claude-code",
) -> Path:
    path = discover_claude_code_path(configured_path, environment=environment)
    registry.register(ExecutableIdentity(identity, path, path.parent))
    return path


def discover_claude_deepseek_environment(
    *,
    environment: dict[str, str] | None = None,
    user_profile: Path | None = None,
) -> dict[str, str]:
    """Loads only DeepSeek endpoint credentials, never the user's Claude settings."""

    source = os.environ if environment is None else environment
    profile = user_profile or Path(source.get("USERPROFILE") or Path.home())
    configured: dict[str, Any] = {}
    settings_path = profile / ".claude" / "settings.json"
    try:
        payload = json.loads(settings_path.read_text(encoding="utf-8"))
        if isinstance(payload.get("env"), dict):
            configured = payload["env"]
    except FileNotFoundError:
        pass
    except (OSError, TypeError, json.JSONDecodeError) as error:
        raise ValueError("Claude Code settings contain invalid JSON") from error

    provider = next(
        (
            candidate
            for candidate in (
                _deepseek_provider_pair(source),
                _deepseek_provider_pair(configured),
            )
            if candidate is not None
        ),
        None,
    )
    if provider is None:
        raise FileNotFoundError(
            "Claude Code DeepSeek endpoint and credential were not found in one "
            "configuration source"
        )
    credential, base_url = provider
    result: dict[str, str] = {
        # --bare only recognizes an API key as an explicit credential source. Keep
        # AUTH_TOKEN as well because DeepSeek's Anthropic-compatible endpoint accepts it.
        "ANTHROPIC_API_KEY": credential,
        "ANTHROPIC_AUTH_TOKEN": credential,
        "ANTHROPIC_BASE_URL": base_url,
    }
    for key in _MODEL_ENVIRONMENT:
        result[key] = DEEPSEEK_V4_FLASH
    return result


def _deepseek_provider_pair(source: Mapping[str, Any]) -> tuple[str, str] | None:
    base_url = source.get("ANTHROPIC_BASE_URL")
    if not isinstance(base_url, str) or not base_url.strip():
        return None
    parsed = urlparse(base_url.strip())
    hostname = (parsed.hostname or "").casefold()
    if parsed.scheme != "https" or not (
        hostname == "deepseek.com" or hostname.endswith(".deepseek.com")
    ):
        return None
    credential = source.get("ANTHROPIC_API_KEY") or source.get("ANTHROPIC_AUTH_TOKEN")
    if not isinstance(credential, str) or not credential.strip():
        return None
    return credential.strip(), base_url.strip()


@dataclass
class _ClaudeState:
    thread_id: str | None = None
    turn_id: str | None = None
    message_parts: list[str] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)
    result: dict[str, Any] | None = None
    tools: dict[str, str] = field(default_factory=dict)


@dataclass
class _ActiveSession:
    cancellation: CancellationToken


class ClaudeCodeRuntime:
    """Claude Code stream-json adapter pinned to DeepSeek V4 Flash."""

    name = "claude-code"
    version: str | None

    def __init__(
        self,
        runner: ProcessRunner,
        workspace_root: Path,
        *,
        provider_environment: dict[str, str],
        executable: str = "claude-code",
        version: str | None = None,
        command_prefix: tuple[str, ...] = (),
        inherited_environment: tuple[str, ...] | None = None,
    ) -> None:
        provider = _deepseek_provider_pair(provider_environment)
        if provider is None:
            raise ValueError("Claude Code requires a DeepSeek endpoint and credential")
        credential, base_url = provider
        self.runner = runner
        self.workspace_root = workspace_root.resolve()
        self.provider_environment = {
            "ANTHROPIC_API_KEY": credential,
            "ANTHROPIC_AUTH_TOKEN": credential,
            "ANTHROPIC_BASE_URL": base_url,
            **{key: DEEPSEEK_V4_FLASH for key in _MODEL_ENVIRONMENT},
        }
        self.executable = executable
        self.version = version
        self.command_prefix = command_prefix
        self.inherited_environment = inherited_environment or (
            "APPDATA",
            "COMSPEC",
            "LOCALAPPDATA",
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "WINDIR",
        )
        self._sessions: dict[str, _ActiveSession] = {}
        self._lock = Lock()

    def run(
        self,
        request: RuntimeRequest,
        emit: RuntimeEventSink,
        approve: RuntimeApprovalHandler,
        cancellation: CancellationToken,
    ) -> RuntimeOutcome:
        cwd = request.cwd.resolve(strict=True)
        if not _within(cwd, self.workspace_root):
            raise ClaudeCodeProtocolError("agent cwd escapes the isolated runtime root")
        if request.model not in {None, DEEPSEEK_V4_FLASH}:
            return RuntimeOutcome(
                RuntimeOutcomeStatus.FAILED,
                request.thread_id,
                None,
                error_code="runtime_model_conflict",
                error_message="Claude Code is pinned to DeepSeek V4 Flash",
            )
        if request.mcp is not None:
            try:
                validate_runtime_mcp_credentials(request.mcp)
            except ValueError as error:
                raise ClaudeCodeProtocolError(str(error)) from error

        runtime_home = cwd / ".runtime" / "claude-code"
        home = runtime_home / "home"
        state_directory = runtime_home / "state"
        home.mkdir(parents=True, exist_ok=True)
        state_directory.mkdir(parents=True, exist_ok=True)
        mcp_path = runtime_home / "mcp.json"
        mcp_path.write_text(
            json.dumps(_mcp_config(request), ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

        thread_id = request.thread_id or str(uuid4())
        turn_id = uuid4().hex
        environment = {
            **self.provider_environment,
            "HOME": str(home),
            "USERPROFILE": str(home),
            "CLAUDE_CONFIG_DIR": str(state_directory),
        }
        secret_values = tuple(
            dict.fromkeys(
                (
                    self.provider_environment["ANTHROPIC_API_KEY"],
                    self.provider_environment["ANTHROPIC_AUTH_TOKEN"],
                )
            )
        )
        if request.mcp is not None:
            environment[request.mcp.token_environment_variable] = request.mcp.bearer_token
            secret_values += (request.mcp.bearer_token,)
        argv = [
            *self.command_prefix,
            "-p",
            "--bare",
            "--disable-slash-commands",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model",
            DEEPSEEK_V4_FLASH,
            "--effort",
            _claude_effort(request.reasoning_effort),
            "--permission-mode",
            "manual",
            "--permission-prompt-tool",
            "stdio",
            "--tools=",
            "--mcp-config",
            str(mcp_path),
            "--strict-mcp-config",
        ]
        if request.mcp is not None and request.mcp.enabled_tools:
            allowed = ",".join(f"mcp__hxaxd__{tool}" for tool in request.mcp.enabled_tools)
            argv.append(f"--allowedTools={allowed}")
        if request.thread_id:
            argv.extend(("--resume", request.thread_id))
        else:
            argv.extend(("--session-id", thread_id))

        handle = self.runner.start(
            ProcessSpec(
                executable=self.executable,
                argv=tuple(argv),
                cwd=cwd,
                allowed_cwd_root=self.workspace_root,
                timeout_seconds=request.timeout_seconds,
                environment=environment,
                inherit_environment=self.inherited_environment,
                sensitive_values=secret_values,
                display_name="Claude Code stream-json",
            ),
            observer=lambda event: self._process_log(event, emit),
        )
        with self._lock:
            self._sessions[request.run_id] = _ActiveSession(cancellation)
        state = _ClaudeState(thread_id=thread_id, turn_id=turn_id)
        connection = _ClaudeConnection(
            handle,
            emit,
            approve,
            frozenset(request.mcp.enabled_tools if request.mcp is not None else ()),
            secret_values,
        )
        deadline = time.monotonic() + request.timeout_seconds
        interrupt_sent_at: float | None = None
        interrupt_request_id: str | None = None
        try:
            initialize_result = connection.request_control(
                {"subtype": "initialize", "hooks": None},
                state,
                cancellation,
                deadline,
            )
            _validate_initialize_response(initialize_result)
            emit(
                RuntimeEvent(
                    "thread.started",
                    {"thread_id": thread_id},
                    visibility="internal",
                )
            )
            emit(
                RuntimeEvent(
                    "turn.started",
                    {"turn_id": turn_id},
                    visibility="internal",
                )
            )
            handle.write_line(
                json.dumps(
                    {
                        "type": "user",
                        "session_id": "",
                        "message": {"role": "user", "content": request.prompt},
                        "parent_tool_use_id": None,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
            while state.result is None or (
                interrupt_request_id is not None
                and not connection.has_control_response(interrupt_request_id)
            ):
                now = time.monotonic()
                if cancellation.is_cancelled and interrupt_sent_at is None:
                    interrupt_request_id = connection.send_control_request(
                        {"subtype": "interrupt"}
                    )
                    interrupt_sent_at = now
                    emit(RuntimeEvent("turn.interrupt_requested", {}))
                if interrupt_sent_at is not None and now - interrupt_sent_at > 5:
                    handle.terminate()
                    return RuntimeOutcome(
                        RuntimeOutcomeStatus.CANCELED,
                        state.thread_id,
                        state.turn_id,
                        final_message="".join(state.message_parts) or None,
                        usage=state.usage,
                    )
                if time.monotonic() >= deadline:
                    handle.terminate()
                    return RuntimeOutcome(
                        RuntimeOutcomeStatus.FAILED,
                        state.thread_id,
                        state.turn_id,
                        final_message="".join(state.message_parts) or None,
                        usage=state.usage,
                        error_code="agent_timeout",
                        error_message="Claude Code turn exceeded its configured timeout",
                    )
                connection.pump(state, timeout=0.1)
            if interrupt_request_id is not None:
                interrupt_response = connection.pop_control_response(interrupt_request_id)
                if interrupt_response.get("subtype") != "success":
                    raise ClaudeCodeProtocolError("Claude Code did not acknowledge interrupt")
            result = state.result
            assert result is not None
            canceled = cancellation.is_cancelled
            if state.tools and not canceled:
                raise ClaudeCodeProtocolError(
                    "Claude Code completed with unfinished tool calls"
                )
            is_error = not canceled and (
                bool(result.get("is_error")) or result.get("subtype") != "success"
            )
            final_result = result.get("result")
            if not state.message_parts and isinstance(final_result, str):
                state.message_parts.append(final_result)
                emit(RuntimeEvent("agent.message.delta", {"delta": final_result}))
            usage = result.get("usage")
            if isinstance(usage, dict):
                state.usage = usage
            used_models = result.get("modelUsage")
            if (
                not is_error
                and (not isinstance(used_models, dict) or set(used_models) != {DEEPSEEK_V4_FLASH})
            ):
                is_error = True
                result = {
                    **result,
                    "result": "Claude Code used a model other than DeepSeek V4 Flash",
                }
            emit(
                RuntimeEvent(
                    "turn.completed",
                    {
                        "status": "canceled" if canceled else "failed" if is_error else "completed",
                        "usage": state.usage,
                    },
                )
            )
            return RuntimeOutcome(
                RuntimeOutcomeStatus.CANCELED
                if canceled
                else RuntimeOutcomeStatus.FAILED
                if is_error
                else RuntimeOutcomeStatus.COMPLETED,
                state.thread_id,
                state.turn_id,
                final_message="".join(state.message_parts) or None,
                usage=state.usage,
                error_code="claude_code_turn_failed" if is_error else None,
                error_message=(
                    str(result.get("result", "Claude Code turn failed"))[-4000:]
                    if is_error
                    else None
                ),
            )
        except (ClaudeCodeProtocolError, json.JSONDecodeError) as error:
            return RuntimeOutcome(
                RuntimeOutcomeStatus.CANCELED
                if cancellation.is_cancelled
                else RuntimeOutcomeStatus.FAILED,
                state.thread_id,
                state.turn_id,
                final_message="".join(state.message_parts) or None,
                usage=state.usage,
                error_code="claude_code_protocol_error",
                error_message=str(error),
            )
        finally:
            with self._lock:
                self._sessions.pop(request.run_id, None)
            _close_claude_process(handle)

    def interrupt(self, run_id: str) -> None:
        with self._lock:
            session = self._sessions.get(run_id)
        if session is not None:
            session.cancellation.cancel()

    @staticmethod
    def _process_log(event: ProcessLogEvent, emit: RuntimeEventSink) -> None:
        if event.stream == "stderr" and event.text.strip():
            emit(
                RuntimeEvent(
                    "runtime.stderr",
                    {"message": event.text[-1000:]},
                    visibility="internal",
                )
            )


class _ClaudeConnection:
    def __init__(
        self,
        handle: ProcessHandle,
        emit: RuntimeEventSink,
        approve: RuntimeApprovalHandler,
        enabled_tools: frozenset[str],
        secret_values: tuple[str, ...],
    ) -> None:
        self.handle = handle
        self.emit = emit
        self.approve = approve
        self.enabled_tools = enabled_tools
        self.secret_values = secret_values
        self._next_id = 1
        self._control_responses: dict[str, dict[str, Any]] = {}

    def send_control_request(self, request: dict[str, Any]) -> str:
        request_id = f"hxaxd_{self._next_id}_{uuid4().hex[:8]}"
        self._next_id += 1
        self._send(
            {
                "type": "control_request",
                "request_id": request_id,
                "request": request,
            }
        )
        return request_id

    def has_control_response(self, request_id: str) -> bool:
        return request_id in self._control_responses

    def pop_control_response(self, request_id: str) -> dict[str, Any]:
        try:
            return self._control_responses.pop(request_id)
        except KeyError as error:
            raise ClaudeCodeProtocolError("missing Claude control response") from error

    def request_control(
        self,
        request: dict[str, Any],
        state: _ClaudeState,
        cancellation: CancellationToken,
        deadline: float,
    ) -> dict[str, Any]:
        request_id = self.send_control_request(request)
        while request_id not in self._control_responses:
            if time.monotonic() >= deadline:
                raise ClaudeCodeProtocolError(
                    f"timed out waiting for Claude control request {request['subtype']}"
                )
            if cancellation.is_cancelled:
                raise ClaudeCodeProtocolError(
                    f"canceled while waiting for Claude control request {request['subtype']}"
                )
            self.pump(state, timeout=0.1)
        response = self._control_responses.pop(request_id)
        if response.get("subtype") == "error":
            raise ClaudeCodeProtocolError(str(response.get("error", "control request failed")))
        payload = response.get("response", {})
        return payload if isinstance(payload, dict) else {}

    def pump(self, state: _ClaudeState, *, timeout: float) -> None:
        line = self.handle.read_stdout_line(timeout=timeout)
        if line is None:
            if self.handle.returncode is not None:
                raise ClaudeCodeProtocolError(
                    f"Claude Code exited with {self.handle.returncode}: "
                    f"{self.handle.stderr_tail[-1000:]}"
                )
            return
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ClaudeCodeProtocolError("Claude Code emitted invalid stream JSON") from error
        if not isinstance(value, dict):
            raise ClaudeCodeProtocolError("Claude Code emitted a non-object stream event")
        value = _redact_value(value, self.secret_values)
        event_type = value.get("type")
        if event_type == "control_response":
            response = value.get("response")
            if isinstance(response, dict) and isinstance(response.get("request_id"), str):
                self._control_responses[response["request_id"]] = response
            return
        if event_type == "control_request":
            self._handle_control_request(value)
            return
        if event_type == "control_cancel_request":
            self.emit(RuntimeEvent("runtime.event", {"kind": event_type}, visibility="internal"))
            return
        _consume_stream_value(value, state, self.emit, self.enabled_tools)

    def _handle_control_request(self, value: dict[str, Any]) -> None:
        request_id = value.get("request_id")
        request = value.get("request")
        if not isinstance(request_id, str) or not isinstance(request, dict):
            raise ClaudeCodeProtocolError("Claude Code emitted an invalid control request")
        if request.get("subtype") != "can_use_tool":
            self._send_control_error(request_id, "unsupported Claude control request")
            return
        tool_name = request.get("tool_name")
        tool_input = request.get("input")
        if not isinstance(tool_name, str) or not isinstance(tool_input, dict):
            self._send_control_error(request_id, "invalid Claude tool permission request")
            return
        prefix = "mcp__hxaxd__"
        scoped_name = tool_name[len(prefix) :] if tool_name.startswith(prefix) else None
        if scoped_name in self.enabled_tools:
            response_data: dict[str, Any] = {
                "behavior": "allow",
                "updatedInput": tool_input,
            }
        else:
            decision = self.approve(
                RuntimeApprovalRequest(
                    provider_request_id=request_id,
                    kind="tool_permission",
                    summary={
                        "tool": tool_name,
                        "title": request.get("title"),
                        "description": request.get("description"),
                    },
                    approvable=False,
                )
            )
            response_data = {
                "behavior": "deny",
                "message": "tool is outside this run's capability scope",
            }
            if decision is ApprovalDecision.CANCEL:
                response_data["interrupt"] = True
        self._send(
            {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": request_id,
                    "response": response_data,
                },
            }
        )

    def _send_control_error(self, request_id: str, message: str) -> None:
        self._send(
            {
                "type": "control_response",
                "response": {
                    "subtype": "error",
                    "request_id": request_id,
                    "error": message,
                },
            }
        )

    def _send(self, value: dict[str, Any]) -> None:
        self.handle.write_line(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _consume_stream_value(
    value: dict[str, Any],
    state: _ClaudeState,
    emit: RuntimeEventSink,
    enabled_tools: frozenset[str],
) -> None:
    event_type = value.get("type")
    if event_type == "system" and value.get("subtype") == "init":
        session_id = value.get("session_id")
        if session_id != state.thread_id:
            raise ClaudeCodeProtocolError("Claude Code initialized an unexpected session")
        if value.get("model") != DEEPSEEK_V4_FLASH:
            raise ClaudeCodeProtocolError("Claude Code did not select DeepSeek V4 Flash")
        return
    if event_type == "stream_event":
        event = value.get("event")
        if not isinstance(event, dict) or event.get("type") != "content_block_delta":
            return
        delta = event.get("delta")
        if not isinstance(delta, dict):
            return
        if delta.get("type") == "text_delta" and isinstance(delta.get("text"), str):
            text = delta["text"]
            state.message_parts.append(text)
            emit(RuntimeEvent("agent.message.delta", {"delta": text}))
        elif delta.get("type") in {"thinking_delta", "signature_delta"}:
            emit(RuntimeEvent("agent.reasoning_status", {}, visibility="internal"))
        return
    if event_type == "assistant":
        message = value.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                tool_use_id = block.get("id")
                tool_name = block.get("name")
                scoped_name = (
                    tool_name.removeprefix("mcp__hxaxd__")
                    if isinstance(tool_name, str) and tool_name.startswith("mcp__hxaxd__")
                    else None
                )
                if scoped_name not in enabled_tools:
                    raise ClaudeCodeProtocolError(
                        "Claude Code emitted a tool call outside the run capability scope"
                    )
                if isinstance(tool_use_id, str) and isinstance(tool_name, str):
                    state.tools[tool_use_id] = tool_name
                event_prefix = _tool_event_prefix(tool_name)
                emit(
                    RuntimeEvent(
                        f"{event_prefix}.started",
                        {"tool": tool_name, "status": "running"},
                    )
                )
                emit(
                    RuntimeEvent(
                        "mcp_tool.audit.started",
                        {
                            "provider_tool_call_id": tool_use_id,
                            "tool": tool_name,
                            "input_sha256": _hash_payload(block.get("input")),
                        },
                        visibility="internal",
                    )
                )
        return
    if event_type == "user":
        message = value.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                tool_use_id = block.get("tool_use_id")
                if not isinstance(tool_use_id, str) or tool_use_id not in state.tools:
                    raise ClaudeCodeProtocolError(
                        "Claude Code emitted a result for an unknown tool call"
                    )
                tool_name = state.tools.pop(tool_use_id)
                event_prefix = _tool_event_prefix(tool_name)
                emit(
                    RuntimeEvent(
                        f"{event_prefix}.failed"
                        if block.get("is_error")
                        else f"{event_prefix}.completed",
                        {
                            "tool": tool_name,
                            "status": "failed" if block.get("is_error") else "completed",
                        },
                    )
                )
                emit(
                    RuntimeEvent(
                        "mcp_tool.audit.failed"
                        if block.get("is_error")
                        else "mcp_tool.audit.completed",
                        {
                            "provider_tool_call_id": tool_use_id,
                            "tool": tool_name,
                            "output_sha256": _hash_payload(block.get("content")),
                        },
                        visibility="internal",
                    )
                )
        return
    if event_type == "result":
        state.result = value


def _mcp_config(request: RuntimeRequest) -> dict[str, Any]:
    servers: dict[str, Any] = {}
    if request.mcp is not None:
        servers["hxaxd"] = {
            "type": "http",
            "url": request.mcp.url,
            "headers": {"Authorization": (f"Bearer ${{{request.mcp.token_environment_variable}}}")},
        }
    return {"mcpServers": servers}


def _validate_initialize_response(value: dict[str, Any]) -> None:
    account = value.get("account")
    if not isinstance(account, dict) or account.get("apiKeySource") != "ANTHROPIC_API_KEY":
        raise ClaudeCodeProtocolError(
            "Claude Code did not acknowledge the isolated DeepSeek API credential"
        )


def _claude_effort(value: str | None) -> str:
    if value == "xhigh":
        return "max"
    return value if value in {"low", "medium", "high", "max"} else "high"


def _tool_event_prefix(tool_name: Any) -> str:
    if isinstance(tool_name, str) and tool_name.casefold().replace("-", "_").endswith("web_search"):
        return "web_search"
    return "tool"


def _hash_payload(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


def _close_claude_process(handle: ProcessHandle) -> None:
    if handle.returncode is not None:
        handle.close()
        return
    handle.close_stdin()
    deadline = time.monotonic() + 5
    while handle.returncode is None and time.monotonic() < deadline:
        time.sleep(0.05)
    if handle.returncode is None:
        handle.terminate()
    else:
        handle.close()


def _redact_value(value: Any, secrets: tuple[str, ...]) -> Any:
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, "[REDACTED]")
        return value
    if isinstance(value, list):
        return [_redact_value(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: _redact_value(item, secrets) for key, item in value.items()}
    return value


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlparse
from uuid import UUID, uuid4

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
    RuntimeApprovalHandler,
    RuntimeApprovalRequest,
    RuntimeEvent,
    RuntimeEventSink,
    RuntimeOutcome,
    RuntimeOutcomeStatus,
    RuntimeRequest,
)

PI_PROVIDER = "deepseek"
PI_MODEL = "deepseek-v4-flash"
_PI_MODEL_ALIASES = frozenset({PI_MODEL, f"{PI_PROVIDER}/{PI_MODEL}"})
_TOOL_NAME = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SYSTEM_PROMPT = (
    "You are an embedded literature-workspace agent. Use only the explicitly enabled "
    "domain tools. Never access files, a shell, databases, credentials, or external "
    "services except through those tools. Treat the user message as the complete task "
    "context and finish with a concise factual summary."
)


class PiProtocolError(RuntimeError):
    pass


class PiModelMismatchError(PiProtocolError):
    pass


class _PiCanceled(PiProtocolError):
    pass


class _PiTimedOut(PiProtocolError):
    pass


def discover_pi_path(
    configured_path: Path | None = None,
    *,
    environment: dict[str, str] | None = None,
) -> Path:
    """Find Pi without reading or copying its authentication files."""

    source = os.environ if environment is None else environment
    candidates: list[Path] = []
    if configured_path is not None:
        candidates.append(configured_path)
    configured = source.get("HXAXD_PI_EXECUTABLE")
    if configured:
        candidates.append(Path(configured))
    user_profile = source.get("USERPROFILE")
    if user_profile:
        candidates.extend(
            (
                Path(user_profile) / ".bun" / "bin" / "pi.exe",
                Path(user_profile) / ".bun" / "bin" / "pi",
            )
        )
    discovered = shutil.which("pi", path=source.get("PATH"))
    if discovered:
        candidates.append(Path(discovered))
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved.is_file():
            return resolved
    raise FileNotFoundError("Pi executable was not found; configure HXAXD_PI_EXECUTABLE explicitly")


def register_pi_executable(
    registry: ExecutableRegistry,
    configured_path: Path | None = None,
    *,
    environment: dict[str, str] | None = None,
    identity: str = "pi",
) -> Path:
    path = discover_pi_path(configured_path, environment=environment)
    registry.register(ExecutableIdentity(identity, path, path.parent))
    return path


@dataclass
class _PiState:
    thread_id: str | None = None
    turn_id: str | None = None
    message_parts: list[str] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)
    completed: bool = False
    failed: bool = False
    canceled: bool = False
    error_message: str | None = None


@dataclass
class _ActiveSession:
    cancellation: CancellationToken


class PiRpcRuntime:
    """Pi 0.73 RPC client with a generated, capability-scoped MCP bridge."""

    name = "pi"

    def __init__(
        self,
        runner: ProcessRunner,
        workspace_root: Path,
        *,
        executable: str = "pi",
        version: str | None = None,
        command_prefix: tuple[str, ...] = (),
        inherited_environment: tuple[str, ...] | None = None,
        interrupt_grace_seconds: float = 5,
    ) -> None:
        self.runner = runner
        self.workspace_root = workspace_root.resolve()
        self.executable = executable
        self.version = version
        self.command_prefix = command_prefix
        self.inherited_environment = inherited_environment or (
            "APPDATA",
            "COMSPEC",
            "HOME",
            "LOCALAPPDATA",
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "WINDIR",
        )
        self.interrupt_grace_seconds = interrupt_grace_seconds
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
            raise PiProtocolError("agent cwd escapes the isolated runtime root")
        requested_model = request.model or PI_MODEL
        if requested_model not in _PI_MODEL_ALIASES:
            return RuntimeOutcome(
                RuntimeOutcomeStatus.FAILED,
                request.thread_id,
                None,
                error_code="pi_model_mismatch",
                error_message=(
                    f"Pi tasks are pinned to {PI_PROVIDER}/{PI_MODEL}; received {requested_model!r}"
                ),
            )
        enabled_tools: tuple[str, ...] = ()
        environment: dict[str, str] = {}
        sensitive_values: tuple[str, ...] = ()
        extension_arguments: tuple[str, ...] = ()
        if request.mcp is not None:
            _validate_mcp_credentials(
                request.mcp.url,
                request.mcp.token_environment_variable,
                request.mcp.enabled_tools,
            )
            enabled_tools = request.mcp.enabled_tools
            bridge = _write_bridge(
                cwd,
                request.mcp.url,
                request.mcp.token_environment_variable,
                enabled_tools,
            )
            environment[request.mcp.token_environment_variable] = request.mcp.bearer_token
            sensitive_values = (request.mcp.bearer_token,)
            extension_arguments = (
                "--extension",
                str(bridge),
                "--tools",
                ",".join(enabled_tools),
            )

        thinking = request.reasoning_effort or "high"
        if thinking not in {"off", "minimal", "low", "medium", "high", "xhigh"}:
            thinking = "high"
        if thinking == "xhigh":
            thinking = "high"
        session_dir = cwd / ".pi-sessions"
        session_dir.mkdir(mode=0o700, exist_ok=True)
        session_arguments = ("--session-dir", str(session_dir))
        if request.thread_id is not None:
            _validate_session_id(request.thread_id)
            session_arguments = (
                *session_arguments,
                "--session",
                request.thread_id,
            )
        tool_arguments = extension_arguments or ("--no-tools",)
        spec = ProcessSpec(
            executable=self.executable,
            argv=(
                *self.command_prefix,
                "--mode",
                "rpc",
                "--provider",
                PI_PROVIDER,
                "--model",
                PI_MODEL,
                "--thinking",
                thinking,
                *session_arguments,
                "--no-builtin-tools",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
                "--system-prompt",
                _SYSTEM_PROMPT,
                *tool_arguments,
            ),
            cwd=cwd,
            allowed_cwd_root=self.workspace_root,
            timeout_seconds=request.timeout_seconds,
            environment=environment,
            inherit_environment=self.inherited_environment,
            sensitive_values=sensitive_values,
            display_name="Pi RPC",
        )
        state = _PiState()
        handle = self.runner.start(
            spec,
            observer=lambda event: self._process_log(event, emit),
        )
        with self._lock:
            self._sessions[request.run_id] = _ActiveSession(cancellation)
        connection = _PiConnection(
            handle,
            emit,
            approve,
            enabled_tools=frozenset(enabled_tools),
            secret_values=sensitive_values,
        )
        deadline = time.monotonic() + request.timeout_seconds
        try:
            state_response = connection.request(
                "get_state",
                {},
                state,
                cancellation,
                deadline,
            )
            model = state_response.get("model")
            provider = model.get("provider") if isinstance(model, dict) else None
            model_id = model.get("id") if isinstance(model, dict) else None
            if provider != PI_PROVIDER or model_id != PI_MODEL:
                raise PiModelMismatchError(
                    "Pi reported an unexpected active model; expected "
                    f"{PI_PROVIDER}/{PI_MODEL}, received {provider}/{model_id}"
                )
            session_id = state_response.get("sessionId")
            if not isinstance(session_id, str):
                raise PiProtocolError("Pi get_state did not return a sessionId")
            _validate_session_id(session_id)
            if request.thread_id is not None and session_id != request.thread_id:
                raise PiProtocolError("Pi resumed a different session than requested")
            session_file = state_response.get("sessionFile")
            if not isinstance(session_file, str) or not session_file:
                raise PiProtocolError("Pi get_state did not return a persistent sessionFile")
            if not _within(Path(session_file).resolve(), session_dir.resolve()):
                raise PiProtocolError("Pi session file escapes the backend-owned session directory")
            state.thread_id = session_id
            state.turn_id = uuid4().hex
            emit(
                RuntimeEvent(
                    "thread.started",
                    {"thread_id": state.thread_id},
                    visibility="internal",
                )
            )
            emit(
                RuntimeEvent(
                    "turn.started",
                    {"turn_id": state.turn_id},
                    visibility="internal",
                )
            )

            accepted = connection.request(
                "prompt",
                {"message": request.prompt},
                state,
                cancellation,
                deadline,
            )
            if accepted:
                # Prompt responses normally have no data; any payload is diagnostic only.
                emit(RuntimeEvent("runtime.prompt.accepted", {}, visibility="internal"))
            while not state.completed:
                connection.pump(state, cancellation, deadline, timeout=0.1)
            status = (
                RuntimeOutcomeStatus.CANCELED
                if state.canceled or cancellation.is_cancelled
                else RuntimeOutcomeStatus.FAILED
                if state.failed
                else RuntimeOutcomeStatus.COMPLETED
            )
            return RuntimeOutcome(
                status,
                state.thread_id,
                state.turn_id,
                final_message="".join(state.message_parts) or None,
                usage=state.usage,
                error_code="pi_turn_failed" if status is RuntimeOutcomeStatus.FAILED else None,
                error_message=state.error_message,
            )
        except _PiCanceled:
            with suppress(PiProtocolError):
                connection.abort_and_drain(state, grace_seconds=self.interrupt_grace_seconds)
            return RuntimeOutcome(
                RuntimeOutcomeStatus.CANCELED,
                state.thread_id,
                state.turn_id,
                final_message="".join(state.message_parts) or None,
                usage=state.usage,
            )
        except _PiTimedOut:
            with suppress(PiProtocolError):
                connection.abort_and_drain(state, grace_seconds=self.interrupt_grace_seconds)
            return RuntimeOutcome(
                RuntimeOutcomeStatus.FAILED,
                state.thread_id,
                state.turn_id,
                final_message="".join(state.message_parts) or None,
                usage=state.usage,
                error_code="agent_timeout",
                error_message="Pi turn exceeded its configured timeout",
            )
        except PiModelMismatchError as error:
            return RuntimeOutcome(
                RuntimeOutcomeStatus.FAILED,
                state.thread_id,
                state.turn_id,
                final_message="".join(state.message_parts) or None,
                usage=state.usage,
                error_code="pi_model_mismatch",
                error_message=str(error),
            )
        except PiProtocolError as error:
            return RuntimeOutcome(
                RuntimeOutcomeStatus.CANCELED
                if cancellation.is_cancelled
                else RuntimeOutcomeStatus.FAILED,
                state.thread_id,
                state.turn_id,
                final_message="".join(state.message_parts) or None,
                usage=state.usage,
                error_code="pi_protocol_error",
                error_message=str(error),
            )
        finally:
            with self._lock:
                self._sessions.pop(request.run_id, None)
            if handle.returncode is None:
                handle.terminate()
            else:
                handle.close()

    def interrupt(self, run_id: str) -> None:
        with self._lock:
            session = self._sessions.get(run_id)
        if session is not None:
            session.cancellation.cancel()

    @staticmethod
    def _process_log(event: ProcessLogEvent, emit: RuntimeEventSink) -> None:
        if event.stream == "stderr" and event.text:
            emit(
                RuntimeEvent(
                    "runtime.stderr",
                    {"message": event.text[-2000:]},
                    visibility="internal",
                )
            )


class _PiConnection:
    def __init__(
        self,
        handle: ProcessHandle,
        emit: RuntimeEventSink,
        approve: RuntimeApprovalHandler,
        *,
        enabled_tools: frozenset[str],
        secret_values: tuple[str, ...],
    ) -> None:
        self.handle = handle
        self.emit = emit
        self.approve = approve
        self.enabled_tools = enabled_tools
        self.secret_values = tuple(
            sorted({value for value in secret_values if value}, key=len, reverse=True)
        )
        self._next_id = 1
        self._active_tool_calls: dict[str, str] = {}

    def request(
        self,
        command: str,
        payload: dict[str, Any],
        state: _PiState,
        cancellation: CancellationToken,
        deadline: float,
    ) -> dict[str, Any]:
        request_id = f"hxaxd-{self._next_id}"
        self._next_id += 1
        self._send({"id": request_id, "type": command, **payload})
        while True:
            self._guard(cancellation, deadline, command)
            message = self._read(timeout=0.1)
            if message is None:
                continue
            if message.get("type") == "response" and message.get("id") == request_id:
                if message.get("success") is not True:
                    error = str(message.get("error") or "unknown error")[-1000:]
                    raise PiProtocolError(f"Pi {command} failed: {error}")
                data = message.get("data")
                return data if isinstance(data, dict) else {}
            self._dispatch(message, state)

    def pump(
        self,
        state: _PiState,
        cancellation: CancellationToken,
        deadline: float,
        *,
        timeout: float,
    ) -> None:
        self._guard(cancellation, deadline, "turn")
        message = self._read(timeout=timeout)
        if message is not None:
            self._dispatch(message, state)

    def abort_and_drain(self, state: _PiState, *, grace_seconds: float) -> None:
        if self.handle.returncode is not None:
            return
        try:
            self._send({"id": f"hxaxd-{self._next_id}", "type": "abort"})
            self._next_id += 1
        except (BrokenPipeError, OSError):
            return
        deadline = time.monotonic() + max(grace_seconds, 0)
        while time.monotonic() < deadline and self.handle.returncode is None:
            message = self._read(timeout=min(0.1, max(deadline - time.monotonic(), 0.01)))
            if message is not None:
                self._dispatch(message, state)
            if state.completed:
                return

    def _guard(
        self,
        cancellation: CancellationToken,
        deadline: float,
        operation: str,
    ) -> None:
        if cancellation.is_cancelled:
            raise _PiCanceled(f"Pi {operation} was canceled")
        if time.monotonic() >= deadline:
            raise _PiTimedOut(f"Pi {operation} timed out")
        if self.handle.returncode is not None:
            raise PiProtocolError(
                f"Pi RPC exited with {self.handle.returncode}: "
                f"{self._redact_text(self.handle.stderr_tail[-1000:])}"
            )

    def _dispatch(self, message: dict[str, Any], state: _PiState) -> None:
        message_type = message.get("type")
        if message_type == "message_update":
            update = message.get("assistantMessageEvent")
            if not isinstance(update, dict):
                return
            update_type = update.get("type")
            if update_type == "text_delta" and isinstance(update.get("delta"), str):
                delta = update["delta"]
                state.message_parts.append(delta)
                self.emit(RuntimeEvent("agent.message.delta", {"delta": delta}))
            elif update_type in {"thinking_start", "thinking_delta", "thinking_end"}:
                self.emit(
                    RuntimeEvent(
                        "agent.reasoning_status",
                        {"status": update_type.removeprefix("thinking_")},
                        visibility="internal",
                    )
                )
            elif update_type == "error":
                reason = update.get("reason")
                state.canceled = reason == "aborted"
                state.failed = not state.canceled
                error = update.get("error")
                state.error_message = str(error)[-4000:] if error is not None else str(reason)
        elif message_type == "message_end":
            self._capture_assistant_message(message.get("message"), state)
        elif message_type == "tool_execution_start":
            self._tool_started(message)
        elif message_type == "tool_execution_end":
            self._tool_finished(message)
        elif message_type == "extension_ui_request":
            self._extension_ui(message)
        elif message_type == "extension_error":
            state.failed = True
            state.completed = True
            state.error_message = str(message.get("error") or "Pi extension failed")[-4000:]
            self.emit(
                RuntimeEvent(
                    "runtime.error",
                    {"error_code": "pi_extension_error"},
                    visibility="internal",
                )
            )
        elif message_type == "agent_end":
            messages = message.get("messages")
            if isinstance(messages, list):
                for candidate in reversed(messages):
                    if isinstance(candidate, dict) and candidate.get("role") == "assistant":
                        self._capture_assistant_message(candidate, state)
                        break
            if self._active_tool_calls and not state.canceled:
                raise PiProtocolError("Pi completed with unfinished tool calls")
            state.completed = True
            self.emit(
                RuntimeEvent(
                    "turn.completed",
                    {
                        "turn_id": state.turn_id,
                        "status": "canceled"
                        if state.canceled
                        else "failed"
                        if state.failed
                        else "completed",
                        "usage": state.usage,
                    },
                )
            )
        elif message_type in {"auto_retry_start", "auto_retry_end"}:
            self.emit(
                RuntimeEvent(
                    "runtime.retry",
                    {"status": message_type.removeprefix("auto_retry_")},
                    visibility="internal",
                )
            )

    def _capture_assistant_message(self, value: object, state: _PiState) -> None:
        if not isinstance(value, dict) or value.get("role") != "assistant":
            return
        usage = value.get("usage")
        if isinstance(usage, dict):
            state.usage = usage
            self.emit(RuntimeEvent("usage.updated", {"usage": usage}))
        stop_reason = value.get("stopReason")
        if stop_reason == "aborted":
            state.canceled = True
        elif stop_reason == "error":
            state.failed = True
            error = value.get("errorMessage")
            if isinstance(error, str):
                state.error_message = error[-4000:]
        if state.message_parts:
            return
        content = value.get("content")
        if not isinstance(content, list):
            return
        text = "".join(
            str(block.get("text", ""))
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
        if text:
            state.message_parts.append(text)
            self.emit(RuntimeEvent("agent.message.delta", {"delta": text}))

    def _tool_started(self, message: dict[str, Any]) -> None:
        tool = message.get("toolName")
        if not isinstance(tool, str) or tool not in self.enabled_tools:
            raise PiProtocolError(f"Pi attempted a tool outside the run capability: {tool!r}")
        call_id = message.get("toolCallId")
        if not isinstance(call_id, str) or not call_id:
            raise PiProtocolError("Pi tool start omitted its stable call id")
        if call_id in self._active_tool_calls:
            raise PiProtocolError("Pi emitted a duplicate tool start")
        self._active_tool_calls[call_id] = tool
        public_payload = {"tool": tool, "status": "started"}
        audit_payload = {"provider_item_id": call_id, **public_payload}
        self.emit(RuntimeEvent("tool.started", public_payload))
        self.emit(
            RuntimeEvent(
                "mcp_tool.audit.started",
                {**audit_payload, "arguments": _audit_snapshot(message.get("args"))},
                visibility="internal",
            )
        )
        if tool == "web_search":
            self.emit(RuntimeEvent("web_search.started", {}))

    def _tool_finished(self, message: dict[str, Any]) -> None:
        tool = message.get("toolName")
        if not isinstance(tool, str) or tool not in self.enabled_tools:
            raise PiProtocolError(f"Pi completed a tool outside the run capability: {tool!r}")
        call_id = message.get("toolCallId")
        if not isinstance(call_id, str) or call_id not in self._active_tool_calls:
            raise PiProtocolError("Pi emitted a terminal event for an unknown tool call")
        if self._active_tool_calls.pop(call_id) != tool:
            raise PiProtocolError("Pi changed tool identity during one tool call")
        failed = message.get("isError") is True
        suffix = "failed" if failed else "completed"
        public_payload: dict[str, Any] = {
            "tool": tool,
            "status": suffix,
        }
        if failed:
            public_payload["error_code"] = "mcp_tool_failed"
        audit_payload = {"provider_item_id": call_id, **public_payload}
        self.emit(RuntimeEvent(f"tool.{suffix}", public_payload))
        self.emit(
            RuntimeEvent(
                f"mcp_tool.audit.{suffix}",
                {**audit_payload, "result": _audit_snapshot(message.get("result"))},
                visibility="internal",
            )
        )
        if tool == "web_search":
            self.emit(RuntimeEvent(f"web_search.{suffix}", {}))

    def _extension_ui(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        request_id = message.get("id")
        interactive = method in {"confirm", "select", "input", "editor"}
        self.emit(
            RuntimeEvent(
                "runtime.extension_ui",
                {"method": method, "interactive": interactive},
                visibility="internal",
            )
        )
        if not interactive or not isinstance(request_id, str):
            return
        decision = self.approve(
            RuntimeApprovalRequest(
                provider_request_id=request_id,
                kind="extension_ui",
                summary={"method": method},
                approvable=False,
            )
        )
        if decision is ApprovalDecision.APPROVE:
            decision = ApprovalDecision.DENY
        self._send(
            {
                "type": "extension_ui_response",
                "id": request_id,
                "cancelled": True,
            }
        )

    def _read(self, *, timeout: float) -> dict[str, Any] | None:
        line = self.handle.read_stdout_line(timeout=timeout)
        if line is None:
            if self.handle.returncode is not None:
                raise PiProtocolError(
                    f"Pi RPC exited with {self.handle.returncode}: "
                    f"{self._redact_text(self.handle.stderr_tail[-1000:])}"
                )
            return None
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise PiProtocolError(
                f"invalid JSONL from Pi RPC: {self._redact_text(line[-500:])}"
            ) from error
        if not isinstance(value, dict):
            raise PiProtocolError("Pi RPC emitted a non-object JSONL message")
        return self._redact_value(value)

    def _send(self, message: dict[str, Any]) -> None:
        self.handle.write_line(json.dumps(message, ensure_ascii=False, separators=(",", ":")))

    def _redact_text(self, value: str) -> str:
        for secret in self.secret_values:
            value = value.replace(secret, "[REDACTED]")
        return value

    def _redact_value(self, value: Any) -> Any:
        if isinstance(value, str):
            return self._redact_text(value)
        if isinstance(value, list):
            return [self._redact_value(item) for item in value]
        if isinstance(value, dict):
            return {key: self._redact_value(item) for key, item in value.items()}
        return value


def render_pi_mcp_bridge(
    url: str,
    token_environment_variable: str,
    enabled_tools: tuple[str, ...],
) -> str:
    """Render a token-free Pi extension; only the process environment contains the token."""

    encoded_url = json.dumps(url, ensure_ascii=False)
    encoded_variable = json.dumps(token_environment_variable)
    encoded_tools = json.dumps(list(enabled_tools), ensure_ascii=False)
    return f"""const MCP_URL = {encoded_url};
const TOKEN_ENV = {encoded_variable};
const ENABLED_TOOLS = {encoded_tools};
const MAX_RESPONSE_CHARACTERS = 2_000_000;
let nextRequestId = 1;

function combinedSignal(parent, timeoutMs) {{
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("MCP request timed out")), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, {{ once: true }});
  return {{
    signal: controller.signal,
    dispose() {{
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    }},
  }};
}}

async function rpc(method, params, parentSignal) {{
  const token = process.env[TOKEN_ENV];
  if (!token) throw new Error("Missing scoped MCP capability token");
  const linked = combinedSignal(parentSignal, 30_000);
  try {{
    const response = await fetch(MCP_URL, {{
      method: "POST",
      headers: {{
        authorization: `Bearer ${{token}}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      }},
      body: JSON.stringify({{
        jsonrpc: "2.0",
        id: nextRequestId++,
        method,
        params,
      }}),
      signal: linked.signal,
    }});
    const declared = Number(response.headers.get("content-length") || "0");
    if (declared > MAX_RESPONSE_CHARACTERS) throw new Error("MCP response is too large");
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARACTERS) throw new Error("MCP response is too large");
    if (!response.ok) throw new Error(`MCP HTTP ${{response.status}}`);
    let payload;
    try {{ payload = JSON.parse(text); }}
    catch {{ throw new Error("MCP returned invalid JSON"); }}
    if (payload.error) throw new Error(String(payload.error.message || "MCP request failed"));
    return payload.result || {{}};
  }} finally {{
    linked.dispose();
  }}
}}

function textContent(result) {{
  const content = Array.isArray(result.content)
    ? result.content.filter((part) => part?.type === "text" || part?.type === "image")
    : [];
  if (content.length) return content;
  return [{{ type: "text", text: JSON.stringify(result.structuredContent ?? null) }}];
}}

export default async function (pi) {{
  const startup = AbortSignal.timeout(15_000);
  await rpc("initialize", {{
    protocolVersion: "2025-06-18",
    capabilities: {{}},
    clientInfo: {{ name: "hxaxd-pi-bridge", version: "1" }},
  }}, startup);
  const listed = await rpc("tools/list", {{}}, startup);
  const discovered = new Map(
    (Array.isArray(listed.tools) ? listed.tools : []).map((tool) => [tool.name, tool]),
  );
  for (const name of ENABLED_TOOLS) {{
    const definition = discovered.get(name);
    if (!definition) throw new Error(`Required MCP tool is unavailable: ${{name}}`);
    pi.registerTool({{
      name,
      label: name,
      description: String(definition.description || name),
      parameters: definition.inputSchema || {{ type: "object", properties: {{}} }},
      async execute(_toolCallId, params, signal) {{
        const result = await rpc("tools/call", {{ name, arguments: params || {{}} }}, signal);
        if (result.isError) {{
          const summary = textContent(result)
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\\n")
            .slice(0, 4_000);
          throw new Error(summary || `MCP tool failed: ${{name}}`);
        }}
        return {{
          content: textContent(result),
          details: result.structuredContent ?? null,
        }};
      }},
    }});
  }}
  pi.on("session_start", () => pi.setActiveTools([...ENABLED_TOOLS]));
  pi.on("tool_call", (event) => {{
    if (!ENABLED_TOOLS.includes(event.toolName)) {{
      return {{ block: true, reason: "Tool is outside the run capability" }};
    }}
  }});
}}
"""


def _write_bridge(
    cwd: Path,
    url: str,
    token_environment_variable: str,
    enabled_tools: tuple[str, ...],
) -> Path:
    source = render_pi_mcp_bridge(url, token_environment_variable, enabled_tools)
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]
    path = cwd / f".hxaxd-pi-mcp-{digest}.ts"
    if path.exists():
        if path.read_text(encoding="utf-8") != source:
            raise PiProtocolError("existing Pi MCP bridge failed its content check")
        return path
    try:
        with path.open("x", encoding="utf-8", newline="\n") as target:
            target.write(source)
        with suppress(OSError):
            path.chmod(0o600)
    except FileExistsError:
        if path.read_text(encoding="utf-8") != source:
            raise PiProtocolError("concurrent Pi MCP bridge failed its content check") from None
    return path


def _validate_mcp_credentials(
    url: str,
    environment_variable: str,
    enabled_tools: tuple[str, ...],
) -> None:
    if environment_variable != "HXAXD_MCP_TOKEN":
        raise PiProtocolError("the MCP token must use the dedicated HXAXD_MCP_TOKEN variable")
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise PiProtocolError("the scoped MCP server must use a loopback HTTP endpoint")
    if parsed.username is not None or parsed.password is not None or parsed.fragment:
        raise PiProtocolError("the scoped MCP URL contains forbidden credentials or fragments")
    if not enabled_tools:
        raise PiProtocolError("the scoped Pi MCP bridge requires at least one enabled tool")
    if len(set(enabled_tools)) != len(enabled_tools):
        raise PiProtocolError("the scoped Pi MCP bridge contains duplicate tool names")
    invalid = [name for name in enabled_tools if _TOOL_NAME.fullmatch(name) is None]
    if invalid:
        raise PiProtocolError(f"the scoped Pi MCP bridge contains invalid tools: {invalid!r}")


def _validate_session_id(value: str) -> None:
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as error:
        raise PiProtocolError("Pi session identity must be a full UUID") from error
    if str(parsed) != value.casefold():
        raise PiProtocolError("Pi session identity must use the canonical full UUID form")


def _audit_snapshot(value: Any, *, preview_characters: int = 4_000) -> dict[str, Any]:
    try:
        serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        serialized = repr(value)
    return {
        "sha256": hashlib.sha256(serialized.encode("utf-8", errors="replace")).hexdigest(),
        "characters": len(serialized),
        "truncated": len(serialized) > preview_characters,
        "preview": serialized[:preview_characters],
    }


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Any
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

_OPENCODE_MODEL_ID = f"deepseek/{DEEPSEEK_V4_FLASH}"
_RESERVED_MCP_SERVER_NAME = "hxaxd"


class OpenCodeProtocolError(RuntimeError):
    pass


def discover_opencode_path(
    configured_path: Path | None = None,
    *,
    environment: dict[str, str] | None = None,
) -> Path:
    source = os.environ if environment is None else environment
    candidates: list[Path] = []
    if configured_path is not None:
        candidates.append(configured_path)
    if source.get("HXAXD_OPENCODE_EXECUTABLE"):
        candidates.append(Path(source["HXAXD_OPENCODE_EXECUTABLE"]))
    discovered = shutil.which("opencode", path=source.get("PATH"))
    if discovered:
        candidates.append(Path(discovered))
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved.is_file():
            return resolved
    raise FileNotFoundError(
        "OpenCode executable was not found; configure HXAXD_OPENCODE_EXECUTABLE explicitly"
    )


def register_opencode_executable(
    registry: ExecutableRegistry,
    configured_path: Path | None = None,
    *,
    environment: dict[str, str] | None = None,
    identity: str = "opencode",
) -> Path:
    path = discover_opencode_path(configured_path, environment=environment)
    registry.register(ExecutableIdentity(identity, path, path.parent))
    return path


def discover_opencode_deepseek_key(
    *,
    environment: dict[str, str] | None = None,
    user_profile: Path | None = None,
) -> str:
    """Reads an existing credential without copying or rewriting OpenCode state."""

    source = os.environ if environment is None else environment
    direct = source.get("DEEPSEEK_API_KEY", "").strip()
    if direct:
        return direct
    profile = user_profile or Path(source.get("USERPROFILE") or Path.home())
    auth_path = profile / ".local" / "share" / "opencode" / "auth.json"
    try:
        payload = json.loads(auth_path.read_text(encoding="utf-8"))
        credential = payload["deepseek"]
        if credential.get("type") != "api":
            raise ValueError("DeepSeek credential is not an API credential")
        key = credential["key"]
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise FileNotFoundError(
            "OpenCode DeepSeek credential was not found; run `opencode auth login` first"
        ) from error
    if not isinstance(key, str) or not key.strip():
        raise FileNotFoundError("OpenCode DeepSeek credential is empty")
    return key.strip()


@dataclass
class _AcpState:
    thread_id: str | None = None
    turn_id: str | None = None
    message_parts: list[str] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)


@dataclass
class _ActiveSession:
    cancellation: CancellationToken


class OpenCodeAcpRuntime:
    """ACP JSON-RPC client with an isolated OpenCode home and capability MCP only."""

    name = "opencode"
    version: str | None

    def __init__(
        self,
        runner: ProcessRunner,
        workspace_root: Path,
        *,
        deepseek_api_key: str,
        executable: str = "opencode",
        version: str | None = None,
        command_prefix: tuple[str, ...] = (),
        inherited_environment: tuple[str, ...] | None = None,
        interrupt_grace_seconds: float = 5,
    ) -> None:
        if not deepseek_api_key.strip():
            raise ValueError("OpenCode requires a DeepSeek API key")
        self.runner = runner
        self.workspace_root = workspace_root.resolve()
        self.deepseek_api_key = deepseek_api_key
        self.executable = executable
        self.version = version
        self.command_prefix = command_prefix
        self.inherited_environment = inherited_environment or (
            "COMSPEC",
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
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
            raise OpenCodeProtocolError("agent cwd escapes the isolated runtime root")
        if request.model not in {None, DEEPSEEK_V4_FLASH, _OPENCODE_MODEL_ID}:
            return _failed(
                request, "runtime_model_conflict", "OpenCode is pinned to DeepSeek V4 Flash"
            )
        if request.mcp is not None:
            try:
                validate_runtime_mcp_credentials(request.mcp)
            except ValueError as error:
                raise OpenCodeProtocolError(str(error)) from error

        runtime_home = cwd / ".runtime" / "opencode"
        directories = {
            "home": runtime_home / "home",
            "config": runtime_home / "config",
            "data": runtime_home / "data",
            "cache": runtime_home / "cache",
        }
        for directory in directories.values():
            directory.mkdir(parents=True, exist_ok=True)
        config = _isolated_config(request)
        environment = {
            "HOME": str(directories["home"]),
            "USERPROFILE": str(directories["home"]),
            "XDG_CONFIG_HOME": str(directories["config"]),
            "XDG_DATA_HOME": str(directories["data"]),
            "XDG_CACHE_HOME": str(directories["cache"]),
            "OPENCODE_CONFIG_CONTENT": json.dumps(
                config, ensure_ascii=False, separators=(",", ":")
            ),
            "DEEPSEEK_API_KEY": self.deepseek_api_key,
        }
        secret_values = (self.deepseek_api_key,)
        if request.mcp is not None:
            environment[request.mcp.token_environment_variable] = request.mcp.bearer_token
            secret_values += (request.mcp.bearer_token,)

        handle = self.runner.start(
            ProcessSpec(
                executable=self.executable,
                argv=(*self.command_prefix, "acp", "--pure", "--cwd", str(cwd)),
                cwd=cwd,
                allowed_cwd_root=self.workspace_root,
                timeout_seconds=request.timeout_seconds,
                environment=environment,
                inherit_environment=self.inherited_environment,
                sensitive_values=secret_values,
                display_name="OpenCode ACP",
            ),
            observer=lambda event: self._process_log(event, emit),
        )
        with self._lock:
            self._sessions[request.run_id] = _ActiveSession(cancellation)
        connection = _AcpConnection(
            handle,
            emit,
            approve,
            frozenset(request.mcp.enabled_tools if request.mcp is not None else ()),
            secret_values,
        )
        state = _AcpState(thread_id=request.thread_id)
        deadline = time.monotonic() + request.timeout_seconds
        interrupt_sent_at: float | None = None
        try:
            initialized = connection.request(
                "initialize",
                {
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": {"readTextFile": False, "writeTextFile": False},
                        "terminal": False,
                    },
                    "clientInfo": {
                        "name": "hxaxd-literature-workspace",
                        "version": "0.1.0",
                    },
                },
                state,
                cancellation,
                deadline,
            )
            if initialized.get("protocolVersion") != 1:
                raise OpenCodeProtocolError("OpenCode negotiated an unsupported ACP version")
            session_params = {"cwd": str(cwd), "mcpServers": []}
            if request.thread_id:
                session_result = connection.request(
                    "session/resume",
                    {**session_params, "sessionId": request.thread_id},
                    state,
                    cancellation,
                    deadline,
                )
                state.thread_id = request.thread_id
            else:
                session_result = connection.request(
                    "session/new",
                    session_params,
                    state,
                    cancellation,
                    deadline,
                )
                state.thread_id = _string(session_result.get("sessionId"))
            if not state.thread_id:
                raise OpenCodeProtocolError("OpenCode did not return an ACP session id")
            model_result = connection.request(
                "session/set_config_option",
                {
                    "sessionId": state.thread_id,
                    "configId": "model",
                    "value": _OPENCODE_MODEL_ID,
                },
                state,
                cancellation,
                deadline,
            )
            _validate_selected_model(model_result)
            connection.request(
                "session/set_mode",
                {"sessionId": state.thread_id, "modeId": "build"},
                state,
                cancellation,
                deadline,
            )
            emit(
                RuntimeEvent(
                    "thread.started",
                    {"thread_id": state.thread_id},
                    visibility="internal",
                )
            )

            state.turn_id = uuid4().hex
            emit(
                RuntimeEvent(
                    "turn.started",
                    {"turn_id": state.turn_id},
                    visibility="internal",
                )
            )
            prompt_request_id = connection.send_request(
                "session/prompt",
                {
                    "sessionId": state.thread_id,
                    "prompt": [{"type": "text", "text": request.prompt}],
                },
            )
            result: dict[str, Any] | None = None
            while result is None:
                now = time.monotonic()
                if cancellation.is_cancelled and interrupt_sent_at is None:
                    connection.notify("session/cancel", {"sessionId": state.thread_id})
                    interrupt_sent_at = now
                    emit(RuntimeEvent("turn.interrupt_requested", {}))
                if (
                    interrupt_sent_at is not None
                    and now - interrupt_sent_at > self.interrupt_grace_seconds
                ):
                    handle.terminate()
                    return RuntimeOutcome(
                        RuntimeOutcomeStatus.CANCELED,
                        state.thread_id,
                        state.turn_id,
                        final_message="".join(state.message_parts) or None,
                        usage=state.usage,
                    )
                if now >= deadline:
                    handle.terminate()
                    return RuntimeOutcome(
                        RuntimeOutcomeStatus.FAILED,
                        state.thread_id,
                        state.turn_id,
                        final_message="".join(state.message_parts) or None,
                        usage=state.usage,
                        error_code="agent_timeout",
                        error_message="OpenCode ACP turn exceeded its configured timeout",
                    )
                result = connection.pump_for_response(prompt_request_id, state, timeout=0.1)
            stop_reason = str(result.get("stopReason", ""))
            usage = result.get("usage")
            if isinstance(usage, dict):
                state.usage = usage
            canceled = cancellation.is_cancelled or stop_reason in {"cancelled", "canceled"}
            if not canceled:
                connection.assert_tools_resolved()
            failed = not canceled and stop_reason != "end_turn"
            emit(
                RuntimeEvent(
                    "turn.completed",
                    {
                        "status": "canceled" if canceled else "failed" if failed else "completed",
                        "usage": state.usage,
                    },
                )
            )
            return RuntimeOutcome(
                RuntimeOutcomeStatus.CANCELED
                if canceled
                else RuntimeOutcomeStatus.FAILED
                if failed
                else RuntimeOutcomeStatus.COMPLETED,
                state.thread_id,
                state.turn_id,
                final_message="".join(state.message_parts) or None,
                usage=state.usage,
                error_code="opencode_turn_failed" if failed else None,
                error_message=(
                    f"OpenCode ACP turn stopped with {stop_reason or 'an unknown reason'}"
                    if failed
                    else None
                ),
            )
        except OpenCodeProtocolError as error:
            return RuntimeOutcome(
                RuntimeOutcomeStatus.CANCELED
                if cancellation.is_cancelled
                else RuntimeOutcomeStatus.FAILED,
                state.thread_id,
                state.turn_id,
                final_message="".join(state.message_parts) or None,
                usage=state.usage,
                error_code="opencode_protocol_error",
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
        if event.stream == "stderr" and event.text.strip():
            emit(
                RuntimeEvent(
                    "runtime.stderr",
                    {"message": event.text[-1000:]},
                    visibility="internal",
                )
            )


class _AcpConnection:
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
        self._authorized_tool_calls: dict[str, str] = {}
        self._pending_tool_updates: dict[str, list[dict[str, Any]]] = {}
        self._active_tool_calls: dict[str, str] = {}

    def request(
        self,
        method: str,
        params: dict[str, Any],
        state: _AcpState,
        cancellation: CancellationToken,
        deadline: float,
    ) -> dict[str, Any]:
        request_id = self.send_request(method, params)
        while True:
            if time.monotonic() >= deadline:
                raise OpenCodeProtocolError(f"timed out waiting for {method}")
            if cancellation.is_cancelled:
                raise OpenCodeProtocolError(f"canceled while waiting for {method}")
            result = self.pump_for_response(request_id, state, timeout=0.1)
            if result is not None:
                return result

    def send_request(self, method: str, params: dict[str, Any]) -> int:
        request_id = self._next_id
        self._next_id += 1
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        return request_id

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def pump_for_response(
        self,
        request_id: int,
        state: _AcpState,
        *,
        timeout: float,
    ) -> dict[str, Any] | None:
        message = self._read(timeout=timeout)
        if message is None:
            if self.handle.returncode is not None:
                raise OpenCodeProtocolError(
                    f"OpenCode exited with {self.handle.returncode}: "
                    f"{self.handle.stderr_tail[-1000:]}"
                )
            return None
        if message.get("id") == request_id and "method" not in message:
            if "error" in message:
                error = message["error"]
                detail = error.get("message", error) if isinstance(error, dict) else error
                raise OpenCodeProtocolError(f"ACP request failed: {detail}")
            result = message.get("result", {})
            return result if isinstance(result, dict) else {}
        self._dispatch(message, state)
        return None

    def _dispatch(self, message: dict[str, Any], state: _AcpState) -> None:
        method = message.get("method")
        params = message.get("params")
        if not isinstance(method, str):
            return
        if not isinstance(params, dict):
            params = {}
        if "id" in message:
            self._handle_agent_request(message["id"], method, params, state)
            return
        if method != "session/update":
            self.emit(
                RuntimeEvent(
                    "runtime.event",
                    {"method": method},
                    visibility="internal",
                )
            )
            return
        update = params.get("update")
        if not isinstance(update, dict):
            return
        if update.get("sessionUpdate") in {"tool_call", "tool_call_update"}:
            tool_call_id = update.get("toolCallId")
            if not isinstance(tool_call_id, str) or not tool_call_id:
                raise OpenCodeProtocolError("OpenCode emitted a tool event without a stable id")
            tool_name = self._authorized_tool_calls.get(tool_call_id)
            if tool_name is None:
                pending = self._pending_tool_updates.setdefault(tool_call_id, [])
                if len(pending) >= 32:
                    raise OpenCodeProtocolError("OpenCode emitted too many unverified tool events")
                pending.append(update)
                return
            self._emit_update(update, state, tool_name=tool_name)
            if update.get("status") in {"completed", "failed", "cancelled", "canceled"}:
                self._authorized_tool_calls.pop(tool_call_id, None)
            return
        self._emit_update(update, state)

    def _emit_update(
        self,
        update: dict[str, Any],
        state: _AcpState,
        *,
        tool_name: str | None = None,
    ) -> None:
        emit_public_event = True
        if update.get("sessionUpdate") in {"tool_call", "tool_call_update"}:
            tool_call_id = update.get("toolCallId")
            if not isinstance(tool_call_id, str) or tool_name is None:
                raise OpenCodeProtocolError("OpenCode emitted an unverifiable tool event")
            terminal = update.get("status") in {
                "completed",
                "failed",
                "cancelled",
                "canceled",
            }
            active_name = self._active_tool_calls.get(tool_call_id)
            if terminal:
                if active_name is None:
                    raise OpenCodeProtocolError(
                        "OpenCode emitted a terminal event for an unknown tool call"
                    )
                if active_name != tool_name:
                    raise OpenCodeProtocolError(
                        "OpenCode changed tool identity during one tool call"
                    )
                self._active_tool_calls.pop(tool_call_id, None)
            elif active_name is None:
                self._active_tool_calls[tool_call_id] = tool_name
            elif active_name != tool_name:
                raise OpenCodeProtocolError(
                    "OpenCode changed tool identity during one tool call"
                )
            else:
                emit_public_event = False
        event = normalize_acp_update(update, tool_name=tool_name)
        audit = _acp_tool_audit_event(update, tool_name=tool_name)
        if not emit_public_event:
            return
        if audit is not None:
            self.emit(audit)
        if event is None:
            return
        if event.event_type == "agent.message.delta":
            delta = event.payload.get("delta")
            if isinstance(delta, str):
                state.message_parts.append(delta)
        elif event.event_type == "usage.updated":
            state.usage = dict(event.payload)
        self.emit(event)

    def assert_tools_resolved(self) -> None:
        if (
            self._pending_tool_updates
            or self._authorized_tool_calls
            or self._active_tool_calls
        ):
            raise OpenCodeProtocolError(
                "OpenCode emitted a tool call without an authorized stable tool identity"
            )

    def _handle_agent_request(
        self,
        request_id: int | str,
        method: str,
        params: dict[str, Any],
        state: _AcpState,
    ) -> None:
        if method != "session/request_permission":
            self._send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32601, "message": f"unsupported ACP request: {method}"},
                }
            )
            return
        tool_call = params.get("toolCall")
        if not isinstance(tool_call, dict):
            tool_call = {}
        options = params.get("options")
        if not isinstance(options, list):
            options = []
        tool_call_id = tool_call.get("toolCallId")
        title = tool_call.get("title")
        provider_names = {f"hxaxd_{name}": name for name in self.enabled_tools}
        scoped_name = provider_names.get(title) if tool_call.get("kind") == "other" else None
        allowed = isinstance(tool_call_id, str) and scoped_name is not None
        decision = ApprovalDecision.APPROVE
        if not allowed:
            decision = self.approve(
                RuntimeApprovalRequest(
                    provider_request_id=str(request_id),
                    kind="tool_permission",
                    summary={"title": title, "kind": tool_call.get("kind")},
                    approvable=False,
                )
            )
        outcome: dict[str, Any] = {"outcome": "cancelled"}
        desired_kinds = (
            {"allow_once"}
            if allowed
            else {"reject_once", "reject_always"}
            if decision is not ApprovalDecision.CANCEL
            else set()
        )
        selected = next(
            (
                option
                for option in options
                if isinstance(option, dict)
                and option.get("kind") in desired_kinds
                and isinstance(option.get("optionId"), str)
            ),
            None,
        )
        if selected is not None:
            outcome = {"outcome": "selected", "optionId": selected["optionId"]}
        self._send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"outcome": outcome},
            }
        )
        if not allowed or selected is None:
            raise OpenCodeProtocolError(
                "OpenCode requested a tool outside the run capability scope"
                if not allowed
                else "OpenCode did not offer one-turn approval for a scoped tool"
            )
        assert isinstance(tool_call_id, str)
        assert scoped_name is not None
        self._authorized_tool_calls[tool_call_id] = scoped_name
        pending = self._pending_tool_updates.pop(tool_call_id, [])
        for update in pending:
            self._emit_update(update, state, tool_name=scoped_name)
            if update.get("status") in {"completed", "failed", "cancelled", "canceled"}:
                self._authorized_tool_calls.pop(tool_call_id, None)

    def _read(self, *, timeout: float) -> dict[str, Any] | None:
        line = self.handle.read_stdout_line(timeout=timeout)
        if line is None:
            return None
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise OpenCodeProtocolError(
                f"invalid JSONL from OpenCode ACP: {self._redact_text(line[-500:])}"
            ) from error
        if not isinstance(value, dict):
            raise OpenCodeProtocolError("OpenCode ACP emitted a non-object JSONL message")
        return self._redact_value(value)

    def _send(self, value: dict[str, Any]) -> None:
        self.handle.write_line(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

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


def normalize_acp_update(
    update: dict[str, Any],
    *,
    tool_name: str | None = None,
) -> RuntimeEvent | None:
    kind = update.get("sessionUpdate")
    if kind == "agent_message_chunk":
        content = update.get("content")
        delta = content.get("text", "") if isinstance(content, dict) else ""
        return RuntimeEvent("agent.message.delta", {"delta": delta})
    if kind == "agent_thought_chunk":
        return RuntimeEvent("agent.reasoning_status", {}, visibility="internal")
    if kind == "usage_update":
        usage = {key: update[key] for key in ("used", "size", "cost") if key in update}
        return RuntimeEvent("usage.updated", usage)
    if kind in {"tool_call", "tool_call_update"}:
        status = str(update.get("status", "pending"))
        suffix = {
            "completed": "completed",
            "failed": "failed",
            "cancelled": "failed",
            "canceled": "failed",
        }.get(status, "started")
        tool = tool_name or update.get("title")
        event_prefix = (
            "web_search"
            if isinstance(tool, str) and tool.casefold().replace("-", "_").endswith("web_search")
            else "tool"
        )
        return RuntimeEvent(
            f"{event_prefix}.{suffix}",
            {
                "tool": tool,
                "kind": update.get("kind"),
                "status": status,
            },
        )
    if kind == "plan":
        return RuntimeEvent("plan.updated", {"entries": update.get("entries", [])})
    if kind in {"available_commands_update", "config_option_update", "current_mode_update"}:
        return RuntimeEvent("runtime.event", {"kind": kind}, visibility="internal")
    return None


def _isolated_config(request: RuntimeRequest) -> dict[str, Any]:
    permission: dict[str, str] = {"*": "deny"}
    config: dict[str, Any] = {
        "$schema": "https://opencode.ai/config.json",
        "model": _OPENCODE_MODEL_ID,
        "small_model": _OPENCODE_MODEL_ID,
        "instructions": [],
        "plugin": [],
        "permission": permission,
        "share": "disabled",
        "autoupdate": False,
        "default_agent": "build",
    }
    if request.mcp is not None:
        config["mcp"] = {
            _RESERVED_MCP_SERVER_NAME: {
                "type": "remote",
                "url": request.mcp.url,
                "headers": {
                    "Authorization": (f"Bearer {{env:{request.mcp.token_environment_variable}}}")
                },
                "enabled": True,
            }
        }
        for tool in request.mcp.enabled_tools:
            permission[f"{_RESERVED_MCP_SERVER_NAME}_{tool}"] = "ask"
    return config


def _validate_selected_model(result: dict[str, Any]) -> None:
    options = result.get("configOptions")
    if not isinstance(options, list):
        raise OpenCodeProtocolError("OpenCode returned invalid ACP config options")
    model = next(
        (item for item in options if isinstance(item, dict) and item.get("id") == "model"),
        None,
    )
    if model is None or model.get("currentValue") != _OPENCODE_MODEL_ID:
        raise OpenCodeProtocolError("OpenCode did not select DeepSeek V4 Flash")


def _failed(request: RuntimeRequest, code: str, message: str) -> RuntimeOutcome:
    return RuntimeOutcome(
        RuntimeOutcomeStatus.FAILED,
        request.thread_id,
        None,
        error_code=code,
        error_message=message,
    )


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _hash_payload(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


def _acp_tool_audit_event(
    update: dict[str, Any],
    *,
    tool_name: str | None = None,
) -> RuntimeEvent | None:
    if update.get("sessionUpdate") not in {"tool_call", "tool_call_update"}:
        return None
    tool_call_id = update.get("toolCallId")
    status = str(update.get("status", "pending"))
    suffix = {
        "completed": "completed",
        "failed": "failed",
        "cancelled": "failed",
        "canceled": "failed",
    }.get(status, "started")
    return RuntimeEvent(
        f"mcp_tool.audit.{suffix}",
        {
            "provider_tool_call_id": tool_call_id,
            "tool": tool_name or update.get("title"),
            "status": update.get("status"),
            "input_sha256": _hash_payload(update.get("rawInput")),
            "output_sha256": _hash_payload(update.get("rawOutput")),
        },
        visibility="internal",
    )

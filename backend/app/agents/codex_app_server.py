from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from threading import Lock
from typing import Any

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
    WEB_SEARCH_SCOPE,
    RuntimeApprovalHandler,
    RuntimeApprovalRequest,
    RuntimeEvent,
    RuntimeEventSink,
    RuntimeOutcome,
    RuntimeOutcomeStatus,
    RuntimeRequest,
    validate_runtime_mcp_credentials,
)


class CodexProtocolError(RuntimeError):
    pass


class CodexWebSearchMode(StrEnum):
    """Native Responses web-search modes understood by Codex configuration."""

    DISABLED = "disabled"
    LIVE = "live"


_DISABLED_CODEX_FEATURES = (
    "apps",
    "auth_elicitation",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "code_mode_host",
    "computer_use",
    "goals",
    "guardian_approval",
    "hooks",
    "image_generation",
    "in_app_browser",
    "multi_agent",
    "plugin_sharing",
    "plugins",
    "remote_plugin",
    "shell_snapshot",
    "shell_tool",
    "skill_mcp_dependency_install",
    "skill_search",
    "tool_call_mcp_elicitation",
    "tool_suggest",
    "workspace_dependencies",
)
_RESERVED_MCP_SERVER_NAME = "hxaxd"


def discover_codex_path(
    configured_path: Path | None = None,
    *,
    environment: dict[str, str] | None = None,
) -> Path:
    """Discovers the binary without inspecting or copying Codex authentication state."""

    source = os.environ if environment is None else environment
    candidates: list[Path] = []
    if configured_path is not None:
        candidates.append(configured_path)
    if source.get("HXAXD_CODEX_EXECUTABLE"):
        candidates.append(Path(source["HXAXD_CODEX_EXECUTABLE"]))
    user_profile = source.get("USERPROFILE")
    if user_profile:
        extensions = Path(user_profile) / ".vscode" / "extensions"
        candidates.extend(
            sorted(
                extensions.glob("openai.chatgpt-*-win32-x64/bin/windows-x86_64/codex.exe"),
                key=lambda path: path.parent.parent.parent.parent.name,
                reverse=True,
            )
        )
    discovered = shutil.which("codex", path=source.get("PATH"))
    if discovered:
        candidates.append(Path(discovered))
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved.is_file():
            return resolved
    raise FileNotFoundError(
        "Codex executable was not found; configure HXAXD_CODEX_EXECUTABLE explicitly"
    )


def register_codex_executable(
    registry: ExecutableRegistry,
    configured_path: Path | None = None,
    *,
    environment: dict[str, str] | None = None,
    identity: str = "codex",
) -> Path:
    path = discover_codex_path(configured_path, environment=environment)
    registry.register(ExecutableIdentity(identity, path, path.parent))
    return path


@dataclass
class _ProtocolState:
    thread_id: str | None = None
    turn_id: str | None = None
    message_parts: list[str] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)
    completed: dict[str, Any] | None = None


@dataclass
class _ActiveSession:
    cancellation: CancellationToken


class CodexAppServerRuntime:
    """Codex App Server JSONL client; deliberately does not parse the terminal UI."""

    name = "codex"

    def __init__(
        self,
        runner: ProcessRunner,
        workspace_root: Path,
        *,
        executable: str = "codex",
        version: str | None = None,
        command_prefix: tuple[str, ...] = (),
        inherited_environment: tuple[str, ...] | None = None,
        approvable_kinds: frozenset[str] = frozenset(),
        interrupt_grace_seconds: float = 5,
        web_search: CodexWebSearchMode | str = CodexWebSearchMode.LIVE,
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
        self.approvable_kinds = approvable_kinds
        self.interrupt_grace_seconds = interrupt_grace_seconds
        self.web_search = CodexWebSearchMode(web_search)
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
            raise CodexProtocolError("agent cwd escapes the isolated runtime root")
        effective_web_search = (
            self.web_search
            if WEB_SEARCH_SCOPE in request.tool_scopes
            else CodexWebSearchMode.DISABLED
        )
        configured_mcp_servers = self._disabled_mcp_server_config(
            cwd,
            cancellation,
            request.timeout_seconds,
        )
        process_environment: dict[str, str] = {}
        secret_values: tuple[str, ...] = ()
        if request.mcp is not None:
            try:
                validate_runtime_mcp_credentials(request.mcp)
            except ValueError as error:
                raise CodexProtocolError(str(error)) from error
            process_environment[request.mcp.token_environment_variable] = request.mcp.bearer_token
            secret_values = (request.mcp.bearer_token,)
        spec = ProcessSpec(
            executable=self.executable,
            argv=(
                *self.command_prefix,
                "app-server",
                "--listen",
                "stdio://",
                "--strict-config",
                "-c",
                "project_doc_max_bytes=0",
                "-c",
                f'web_search="{effective_web_search.value}"',
            ),
            cwd=cwd,
            allowed_cwd_root=self.workspace_root,
            timeout_seconds=request.timeout_seconds,
            environment=process_environment,
            inherit_environment=self.inherited_environment,
            sensitive_values=secret_values,
            display_name="Codex App Server",
        )
        handle = self.runner.start(
            spec,
            observer=lambda event: self._process_log(event, emit),
        )
        with self._lock:
            self._sessions[request.run_id] = _ActiveSession(cancellation)
        connection = _CodexConnection(
            handle,
            emit,
            approve,
            self.approvable_kinds,
            secret_values,
        )
        state = _ProtocolState(thread_id=request.thread_id)
        deadline = time.monotonic() + request.timeout_seconds
        interrupt_sent_at: float | None = None
        try:
            initialize_result = connection.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "hxaxd_literature_workspace",
                        "title": "Hxaxd Literature Workspace",
                        "version": "0.1.0",
                    },
                    "capabilities": {"experimentalApi": True},
                },
                state,
                cancellation,
                deadline,
            )
            connection.notify("initialized", {})
            common: dict[str, Any] = {
                "cwd": str(cwd),
                "sandbox": "read-only",
                "approvalPolicy": "on-request",
                "dynamicTools": [],
                "environments": [],
                "selectedCapabilityRoots": [],
                "config": {
                    "project_doc_max_bytes": 0,
                    "agents": {"enabled": False},
                    "apps": {"_default": {"enabled": False}},
                    "features": {feature: False for feature in _DISABLED_CODEX_FEATURES},
                    "include_apps_instructions": False,
                    "include_collaboration_mode_instructions": False,
                    "include_environment_context": False,
                    "include_permissions_instructions": False,
                    "mcp_servers": _isolated_mcp_server_config(
                        request,
                        configured_mcp_servers,
                    ),
                },
            }
            if request.model is not None:
                common["model"] = request.model
            if request.thread_id:
                thread_result = connection.request(
                    "thread/resume",
                    {**common, "threadId": request.thread_id},
                    state,
                    cancellation,
                    deadline,
                )
            else:
                thread_result = connection.request(
                    "thread/start", common, state, cancellation, deadline
                )
            instruction_sources = thread_result.get("instructionSources", [])
            _validate_instruction_sources(instruction_sources, initialize_result)
            state.thread_id = _nested_string(thread_result, "thread", "id")
            if not state.thread_id:
                raise CodexProtocolError("thread response did not contain a thread id")
            emit(
                RuntimeEvent(
                    "thread.started",
                    {"thread_id": state.thread_id},
                    visibility="internal",
                )
            )
            turn_params: dict[str, Any] = {
                "threadId": state.thread_id,
                "input": [{"type": "text", "text": request.prompt}],
                "cwd": str(cwd),
                "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
                "approvalPolicy": "on-request",
            }
            if request.model is not None:
                turn_params["model"] = request.model
            if request.reasoning_effort is not None:
                turn_params["effort"] = request.reasoning_effort
            turn_result = connection.request(
                "turn/start", turn_params, state, cancellation, deadline
            )
            state.turn_id = _nested_string(turn_result, "turn", "id") or state.turn_id
            if not state.turn_id:
                raise CodexProtocolError("turn response did not contain a turn id")

            while state.completed is None:
                now = time.monotonic()
                if cancellation.is_cancelled and interrupt_sent_at is None:
                    connection.notify_request(
                        "turn/interrupt",
                        {"threadId": state.thread_id, "turnId": state.turn_id},
                    )
                    interrupt_sent_at = now
                    emit(RuntimeEvent("turn.interrupt_requested", {"turn_id": state.turn_id}))
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
                        error_message="Codex turn exceeded its configured timeout",
                    )
                connection.pump(state, cancellation, deadline, timeout=0.1)
            completed_status = _nested_string(state.completed, "turn", "status") or str(
                state.completed.get("status", "")
            )
            canceled = cancellation.is_cancelled or completed_status in {
                "interrupted",
                "canceled",
                "cancelled",
            }
            failed = completed_status == "failed"
            turn = state.completed.get("turn", {})
            turn_error = turn.get("error", {}) if isinstance(turn, dict) else {}
            error_message = turn_error.get("message") if isinstance(turn_error, dict) else None
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
                error_code="codex_turn_failed" if failed else None,
                error_message=error_message,
            )
        except CodexProtocolError as error:
            return RuntimeOutcome(
                RuntimeOutcomeStatus.CANCELED
                if cancellation.is_cancelled
                else RuntimeOutcomeStatus.FAILED,
                state.thread_id,
                state.turn_id,
                final_message="".join(state.message_parts) or None,
                usage=state.usage,
                error_code="codex_protocol_error",
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

    def _disabled_mcp_server_config(
        self,
        cwd: Path,
        cancellation: CancellationToken,
        runtime_timeout_seconds: float,
    ) -> dict[str, dict[str, Any]]:
        """Builds valid, disabled stubs for every inherited MCP transport."""

        result = self.runner.run(
            ProcessSpec(
                executable=self.executable,
                argv=(*self.command_prefix, "mcp", "list", "--json"),
                cwd=cwd,
                allowed_cwd_root=self.workspace_root,
                timeout_seconds=min(max(runtime_timeout_seconds, 0.1), 30.0),
                inherit_environment=self.inherited_environment,
                display_name="Codex MCP configuration probe",
            ),
            cancellation=cancellation,
        )
        if not result.succeeded:
            raise CodexProtocolError(
                "cannot establish an isolated MCP configuration: "
                f"Codex MCP discovery ended as {result.outcome.value}"
            )
        try:
            payload = json.loads(result.stdout_tail)
        except json.JSONDecodeError as error:
            raise CodexProtocolError(
                "cannot establish an isolated MCP configuration: invalid Codex MCP listing"
            ) from error
        if not isinstance(payload, list):
            raise CodexProtocolError(
                "cannot establish an isolated MCP configuration: Codex MCP listing is not a list"
            )
        config: dict[str, dict[str, Any]] = {}
        for entry in payload:
            name = entry.get("name") if isinstance(entry, dict) else None
            if not isinstance(name, str) or not name.strip():
                raise CodexProtocolError(
                    "cannot establish an isolated MCP configuration: unnamed MCP server"
                )
            transport = entry.get("transport")
            if not isinstance(transport, dict):
                raise CodexProtocolError(
                    "cannot establish an isolated MCP configuration: invalid transport"
                )
            transport_type = transport.get("type")
            if transport_type == "stdio" and isinstance(transport.get("command"), str):
                config[name] = {
                    "command": transport["command"],
                    "enabled": False,
                }
            elif transport_type in {"streamable_http", "sse"} and isinstance(
                transport.get("url"), str
            ):
                config[name] = {
                    "url": transport["url"],
                    "enabled": False,
                }
            else:
                raise CodexProtocolError(
                    "cannot establish an isolated MCP configuration: unsupported transport"
                )
        if _RESERVED_MCP_SERVER_NAME in config:
            raise CodexProtocolError(
                f"the reserved MCP server name {_RESERVED_MCP_SERVER_NAME!r} "
                "already exists in Codex configuration"
            )
        return dict(sorted(config.items()))

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


class _CodexConnection:
    def __init__(
        self,
        handle: ProcessHandle,
        emit: RuntimeEventSink,
        approve: RuntimeApprovalHandler,
        approvable_kinds: frozenset[str],
        secret_values: tuple[str, ...],
    ) -> None:
        self.handle = handle
        self.emit = emit
        self.approve = approve
        self.approvable_kinds = approvable_kinds
        self.secret_values = tuple(
            sorted({value for value in secret_values if value}, key=len, reverse=True)
        )
        self._next_id = 1

    def request(
        self,
        method: str,
        params: dict[str, Any],
        state: _ProtocolState,
        cancellation: CancellationToken,
        deadline: float,
    ) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        self._send({"id": request_id, "method": method, "params": params})
        while True:
            if time.monotonic() >= deadline:
                raise CodexProtocolError(f"timed out waiting for {method}")
            if cancellation.is_cancelled:
                raise CodexProtocolError(f"canceled while waiting for {method}")
            message = self._read(timeout=0.1)
            if message is None:
                continue
            if message.get("id") == request_id and "method" not in message:
                if "error" in message:
                    error = message["error"]
                    raise CodexProtocolError(f"{method} failed: {error.get('message', error)}")
                result = message.get("result", {})
                return result if isinstance(result, dict) else {}
            self._dispatch(message, state)

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._send({"method": method, "params": params})

    def notify_request(self, method: str, params: dict[str, Any]) -> None:
        request_id = self._next_id
        self._next_id += 1
        self._send({"id": request_id, "method": method, "params": params})

    def pump(
        self,
        state: _ProtocolState,
        cancellation: CancellationToken,
        deadline: float,
        *,
        timeout: float,
    ) -> None:
        if time.monotonic() >= deadline:
            raise CodexProtocolError("Codex turn timed out")
        message = self._read(timeout=timeout)
        if message is not None:
            self._dispatch(message, state)
        elif self.handle.returncode is not None:
            raise CodexProtocolError(
                f"Codex app-server exited with {self.handle.returncode}: "
                f"{self.handle.stderr_tail[-1000:]}"
            )
        if cancellation.is_cancelled:
            return

    def _dispatch(self, message: dict[str, Any], state: _ProtocolState) -> None:
        method = message.get("method")
        if not isinstance(method, str):
            return
        params = message.get("params")
        if not isinstance(params, dict):
            params = {}
        if "id" in message:
            self._handle_server_request(message["id"], method, params)
            return
        if method == "turn/started":
            state.turn_id = _nested_string(params, "turn", "id") or state.turn_id
        elif method == "turn/completed":
            state.completed = params
            usage = params.get("usage")
            if isinstance(usage, dict):
                state.usage = usage
        elif method == "thread/tokenUsage/updated":
            usage = params.get("tokenUsage")
            if isinstance(usage, dict):
                state.usage = usage
        elif method == "item/agentMessage/delta":
            delta = params.get("delta")
            if isinstance(delta, str):
                state.message_parts.append(delta)
        audit_event = _mcp_audit_event(method, params)
        if audit_event is not None:
            self.emit(audit_event)
        normalized = normalize_codex_event(method, params)
        if normalized is not None:
            self.emit(normalized)

    def _handle_server_request(
        self, request_id: int | str, method: str, params: dict[str, Any]
    ) -> None:
        kind = {
            "item/commandExecution/requestApproval": "command",
            "item/fileChange/requestApproval": "file_change",
            "item/permissions/requestApproval": "permissions",
            "execCommandApproval": "command",
            "applyPatchApproval": "file_change",
        }.get(method)
        if kind is None:
            self._send(
                {
                    "id": request_id,
                    "error": {"code": -32601, "message": f"unsupported server request: {method}"},
                }
            )
            return
        approvable = kind in self.approvable_kinds and kind != "permissions"
        decision = self.approve(
            RuntimeApprovalRequest(
                provider_request_id=str(request_id),
                kind=kind,
                summary=_approval_summary(method, params),
                approvable=approvable,
            )
        )
        if decision is ApprovalDecision.APPROVE and not approvable:
            decision = ApprovalDecision.DENY
        if kind == "permissions":
            result: dict[str, Any] = {"permissions": {}, "scope": "turn"}
        else:
            codex_decision = {
                ApprovalDecision.APPROVE: "accept",
                ApprovalDecision.DENY: "decline",
                ApprovalDecision.CANCEL: "cancel",
            }[decision]
            result = {"decision": codex_decision}
        self._send({"id": request_id, "result": result})

    def _read(self, *, timeout: float) -> dict[str, Any] | None:
        line = self.handle.read_stdout_line(timeout=timeout)
        if line is None:
            if self.handle.returncode is not None:
                raise CodexProtocolError(
                    f"Codex app-server exited with {self.handle.returncode}: "
                    f"{self.handle.stderr_tail[-1000:]}"
                )
            return None
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise CodexProtocolError(
                f"invalid JSONL from Codex app-server: {self._redact_text(line[-500:])}"
            ) from error
        if not isinstance(value, dict):
            raise CodexProtocolError("Codex app-server emitted a non-object JSONL message")
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


def normalize_codex_event(method: str, params: dict[str, Any]) -> RuntimeEvent | None:
    if "reasoning" in method.lower():
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        return RuntimeEvent(
            "agent.reasoning_status",
            {"method": method, "item_id": item.get("id"), "status": item.get("status")},
            visibility="internal",
        )
    mapping = {
        "turn/started": "turn.started",
        "turn/completed": "turn.completed",
        "item/agentMessage/delta": "agent.message.delta",
        "item/started": "item.started",
        "item/completed": "item.completed",
        "thread/tokenUsage/updated": "usage.updated",
        "error": "runtime.error",
    }
    event_type = mapping.get(method)
    if event_type is None:
        if method.startswith("item/"):
            return RuntimeEvent("item.progress", {"method": method})
        return None
    if method == "item/agentMessage/delta":
        return RuntimeEvent(event_type, {"delta": params.get("delta", "")})
    if method.startswith("item/"):
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        if item.get("type") == "webSearch":
            suffix = {
                "item/started": "started",
                "item/completed": "completed",
            }.get(method, "progress")
            return RuntimeEvent(f"web_search.{suffix}", _web_search_payload(item))
        if item.get("type") == "mcpToolCall":
            status = item.get("status")
            suffix = "started"
            if method == "item/completed":
                suffix = "failed" if status == "failed" else "completed"
            payload = {
                "type": "mcpToolCall",
                "status": status,
                "tool": item.get("tool"),
                "duration_ms": item.get("durationMs"),
            }
            if suffix == "failed":
                payload["error_code"] = "mcp_tool_failed"
            return RuntimeEvent(f"tool.{suffix}", payload)
        return RuntimeEvent(
            event_type,
            {
                "id": item.get("id"),
                "type": item.get("type"),
                "status": item.get("status"),
                "tool": item.get("tool"),
                "server": item.get("server"),
            },
        )
    if method == "turn/completed":
        return RuntimeEvent(
            event_type,
            {
                "turn_id": _nested_string(params, "turn", "id"),
                "status": _nested_string(params, "turn", "status") or params.get("status"),
                "usage": params.get("usage", {}),
            },
        )
    if method == "thread/tokenUsage/updated":
        return RuntimeEvent(event_type, {"usage": params.get("tokenUsage", {})})
    if method == "turn/started":
        return RuntimeEvent(
            event_type,
            {"turn_id": _nested_string(params, "turn", "id")},
            visibility="internal",
        )
    return RuntimeEvent(event_type, {})


def _mcp_audit_event(method: str, params: dict[str, Any]) -> RuntimeEvent | None:
    if method not in {"item/started", "item/completed"}:
        return None
    item = params.get("item")
    if not isinstance(item, dict) or item.get("type") != "mcpToolCall":
        return None
    status = item.get("status")
    payload: dict[str, Any] = {
        "provider_item_id": item.get("id"),
        "server": item.get("server"),
        "tool": item.get("tool"),
        "status": status,
        "duration_ms": item.get("durationMs"),
    }
    if "arguments" in item:
        payload["arguments"] = _audit_snapshot(item.get("arguments"))
    if "result" in item and item.get("result") is not None:
        payload["result"] = _audit_snapshot(item.get("result"))
    error = item.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        payload["error_message"] = error["message"][-4000:]
    suffix = "started"
    if method == "item/completed":
        suffix = "failed" if status == "failed" else "completed"
    return RuntimeEvent(f"mcp_tool.audit.{suffix}", payload, visibility="internal")


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


def _web_search_payload(item: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": item.get("id"),
        "query": item.get("query"),
        "status": item.get("status"),
    }
    action = item.get("action")
    if isinstance(action, dict):
        allowed = {"type", "query", "queries", "url", "pattern"}
        payload["action"] = {key: action[key] for key in allowed if key in action}
    results = item.get("results")
    if isinstance(results, list):
        payload["result_count"] = len(results)
    return payload


def _approval_summary(method: str, params: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "approvalId",
        "itemId",
        "reason",
        "command",
        "cwd",
        "grantRoot",
        "proposedExecpolicyAmendment",
    }
    return {"method": method, **{key: params[key] for key in allowed if key in params}}


def _nested_string(value: dict[str, Any], *path: str) -> str | None:
    current: Any = value
    for part in path:
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current if isinstance(current, str) else None


def _validate_instruction_sources(sources: Any, initialize_result: dict[str, Any]) -> None:
    """Allow the user's global Codex guidance but reject project or ambient files."""

    if not isinstance(sources, list) or any(not isinstance(item, str) for item in sources):
        raise CodexProtocolError("Codex returned invalid instruction source metadata")
    if not sources:
        return
    codex_home_value = initialize_result.get("codexHome")
    if not isinstance(codex_home_value, str) or not codex_home_value:
        raise CodexProtocolError("Codex loaded instructions without identifying its home")
    try:
        codex_home = Path(codex_home_value).resolve()
        allowed = {
            (codex_home / "AGENTS.md").resolve(),
            (codex_home / "AGENTS.override.md").resolve(),
        }
        resolved_sources = {Path(item).resolve() for item in sources}
    except (OSError, RuntimeError, ValueError) as error:
        raise CodexProtocolError("Codex returned invalid instruction source paths") from error
    if not resolved_sources.issubset(allowed):
        raise CodexProtocolError("isolated Codex thread loaded external instruction files")


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _isolated_mcp_server_config(
    request: RuntimeRequest,
    disabled_servers: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    config: dict[str, Any] = {name: dict(server) for name, server in disabled_servers.items()}
    if request.mcp is not None:
        config[_RESERVED_MCP_SERVER_NAME] = {
            "url": request.mcp.url,
            "bearer_token_env_var": request.mcp.token_environment_variable,
            "enabled": True,
            "required": True,
            "enabled_tools": list(request.mcp.enabled_tools),
            "default_tools_approval_mode": "approve",
        }
    return config

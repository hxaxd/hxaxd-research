from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

from app.platform.processes import CancellationToken

from .models import ApprovalDecision

WEB_SEARCH_SCOPE = "web:search"
DEEPSEEK_V4_FLASH = "deepseek-v4-flash"


class RuntimeOutcomeStatus(StrEnum):
    COMPLETED = "completed"
    CANCELED = "canceled"
    FAILED = "failed"


@dataclass(frozen=True)
class RuntimeRequest:
    run_id: str
    prompt: str
    cwd: Path
    thread_id: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None
    tool_scopes: tuple[str, ...] = ()
    mcp: RuntimeMcpCredentials | None = None
    timeout_seconds: float = 3600


@dataclass(frozen=True)
class RuntimeMcpCredentials:
    """Short-lived credentials issued for one run; the token is never persisted."""

    url: str
    bearer_token: str = field(repr=False)
    token_environment_variable: str = "HXAXD_MCP_TOKEN"
    enabled_tools: tuple[str, ...] = ()


@dataclass(frozen=True)
class RuntimeEvent:
    event_type: str
    payload: dict[str, Any] = field(default_factory=dict)
    visibility: str = "public"


@dataclass(frozen=True)
class RuntimeApprovalRequest:
    provider_request_id: str
    kind: str
    summary: dict[str, Any]
    approvable: bool = False


@dataclass(frozen=True)
class RuntimeOutcome:
    status: RuntimeOutcomeStatus
    thread_id: str | None
    turn_id: str | None
    final_message: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    error_code: str | None = None
    error_message: str | None = None


RuntimeEventSink = Callable[[RuntimeEvent], None]
RuntimeApprovalHandler = Callable[[RuntimeApprovalRequest], ApprovalDecision]


class AgentRuntime(Protocol):
    name: str
    version: str | None

    def run(
        self,
        request: RuntimeRequest,
        emit: RuntimeEventSink,
        approve: RuntimeApprovalHandler,
        cancellation: CancellationToken,
    ) -> RuntimeOutcome: ...

    def interrupt(self, run_id: str) -> None: ...


class RuntimeRegistryError(RuntimeError):
    pass


class RuntimeNotFoundError(RuntimeRegistryError):
    pass


class RuntimeUnavailableError(RuntimeRegistryError):
    pass


class RuntimeModelConflictError(RuntimeRegistryError):
    pass


@dataclass(frozen=True)
class AgentRuntimeDefinition:
    """One selectable runtime and the model contract enforced for new runs."""

    id: str
    label: str
    transport: str
    ready: bool
    message: str
    version: str | None = None
    model: str | None = None
    model_aliases: frozenset[str] = frozenset()
    supports_resume: bool = True


@dataclass(frozen=True)
class RegisteredAgentRuntime:
    definition: AgentRuntimeDefinition
    runtime: AgentRuntime


class AgentRuntimeRegistry:
    """Routes persisted runs without leaking provider protocols into the supervisor."""

    def __init__(
        self,
        registrations: tuple[RegisteredAgentRuntime, ...],
        *,
        default_runtime: str,
    ) -> None:
        if not registrations:
            raise ValueError("at least one agent runtime must be registered")
        self._registrations: dict[str, RegisteredAgentRuntime] = {}
        for registration in registrations:
            runtime_id = registration.definition.id.strip()
            if not runtime_id or runtime_id in self._registrations:
                raise ValueError(f"invalid or duplicate agent runtime id: {runtime_id!r}")
            if registration.runtime.name != runtime_id:
                raise ValueError(
                    f"runtime {registration.runtime.name!r} does not match "
                    f"registration {runtime_id!r}"
                )
            self._registrations[runtime_id] = registration
        if default_runtime not in self._registrations:
            raise ValueError(f"default agent runtime is not registered: {default_runtime}")
        self.default_runtime = default_runtime

    @classmethod
    def single(cls, runtime: AgentRuntime) -> AgentRuntimeRegistry:
        """Small composition helper for focused domain tests and custom deployments."""

        definition = AgentRuntimeDefinition(
            id=runtime.name,
            label=runtime.name,
            transport="test",
            ready=True,
            message="ready",
            version=runtime.version,
        )
        return cls(
            (RegisteredAgentRuntime(definition=definition, runtime=runtime),),
            default_runtime=runtime.name,
        )

    def definitions(self) -> tuple[AgentRuntimeDefinition, ...]:
        return tuple(item.definition for item in self._registrations.values())

    def registration(self, runtime_id: str | None = None) -> RegisteredAgentRuntime:
        selected = runtime_id or self.default_runtime
        try:
            return self._registrations[selected]
        except KeyError as error:
            raise RuntimeNotFoundError(f"unknown agent runtime: {selected}") from error

    def runtime(self, runtime_id: str | None = None) -> AgentRuntime:
        return self.registration(runtime_id).runtime

    def resolve_model(self, runtime_id: str, requested: str | None) -> str | None:
        definition = self.registration(runtime_id).definition
        if not definition.ready:
            raise RuntimeUnavailableError(definition.message)
        if definition.model is None:
            return requested
        accepted = {definition.model, *definition.model_aliases}
        if requested is not None and requested not in accepted:
            raise RuntimeModelConflictError(
                f"runtime {runtime_id} is pinned to {definition.model}; got {requested}"
            )
        return definition.model


def validate_runtime_mcp_credentials(credentials: RuntimeMcpCredentials) -> None:
    if credentials.token_environment_variable != "HXAXD_MCP_TOKEN":
        raise ValueError("the MCP token must use the dedicated HXAXD_MCP_TOKEN variable")
    parsed = urlparse(credentials.url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
        "127.0.0.1",
        "::1",
        "localhost",
    }:
        raise ValueError("the scoped MCP server must use a loopback HTTP endpoint")

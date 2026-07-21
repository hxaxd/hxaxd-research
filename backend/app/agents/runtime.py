from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from app.platform.processes import CancellationToken

from .models import ApprovalDecision

WEB_SEARCH_SCOPE = "web:search"


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

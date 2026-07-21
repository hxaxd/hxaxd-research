from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AgentRunStatus(StrEnum):
    CREATED = "created"
    STARTING = "starting"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    CANCELLATION_REQUESTED = "cancellation_requested"
    CANCELED = "canceled"
    COMPLETED = "completed"
    FAILED = "failed"

    @property
    def terminal(self) -> bool:
        return self in {self.CANCELED, self.COMPLETED, self.FAILED}


class ApprovalStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    EXPIRED = "expired"


class ApprovalDecision(StrEnum):
    APPROVE = "approve"
    DENY = "deny"
    CANCEL = "cancel"


class AgentRunCreate(BaseModel):
    id: str
    task_kind: str
    goal: str
    prompt: str
    prompt_version: str
    context_hash: str
    cwd: str
    project_id: str | None = None
    item_id: str | None = None
    target_type: str | None = None
    target_id: str | None = None
    tool_scopes: tuple[str, ...] = ()
    runtime: str
    runtime_version: str | None = None
    model: str | None = None


class AgentRun(BaseModel):
    id: str
    task_kind: str
    status: AgentRunStatus
    goal: str
    prompt: str
    prompt_version: str
    context_hash: str
    cwd: str
    project_id: str | None
    item_id: str | None
    target_type: str | None
    target_id: str | None
    tool_scopes: tuple[str, ...]
    runtime: str
    runtime_version: str | None
    model: str | None
    provider_thread_id: str | None
    provider_turn_id: str | None
    final_message: str | None
    error_code: str | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    cancel_requested_at: datetime | None


class PublicAgentRun(BaseModel):
    """Browser-safe projection; prompt snapshots and provider identifiers stay internal."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    task_kind: str
    status: AgentRunStatus
    goal: str
    project_id: str | None
    item_id: str | None
    target_type: str | None
    target_id: str | None
    tool_scopes: tuple[str, ...]
    runtime: str
    runtime_version: str | None
    model: str | None
    final_message: str | None
    error_code: str | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    cancel_requested_at: datetime | None


class AgentEvent(BaseModel):
    id: int
    run_id: str
    event_type: str
    visibility: str
    payload: dict[str, Any]
    created_at: datetime


class PublicAgentEvent(BaseModel):
    """Browser-safe event; provider identifiers and internal paths stay private."""

    id: int
    run_id: str
    event_type: str
    visibility: str = "public"
    payload: dict[str, Any]
    created_at: datetime


class Approval(BaseModel):
    id: str
    run_id: str
    provider_request_id: str
    kind: str
    status: ApprovalStatus
    approvable: bool
    request: dict[str, Any] = Field(default_factory=dict)
    decision: ApprovalDecision | None
    created_at: datetime
    decided_at: datetime | None


class PublicApproval(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    run_id: str
    kind: str
    status: ApprovalStatus
    approvable: bool
    request: dict[str, Any] = Field(default_factory=dict)
    decision: ApprovalDecision | None
    created_at: datetime
    decided_at: datetime | None

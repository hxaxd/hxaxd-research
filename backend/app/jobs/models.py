from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    CANCELLATION_REQUESTED = "cancellation_requested"
    CANCELED = "canceled"
    SUCCEEDED = "succeeded"
    FAILED = "failed"

    @property
    def terminal(self) -> bool:
        return self in {self.CANCELED, self.SUCCEEDED, self.FAILED}


class JobAttemptStatus(StrEnum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"
    INTERRUPTED = "interrupted"


class JobCreate(BaseModel):
    kind: str = Field(min_length=1, max_length=120)
    input: dict[str, Any] = Field(default_factory=dict)
    subject_type: str | None = Field(default=None, max_length=80)
    subject_id: str | None = Field(default=None, max_length=200)
    idempotency_key: str | None = Field(default=None, max_length=300)
    concurrency_key: str | None = Field(default=None, max_length=300)
    priority: int = Field(default=0, ge=-1000, le=1000)
    max_attempts: int = Field(default=1, ge=1, le=20)
    available_at: datetime | None = None


class Job(BaseModel):
    id: str
    kind: str
    subject_type: str | None
    subject_id: str | None
    status: JobStatus
    priority: int
    input: dict[str, Any]
    result: dict[str, Any] | None
    error_code: str | None
    error_message: str | None
    idempotency_key: str | None
    concurrency_key: str | None
    max_attempts: int
    lease_owner: str | None
    lease_expires_at: datetime | None
    heartbeat_at: datetime | None
    created_at: datetime
    updated_at: datetime
    available_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    cancel_requested_at: datetime | None


class PublicJob(BaseModel):
    """Browser-safe job state; execution inputs, results, and leases stay internal."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    kind: str
    subject_type: str | None
    subject_id: str | None
    status: JobStatus
    priority: int
    error_code: str | None
    error_message: str | None
    max_attempts: int
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    cancel_requested_at: datetime | None


class JobAttempt(BaseModel):
    id: str
    job_id: str
    attempt_number: int
    worker_id: str
    status: JobAttemptStatus
    process_id: int | None
    executable: str | None
    exit_code: int | None
    error_message: str | None
    started_at: datetime
    heartbeat_at: datetime
    finished_at: datetime | None


class ClaimedJob(BaseModel):
    job: Job
    attempt: JobAttempt


class JobEvent(BaseModel):
    id: int
    job_id: str
    attempt_id: str | None
    event_type: str
    level: str
    payload: dict[str, Any]
    created_at: datetime


class PublicJobEvent(BaseModel):
    """Browser-safe job event without attempt/worker execution details."""

    id: int
    job_id: str
    event_type: str
    level: str
    payload: dict[str, Any]
    created_at: datetime


class JobAttachment(BaseModel):
    id: str
    job_id: str
    attempt_id: str | None
    role: str
    attachment_id: str
    media_type: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None


class JobExecutionResult(BaseModel):
    result: dict[str, Any] = Field(default_factory=dict)
    attachments: list[JobAttachment] = Field(default_factory=list)
    commit_point_reached: bool = False


class JobFailure(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable

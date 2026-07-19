from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class TranslationRequest(BaseModel):
    qps: int = Field(default=4, ge=1, le=1000)
    workers: int = Field(default=4, ge=1, le=1000)


class Job(BaseModel):
    id: str
    paper_id: str
    job_type: str
    status: JobStatus
    progress: int
    message: str
    error_summary: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

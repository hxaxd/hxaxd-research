from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field

from app.modules.resources.models import Resource


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class JobOperation(StrEnum):
    COMPILE = "compile"
    TRANSLATE = "translate"


class JobRequest(BaseModel):
    operation: JobOperation
    input_resource_id: str
    options: dict[str, int | str | bool] = Field(default_factory=dict)


class TranslationRequest(BaseModel):
    qps: int = Field(default=4, ge=1, le=1000)
    workers: int = Field(default=4, ge=1, le=1000)


class Job(BaseModel):
    id: str
    paper_id: str
    operation: JobOperation
    input_resource_id: str | None
    status: JobStatus
    progress: int
    options: dict
    tool: str | None
    tool_version: str | None
    message: str
    log_excerpt: str | None
    error_summary: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    outputs: list[Resource] = Field(default_factory=list)

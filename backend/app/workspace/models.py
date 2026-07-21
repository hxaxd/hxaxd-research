from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ProjectProjection(BaseModel):
    id: str
    name: str
    description: str
    item_count: int
    candidate_count: int
    status_counts: dict[str, int] = Field(default_factory=dict)
    updated_at: datetime


class WorkspaceCounts(BaseModel):
    projects: int
    works: int
    items: int
    project_works: int
    candidates: int
    attachments: int
    active_jobs: int
    pending_approvals: int


class RuntimeCapability(BaseModel):
    supported: bool
    ready: bool
    message: str
    details: dict[str, str | int | bool | None] = Field(default_factory=dict)


class WorkspaceProjection(BaseModel):
    generated_at: datetime
    contract_version: str
    schema_version: int
    counts: WorkspaceCounts
    projects: list[ProjectProjection]
    capabilities: dict[str, RuntimeCapability]


class IntegrityIssue(BaseModel):
    kind: str
    entity_id: str | None = None
    message: str


class IntegrityReport(BaseModel):
    checked_at: datetime
    healthy: bool
    deep: bool
    database_integrity: str
    foreign_key_violations: int
    counts: WorkspaceCounts
    verified_files: int
    issues: list[IntegrityIssue] = Field(default_factory=list)

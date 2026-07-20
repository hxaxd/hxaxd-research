from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.modules.projects.models import ProjectSummary
from app.modules.tools.models import ManagedTool


class Capability(BaseModel):
    supported: bool
    ready: bool
    accepts: list[str] = Field(default_factory=list)
    produces: list[str] = Field(default_factory=list)
    tool: str | None = None
    tool_version: str | None = None
    message: str


class WorkspaceProject(ProjectSummary):
    status_counts: dict[str, int]
    resource_counts: dict[str, int]


class WorkspaceState(BaseModel):
    generated_at: datetime
    contract_version: str
    schema_version: int
    projects: list[WorkspaceProject]
    capabilities: dict[str, Capability]
    tools: list[ManagedTool]

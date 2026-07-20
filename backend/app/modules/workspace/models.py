from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.modules.artifacts.models import Artifact
from app.modules.papers.models import Paper
from app.modules.projects.models import ProjectSummary
from app.modules.tools.models import ManagedTool


class WorkspacePaper(Paper):
    artifacts: list[Artifact]


class WorkspaceProject(ProjectSummary):
    status_counts: dict[str, int]
    papers: list[WorkspacePaper]


class WorkspaceState(BaseModel):
    generated_at: datetime
    projects: list[WorkspaceProject]
    tools: list[ManagedTool]

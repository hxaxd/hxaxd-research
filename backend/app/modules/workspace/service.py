from __future__ import annotations

from collections import Counter

from app.modules.artifacts.service import ArtifactService
from app.modules.papers.service import PaperService
from app.modules.projects.service import ProjectService
from app.modules.tools.service import ToolService
from app.utils.time import utc_now

from .models import WorkspacePaper, WorkspaceProject, WorkspaceState


class WorkspaceService:
    def __init__(
        self,
        projects: ProjectService,
        papers: PaperService,
        artifacts: ArtifactService,
        tools: ToolService,
    ):
        self.projects = projects
        self.papers = papers
        self.artifacts = artifacts
        self.tools = tools

    def get(self) -> WorkspaceState:
        project_states: list[WorkspaceProject] = []
        for project in self.projects.list():
            papers = self.papers.list_by_project(project.id)
            status_counts = Counter(paper.status.value for paper in papers)
            project_states.append(
                WorkspaceProject(
                    **project.model_dump(),
                    status_counts=dict(status_counts),
                    papers=[
                        WorkspacePaper(
                            **paper.model_dump(),
                            artifacts=self.artifacts.list_by_paper(paper.id),
                        )
                        for paper in papers
                    ],
                )
            )
        return WorkspaceState(
            generated_at=utc_now(),
            projects=project_states,
            tools=self.tools.list(),
        )

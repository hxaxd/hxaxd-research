from __future__ import annotations

from collections import Counter

from app.core.database import Database
from app.modules.papers.service import PaperService
from app.modules.projects.service import ProjectService
from app.modules.resources.service import ResourceService
from app.modules.tools.models import ToolName, ToolStatus
from app.modules.tools.service import ToolService
from app.utils.time import utc_now

from .models import Capability, WorkspaceProject, WorkspaceState

CONTRACT_VERSION = "2.0"


class WorkspaceService:
    def __init__(
        self,
        projects: ProjectService,
        papers: PaperService,
        resources: ResourceService,
        tools: ToolService,
        database: Database,
    ):
        self.projects = projects
        self.papers = papers
        self.resources = resources
        self.tools = tools
        self.database = database

    def get(self) -> WorkspaceState:
        project_states: list[WorkspaceProject] = []
        for project in self.projects.list():
            entries = self.papers.list_by_project(project.id)
            status_counts = Counter(entry.project.status.value for entry in entries)
            resource_counts: Counter[str] = Counter()
            for entry in entries:
                for resource in self.resources.list_by_paper(entry.paper.id):
                    resource_counts[f"{resource.format.value}:{resource.representation.value}"] += 1
            project_states.append(
                WorkspaceProject(
                    **project.model_dump(),
                    status_counts=dict(status_counts),
                    resource_counts=dict(resource_counts),
                )
            )
        tools = self.tools.list()
        by_name = {tool.name: tool for tool in tools}
        tex = by_name[ToolName.TEX]
        pdf2zh = by_name[ToolName.PDF2ZH]
        return WorkspaceState(
            generated_at=utc_now(),
            contract_version=CONTRACT_VERSION,
            schema_version=self.database.schema_version(),
            projects=project_states,
            capabilities={
                "resource_upload": Capability(
                    supported=True,
                    ready=True,
                    accepts=["pdf", "tex"],
                    produces=["resource"],
                    message="支持 PDF 与 TeX 源码包",
                ),
                "compile": Capability(
                    supported=True,
                    ready=tex.status == ToolStatus.INSTALLED,
                    accepts=["tex:original"],
                    produces=["pdf:original"],
                    tool="latexmk",
                    tool_version=tex.version,
                    message=tex.message,
                ),
                "translate": Capability(
                    supported=True,
                    ready=pdf2zh.status == ToolStatus.INSTALLED,
                    accepts=["pdf:original"],
                    produces=["pdf:translated", "pdf:bilingual"],
                    tool="pdf2zh",
                    tool_version=pdf2zh.version,
                    message=pdf2zh.message,
                ),
            },
            tools=tools,
        )

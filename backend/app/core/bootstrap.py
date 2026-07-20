from __future__ import annotations

from dataclasses import dataclass

from app.modules.papers.repository import SqlitePaperRepository
from app.modules.papers.service import PaperService
from app.modules.projects.repository import SqliteProjectRepository
from app.modules.projects.service import ProjectService
from app.modules.resources.repository import SqliteResourceRepository
from app.modules.resources.service import ResourceService
from app.modules.resources.storage import LocalResourceStorage
from app.modules.snapshots.service import SnapshotService
from app.modules.tools.service import ToolService
from app.modules.translations.backend import Pdf2zhBackend
from app.modules.translations.executor import ThreadedJobExecutor
from app.modules.translations.repository import SqliteJobRepository
from app.modules.translations.service import JobService
from app.modules.workspace.service import WorkspaceService

from .config import Settings
from .database import Database


@dataclass(frozen=True)
class AppContext:
    settings: Settings
    database: Database
    storage: LocalResourceStorage
    job_repository: SqliteJobRepository
    job_executor: ThreadedJobExecutor
    projects: ProjectService
    papers: PaperService
    resources: ResourceService
    jobs: JobService
    tools: ToolService
    workspace: WorkspaceService
    snapshots: SnapshotService

    def startup(self) -> None:
        self.database.initialize()
        self.storage.initialize()
        self.tools.initialize()
        self.snapshots.initialize()
        self.job_repository.fail_interrupted()

    def shutdown(self) -> None:
        self.job_executor.shutdown()
        self.tools.shutdown()
        self.snapshots.shutdown()


def build_app_context(settings: Settings) -> AppContext:
    database = Database(settings.database_path)
    storage = LocalResourceStorage(settings)

    project_repository = SqliteProjectRepository(database)
    paper_repository = SqlitePaperRepository(database)
    resource_repository = SqliteResourceRepository(database)
    job_repository = SqliteJobRepository(database)

    projects = ProjectService(project_repository)
    papers = PaperService(paper_repository, project_repository)
    resources = ResourceService(resource_repository, storage, paper_repository)
    tools = ToolService(settings)
    snapshots = SnapshotService(settings, job_repository)
    workspace = WorkspaceService(projects, papers, resources, tools, database)

    translation_backend = Pdf2zhBackend(settings)
    job_executor = ThreadedJobExecutor(
        jobs=job_repository,
        resources=resource_repository,
        storage=storage,
        registrar=resources,
        backend=translation_backend,
        tools=tools,
    )
    jobs = JobService(
        jobs=job_repository,
        resources=resource_repository,
        executor=job_executor,
    )

    return AppContext(
        settings=settings,
        database=database,
        storage=storage,
        job_repository=job_repository,
        job_executor=job_executor,
        projects=projects,
        papers=papers,
        resources=resources,
        jobs=jobs,
        tools=tools,
        workspace=workspace,
        snapshots=snapshots,
    )

from __future__ import annotations

from dataclasses import dataclass

from app.modules.artifacts.repository import SqliteArtifactRepository
from app.modules.artifacts.service import ArtifactService
from app.modules.artifacts.storage import LocalPdfStorage
from app.modules.papers.repository import SqlitePaperRepository
from app.modules.papers.service import PaperService
from app.modules.projects.repository import SqliteProjectRepository
from app.modules.projects.service import ProjectService
from app.modules.translations.backend import Pdf2zhBackend
from app.modules.translations.executor import ThreadedTranslationExecutor
from app.modules.translations.repository import SqliteJobRepository
from app.modules.translations.service import TranslationService

from .config import Settings
from .database import Database


@dataclass(frozen=True)
class AppContext:
    settings: Settings
    database: Database
    storage: LocalPdfStorage
    job_repository: SqliteJobRepository
    translation_executor: ThreadedTranslationExecutor
    projects: ProjectService
    papers: PaperService
    artifacts: ArtifactService
    translations: TranslationService

    def startup(self) -> None:
        self.database.initialize()
        self.storage.initialize()
        self.job_repository.fail_interrupted()

    def shutdown(self) -> None:
        self.translation_executor.shutdown()


def build_app_context(settings: Settings) -> AppContext:
    database = Database(settings.database_path)
    storage = LocalPdfStorage(settings)

    project_repository = SqliteProjectRepository(database)
    paper_repository = SqlitePaperRepository(database)
    artifact_repository = SqliteArtifactRepository(database)
    job_repository = SqliteJobRepository(database)

    projects = ProjectService(project_repository)
    papers = PaperService(paper_repository, project_repository)
    artifacts = ArtifactService(artifact_repository, storage, paper_repository)

    translation_backend = Pdf2zhBackend(settings)
    translation_executor = ThreadedTranslationExecutor(
        jobs=job_repository,
        artifacts=artifact_repository,
        storage=storage,
        registrar=artifacts,
        backend=translation_backend,
    )
    translations = TranslationService(
        jobs=job_repository,
        artifacts=artifact_repository,
        executor=translation_executor,
    )

    return AppContext(
        settings=settings,
        database=database,
        storage=storage,
        job_repository=job_repository,
        translation_executor=translation_executor,
        projects=projects,
        papers=papers,
        artifacts=artifacts,
        translations=translations,
    )

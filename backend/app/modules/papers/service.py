from __future__ import annotations

from app.modules.projects.repository import SqliteProjectRepository
from app.utils.identity import new_id
from app.utils.time import utc_now

from .models import Paper, PaperBatchCreate, PaperCreate, PaperPatch
from .repository import SqlitePaperRepository


class PaperService:
    def __init__(
        self,
        repository: SqlitePaperRepository,
        projects: SqliteProjectRepository,
    ):
        self.repository = repository
        self.projects = projects

    @staticmethod
    def schema() -> dict:
        return PaperCreate.model_json_schema()

    def get(self, paper_id: str) -> Paper:
        return self.repository.get(paper_id)

    def list_by_project(self, project_id: str) -> list[Paper]:
        self.projects.get(project_id)
        return self.repository.list_by_project(project_id)

    def create_many(self, project_id: str, payload: PaperBatchCreate) -> list[Paper]:
        self.projects.get(project_id)
        now = utc_now()
        papers = [
            Paper(
                id=new_id(),
                project_id=project_id,
                created_at=now,
                updated_at=now,
                **paper.model_dump(),
            )
            for paper in payload.papers
        ]
        return self.repository.save_many(papers)

    def patch(self, paper_id: str, payload: PaperPatch) -> Paper:
        paper = self.repository.get(paper_id)
        changes = payload.model_dump(exclude_unset=True)
        if not changes:
            return paper
        updated = paper.model_copy(update={**changes, "updated_at": utc_now()})
        return self.repository.update(updated)

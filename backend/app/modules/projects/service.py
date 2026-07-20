from __future__ import annotations

from app.utils.identity import new_id
from app.utils.time import utc_now

from .models import Project, ProjectCreate, ProjectPatch, ProjectSummary
from .repository import SqliteProjectRepository


class ProjectService:
    def __init__(self, repository: SqliteProjectRepository):
        self.repository = repository

    def list(self) -> list[ProjectSummary]:
        return self.repository.list_with_paper_counts()

    def get(self, project_id: str) -> Project:
        return self.repository.get(project_id)

    def create(self, payload: ProjectCreate) -> Project:
        now = utc_now()
        return self.repository.save(
            Project(
                id=new_id(),
                name=payload.name,
                description=payload.description,
                created_at=now,
                updated_at=now,
            )
        )

    def patch(self, project_id: str, payload: ProjectPatch) -> Project:
        current = self.repository.get(project_id)
        changes = payload.model_dump(exclude_unset=True)
        if not changes:
            return current
        return self.repository.update(
            current.model_copy(update={**changes, "updated_at": utc_now()})
        )

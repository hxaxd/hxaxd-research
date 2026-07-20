from __future__ import annotations

import sqlite3

from app.core.database import Database
from app.core.errors import ResourceConflictError, ResourceNotFoundError
from app.modules.projects.models import Project, ProjectSummary


class SqliteProjectRepository:
    def __init__(self, database: Database):
        self.database = database

    def get(self, project_id: str) -> Project:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        if row is None:
            raise ResourceNotFoundError("项目不存在")
        return Project.model_validate(dict(row))

    def list_with_paper_counts(self) -> list[ProjectSummary]:
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT p.*, COUNT(pa.id) AS paper_count
                FROM projects p
                LEFT JOIN project_papers pa ON pa.project_id = p.id
                GROUP BY p.id
                ORDER BY p.name
                """
            ).fetchall()
        return [ProjectSummary.model_validate(dict(row)) for row in rows]

    def save(self, project: Project) -> Project:
        try:
            with self.database.connection() as connection:
                connection.execute(
                    """
                    INSERT INTO projects(
                        id, name, description, created_at, updated_at
                    ) VALUES(
                        :id, :name, :description, :created_at, :updated_at
                    )
                    """,
                    project.model_dump(mode="json"),
                )
        except sqlite3.IntegrityError as error:
            raise ResourceConflictError("已存在同名项目") from error
        return project

    def update(self, project: Project) -> Project:
        try:
            with self.database.connection() as connection:
                cursor = connection.execute(
                    """
                    UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?
                    """,
                    (project.name, project.description, project.updated_at.isoformat(), project.id),
                )
        except sqlite3.IntegrityError as error:
            raise ResourceConflictError("已存在同名项目") from error
        if cursor.rowcount == 0:
            raise ResourceNotFoundError("项目不存在")
        return project

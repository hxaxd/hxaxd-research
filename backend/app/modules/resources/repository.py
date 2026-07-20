from __future__ import annotations

import sqlite3

from app.core.database import Database
from app.core.errors import ResourceNotFoundError

from .models import Resource, ResourceFormat, ResourceRepresentation


class SqliteResourceRepository:
    def __init__(self, database: Database):
        self.database = database

    @staticmethod
    def _from_row(row: sqlite3.Row) -> Resource:
        return Resource.model_validate({**dict(row), "preferred": bool(row["preferred"])})

    def get(self, resource_id: str) -> Resource:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT * FROM resources WHERE id = ?", (resource_id,)
            ).fetchone()
        if row is None:
            raise ResourceNotFoundError("资源不存在")
        return self._from_row(row)

    def list_by_paper(self, paper_id: str) -> list[Resource]:
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM resources WHERE paper_id = ?
                ORDER BY format, representation, preferred DESC, created_at DESC
                """,
                (paper_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def preferred(
        self,
        paper_id: str,
        format_: ResourceFormat,
        representation: ResourceRepresentation,
    ) -> Resource:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT * FROM resources
                WHERE paper_id = ? AND format = ? AND representation = ?
                ORDER BY preferred DESC, created_at DESC LIMIT 1
                """,
                (paper_id, format_.value, representation.value),
            ).fetchone()
        if row is None:
            raise ResourceNotFoundError("论文缺少所需资源")
        return self._from_row(row)

    def save(self, resource: Resource, relative_path: str) -> Resource:
        values = {**resource.model_dump(mode="json"), "relative_path": relative_path}
        with self.database.connection() as connection:
            if resource.preferred:
                connection.execute(
                    """
                    UPDATE resources SET preferred = 0
                    WHERE paper_id = ? AND format = ? AND representation = ?
                    """,
                    (
                        resource.paper_id,
                        resource.format.value,
                        resource.representation.value,
                    ),
                )
            connection.execute(
                """
                INSERT INTO resources(
                    id, paper_id, format, representation, origin, source_url, filename,
                    media_type, relative_path, sha256, size, preferred,
                    parent_resource_id, job_id, created_at
                ) VALUES(
                    :id, :paper_id, :format, :representation, :origin, :source_url, :filename,
                    :media_type, :relative_path, :sha256, :size, :preferred,
                    :parent_resource_id, :job_id, :created_at
                )
                """,
                values,
            )
        return resource

    def patch(self, resource_id: str, changes: dict) -> Resource:
        current = self.get(resource_id)
        with self.database.connection() as connection:
            if changes.get("preferred") is True:
                connection.execute(
                    """
                    UPDATE resources SET preferred = 0
                    WHERE paper_id = ? AND format = ? AND representation = ?
                    """,
                    (current.paper_id, current.format.value, current.representation.value),
                )
            allowed = {"preferred", "source_url", "origin"}
            assignments = [f"{key} = ?" for key in changes if key in allowed]
            if assignments:
                connection.execute(
                    f"UPDATE resources SET {', '.join(assignments)} WHERE id = ?",
                    (*[changes[key] for key in changes if key in allowed], resource_id),
                )
        return self.get(resource_id)

    def relative_path(self, resource_id: str) -> str:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT relative_path FROM resources WHERE id = ?", (resource_id,)
            ).fetchone()
        if row is None:
            raise ResourceNotFoundError("资源不存在")
        return row["relative_path"]

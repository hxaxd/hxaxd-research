from __future__ import annotations

import sqlite3
from pathlib import Path

from app.core.database import Database
from app.core.errors import ResourceNotFoundError
from app.modules.artifacts.models import Artifact, ArtifactKind


class SqliteArtifactRepository:
    def __init__(self, database: Database):
        self.database = database

    @staticmethod
    def _from_row(row: sqlite3.Row) -> Artifact:
        return Artifact.model_validate(
            {
                **dict(row),
                "filename": Path(row["relative_path"]).name,
            }
        )

    def get(self, paper_id: str, kind: ArtifactKind) -> Artifact:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT * FROM artifacts WHERE paper_id = ? AND kind = ?",
                (paper_id, kind.value),
            ).fetchone()
        if row is None:
            raise ResourceNotFoundError(f"论文缺少 {kind.value} PDF")
        return self._from_row(row)

    def list_by_paper(self, paper_id: str) -> list[Artifact]:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM artifacts WHERE paper_id = ? ORDER BY kind",
                (paper_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def upsert(self, artifact: Artifact) -> Artifact:
        values = artifact.model_dump(mode="json", exclude={"filename"})
        with self.database.connection() as connection:
            connection.execute(
                """
                INSERT INTO artifacts(
                    id, paper_id, kind, relative_path, sha256, size, created_at
                ) VALUES(
                    :id, :paper_id, :kind, :relative_path, :sha256, :size, :created_at
                )
                ON CONFLICT(paper_id, kind) DO UPDATE SET
                    relative_path = excluded.relative_path,
                    sha256 = excluded.sha256,
                    size = excluded.size,
                    created_at = excluded.created_at
                """,
                values,
            )
            row = connection.execute(
                "SELECT * FROM artifacts WHERE paper_id = ? AND kind = ?",
                (artifact.paper_id, artifact.kind.value),
            ).fetchone()
        assert row is not None
        return self._from_row(row)

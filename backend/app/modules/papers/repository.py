from __future__ import annotations

import json
import sqlite3
from typing import Any

from app.core.database import Database
from app.core.errors import ResourceConflictError, ResourceNotFoundError
from app.modules.papers.models import Paper


class SqlitePaperRepository:
    def __init__(self, database: Database):
        self.database = database

    @staticmethod
    def _from_row(row: sqlite3.Row) -> Paper:
        return Paper.model_validate(
            {
                "id": row["id"],
                "project_id": row["project_id"],
                "stable_key": row["stable_key"],
                "status": row["status"],
                "title_en": row["title_en"],
                "title_zh": row["title_zh"],
                "authors": json.loads(row["authors_json"]),
                "organization": row["organization"],
                "publication_year": row["publication_year"],
                "publication_status": row["publication_status"],
                "paper_type": row["paper_type"],
                "main_method": row["main_method"],
                "contribution": row["contribution"],
                "selection_reason": row["selection_reason"],
                "reading_focus": row["reading_focus"],
                "relations": row["relations_text"],
                "stable_url": row["stable_url"],
                "code_url": row["code_url"],
                "website_url": row["website_url"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )

    @staticmethod
    def _values(paper: Paper) -> dict[str, Any]:
        data = paper.model_dump(mode="json")
        return {
            **data,
            "authors_json": json.dumps(data.pop("authors"), ensure_ascii=False),
            "relations_text": data.pop("relations"),
        }

    def get(self, paper_id: str) -> Paper:
        with self.database.connection() as connection:
            row = connection.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
        if row is None:
            raise ResourceNotFoundError("论文不存在")
        return self._from_row(row)

    def list_by_project(self, project_id: str) -> list[Paper]:
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM papers
                WHERE project_id = ?
                ORDER BY publication_year DESC, title_en
                """,
                (project_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def save_many(self, papers: list[Paper]) -> list[Paper]:
        try:
            with self.database.connection() as connection:
                for paper in papers:
                    connection.execute(
                        """
                        INSERT INTO papers(
                            id, project_id, stable_key, status, title_en, title_zh,
                            authors_json, organization, publication_year, publication_status,
                            paper_type, main_method, contribution, selection_reason,
                            reading_focus, relations_text, stable_url, code_url, website_url,
                            created_at, updated_at
                        ) VALUES(
                            :id, :project_id, :stable_key, :status, :title_en, :title_zh,
                            :authors_json, :organization, :publication_year, :publication_status,
                            :paper_type, :main_method, :contribution, :selection_reason,
                            :reading_focus, :relations_text, :stable_url, :code_url, :website_url,
                            :created_at, :updated_at
                        )
                        """,
                        self._values(paper),
                    )
        except sqlite3.IntegrityError as error:
            raise ResourceConflictError(
                "项目中已存在相同 stable_key 的论文；本批次未写入"
            ) from error
        return papers

    def update(self, paper: Paper) -> Paper:
        values = self._values(paper)
        with self.database.connection() as connection:
            cursor = connection.execute(
                """
                UPDATE papers SET
                    status = :status,
                    title_zh = :title_zh,
                    organization = :organization,
                    publication_status = :publication_status,
                    paper_type = :paper_type,
                    main_method = :main_method,
                    contribution = :contribution,
                    selection_reason = :selection_reason,
                    reading_focus = :reading_focus,
                    relations_text = :relations_text,
                    stable_url = :stable_url,
                    code_url = :code_url,
                    website_url = :website_url,
                    updated_at = :updated_at
                WHERE id = :id
                """,
                values,
            )
        if cursor.rowcount == 0:
            raise ResourceNotFoundError("论文不存在")
        return paper

from __future__ import annotations

import json
import sqlite3
from typing import Any

from app.core.database import Database
from app.core.errors import ResourceConflictError, ResourceNotFoundError
from app.modules.resources.repository import SqliteResourceRepository

from .models import (
    BatchOutcome,
    Paper,
    PaperBatchItemResult,
    PaperIdentifier,
    PaperLink,
    ProjectPaper,
    ProjectPaperView,
)


class SqlitePaperRepository:
    def __init__(self, database: Database):
        self.database = database
        self.resources = SqliteResourceRepository(database)

    @staticmethod
    def _paper_from_row(connection: sqlite3.Connection, row: sqlite3.Row) -> Paper:
        identifiers = connection.execute(
            "SELECT * FROM paper_identifiers WHERE paper_id = ? ORDER BY is_primary DESC, scheme",
            (row["id"],),
        ).fetchall()
        return Paper.model_validate(
            {
                **dict(row),
                "authors": json.loads(row["authors_json"]),
                "authors_complete": bool(row["authors_complete"]),
                "links": [PaperLink.model_validate(item) for item in json.loads(row["links_json"])],
                "identifiers": [PaperIdentifier.model_validate(dict(item)) for item in identifiers],
            }
        )

    @staticmethod
    def _membership_from_row(row: sqlite3.Row) -> ProjectPaper:
        return ProjectPaper.model_validate(
            {
                **dict(row),
                "roles": json.loads(row["roles_json"]),
                "contributions": json.loads(row["contributions_json"]),
                "reading_focus": json.loads(row["reading_focus_json"]),
            }
        )

    def get(self, paper_id: str) -> Paper:
        with self.database.connection() as connection:
            row = connection.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
            if row is None:
                raise ResourceNotFoundError("论文不存在")
            return self._paper_from_row(connection, row)

    def get_membership(self, project_id: str, paper_id: str) -> ProjectPaper:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT * FROM project_papers WHERE project_id = ? AND paper_id = ?",
                (project_id, paper_id),
            ).fetchone()
        if row is None:
            raise ResourceNotFoundError("论文不在该项目中")
        return self._membership_from_row(row)

    def list_memberships(self, paper_id: str) -> list[ProjectPaper]:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM project_papers WHERE paper_id = ? ORDER BY created_at",
                (paper_id,),
            ).fetchall()
        return [self._membership_from_row(row) for row in rows]

    def list_by_project(self, project_id: str) -> list[ProjectPaperView]:
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT pp.* FROM project_papers pp
                JOIN papers p ON p.id = pp.paper_id
                WHERE pp.project_id = ?
                ORDER BY p.publication_year DESC, p.title
                """,
                (project_id,),
            ).fetchall()
            views = [
                ProjectPaperView(
                    paper=self._paper_from_row(
                        connection,
                        connection.execute(
                            "SELECT * FROM papers WHERE id = ?", (row["paper_id"],)
                        ).fetchone(),
                    ),
                    project=self._membership_from_row(row),
                )
                for row in rows
            ]
        for view in views:
            view.resources = self.resources.list_by_paper(view.paper.id)
        return views

    def save_batch(
        self, project_id: str, prepared: list[dict[str, Any]]
    ) -> list[PaperBatchItemResult]:
        results: list[PaperBatchItemResult] = []
        try:
            with self.database.connection() as connection:
                for item in prepared:
                    identifiers = item["identifiers"]
                    values = [(entry["scheme"], entry["normalized_value"]) for entry in identifiers]
                    matches: set[str] = set()
                    for scheme, normalized in values:
                        row = connection.execute(
                            """
                            SELECT paper_id FROM paper_identifiers
                            WHERE scheme = ? AND normalized_value = ?
                            """,
                            (scheme, normalized),
                        ).fetchone()
                        if row:
                            matches.add(row["paper_id"])
                    if len(matches) > 1:
                        raise ResourceConflictError("identifiers resolve to different papers")
                    paper_created = not matches
                    paper_id = next(iter(matches), item["paper"]["id"])
                    if paper_created:
                        paper_values = {**item["paper"], "id": paper_id}
                        connection.execute(
                            """
                            INSERT INTO papers(
                                id, identity_key, title, title_zh, authors_json, authors_complete,
                                abstract, publication_year, venue, publication_state, links_json,
                                created_at, updated_at
                            ) VALUES(
                                :id, :identity_key, :title, :title_zh,
                                :authors_json, :authors_complete, :abstract,
                                :publication_year, :venue, :publication_state, :links_json,
                                :created_at, :updated_at
                            )
                            """,
                            paper_values,
                        )
                        for identifier in identifiers:
                            connection.execute(
                                """
                                INSERT INTO paper_identifiers(
                                    id, paper_id, scheme, value, normalized_value,
                                    is_primary, source
                                ) VALUES(
                                    :id, :paper_id, :scheme, :value, :normalized_value,
                                    :is_primary, :source
                                )
                                """,
                                {**identifier, "paper_id": paper_id},
                            )
                    else:
                        existing = connection.execute(
                            "SELECT title FROM papers WHERE id = ?", (paper_id,)
                        ).fetchone()
                        if existing["title"].casefold() != item["paper"]["title"].casefold():
                            raise ResourceConflictError(
                                "identifier conflicts with an existing paper title"
                            )
                        for identifier in identifiers:
                            present = connection.execute(
                                """
                                SELECT 1 FROM paper_identifiers
                                WHERE scheme = ? AND normalized_value = ?
                                """,
                                (identifier["scheme"], identifier["normalized_value"]),
                            ).fetchone()
                            if present is None:
                                connection.execute(
                                    """
                                    INSERT INTO paper_identifiers(
                                        id, paper_id, scheme, value, normalized_value,
                                        is_primary, source
                                    ) VALUES(
                                        :id, :paper_id, :scheme, :value, :normalized_value,
                                        0, :source
                                    )
                                    """,
                                    {**identifier, "paper_id": paper_id},
                                )

                    membership_row = connection.execute(
                        "SELECT * FROM project_papers WHERE project_id = ? AND paper_id = ?",
                        (project_id, paper_id),
                    ).fetchone()
                    if membership_row is None:
                        membership_values = {
                            **item["project"],
                            "project_id": project_id,
                            "paper_id": paper_id,
                        }
                        connection.execute(
                            """
                            INSERT INTO project_papers(
                                id, project_id, paper_id, status, roles_json, summary,
                                contributions_json, relevance, reading_focus_json,
                                created_at, updated_at
                            ) VALUES(
                                :id, :project_id, :paper_id, :status, :roles_json, :summary,
                                :contributions_json, :relevance, :reading_focus_json,
                                :created_at, :updated_at
                            )
                            """,
                            membership_values,
                        )
                        membership_row = connection.execute(
                            "SELECT * FROM project_papers WHERE id = ?", (item["project"]["id"],)
                        ).fetchone()
                        outcome = BatchOutcome.CREATED if paper_created else BatchOutcome.REUSED
                    else:
                        outcome = BatchOutcome.UNCHANGED
                    paper_row = connection.execute(
                        "SELECT * FROM papers WHERE id = ?", (paper_id,)
                    ).fetchone()
                    results.append(
                        PaperBatchItemResult(
                            outcome=outcome,
                            paper=self._paper_from_row(connection, paper_row),
                            project=self._membership_from_row(membership_row),
                        )
                    )
        except sqlite3.IntegrityError as error:
            raise ResourceConflictError("paper batch violates a uniqueness constraint") from error
        return results

    def update_paper(self, paper_id: str, changes: dict[str, Any], updated_at: str) -> Paper:
        allowed = {
            "title",
            "title_zh",
            "authors_json",
            "authors_complete",
            "abstract",
            "publication_year",
            "venue",
            "publication_state",
            "links_json",
        }
        assignments = [f"{key} = ?" for key in changes if key in allowed]
        identifiers = changes.get("identifiers")
        if assignments or identifiers is not None:
            try:
                with self.database.connection() as connection:
                    if identifiers is not None:
                        for identifier in identifiers:
                            conflict = connection.execute(
                                """
                                SELECT paper_id FROM paper_identifiers
                                WHERE scheme = ? AND normalized_value = ? AND paper_id != ?
                                """,
                                (
                                    identifier["scheme"],
                                    identifier["normalized_value"],
                                    paper_id,
                                ),
                            ).fetchone()
                            if conflict:
                                raise ResourceConflictError("identifier belongs to another paper")
                        connection.execute(
                            "DELETE FROM paper_identifiers WHERE paper_id = ?", (paper_id,)
                        )
                        for identifier in identifiers:
                            connection.execute(
                                """
                                INSERT INTO paper_identifiers(
                                    id, paper_id, scheme, value, normalized_value,
                                    is_primary, source
                                ) VALUES(
                                    :id, :paper_id, :scheme, :value, :normalized_value,
                                    :is_primary, :source
                                )
                                """,
                                {**identifier, "paper_id": paper_id},
                            )
                        primary = identifiers[0]
                        connection.execute(
                            "UPDATE papers SET identity_key = ? WHERE id = ?",
                            (
                                f"{primary['scheme']}:{primary['normalized_value']}",
                                paper_id,
                            ),
                        )
                    if assignments:
                        connection.execute(
                            f"UPDATE papers SET {', '.join(assignments)}, "
                            "updated_at = ? WHERE id = ?",
                            (
                                *[changes[key] for key in changes if key in allowed],
                                updated_at,
                                paper_id,
                            ),
                        )
            except sqlite3.IntegrityError as error:
                raise ResourceConflictError("paper update violates identity constraints") from error
        return self.get(paper_id)

    def update_membership(
        self, project_id: str, paper_id: str, changes: dict[str, Any], updated_at: str
    ) -> ProjectPaper:
        allowed = {
            "status",
            "roles_json",
            "summary",
            "contributions_json",
            "relevance",
            "reading_focus_json",
        }
        assignments = [f"{key} = ?" for key in changes if key in allowed]
        if assignments:
            with self.database.connection() as connection:
                cursor = connection.execute(
                    f"UPDATE project_papers SET {', '.join(assignments)}, updated_at = ? "
                    "WHERE project_id = ? AND paper_id = ?",
                    (
                        *[changes[key] for key in changes if key in allowed],
                        updated_at,
                        project_id,
                        paper_id,
                    ),
                )
            if cursor.rowcount == 0:
                raise ResourceNotFoundError("论文不在该项目中")
        return self.get_membership(project_id, paper_id)

from __future__ import annotations

import json

from app.catalog.queries import CatalogQueries
from app.platform.db import WorkspaceDatabase
from app.platform.public_projection import (
    sanitize_public_payload,
    sanitize_public_text,
    sanitize_public_url,
)

from .domain import CandidateState, ProjectWorkStatus, ScreeningNotFoundError
from .models import CandidatePage, CandidateView, ProjectView, ProjectWorkPage, ProjectWorkView


class ScreeningQueries:
    def __init__(self, database: WorkspaceDatabase):
        self.database = database

    def list_projects(self) -> list[ProjectView]:
        with self.database.read() as connection:
            rows = connection.execute(
                """
                SELECT p.*, COUNT(pw.id) AS work_count,
                       (
                           SELECT COUNT(*) FROM candidates candidate
                           WHERE candidate.project_id = p.id
                             AND candidate.state IN ('staged', 'matched')
                       ) AS candidate_count
                FROM projects p
                LEFT JOIN project_works pw ON pw.project_id = p.id
                GROUP BY p.id
                ORDER BY p.name COLLATE NOCASE
                """
            ).fetchall()
            counts = connection.execute(
                """
                SELECT project_id, status, COUNT(*) AS count
                FROM project_works GROUP BY project_id, status
                """
            ).fetchall()
        status_counts: dict[str, dict[str, int]] = {}
        for row in counts:
            status_counts.setdefault(str(row["project_id"]), {})[str(row["status"])] = int(
                row["count"]
            )
        return [
            ProjectView.model_validate(
                {**dict(row), "status_counts": status_counts.get(str(row["id"]), {})}
            )
            for row in rows
        ]

    def get_project(self, project_id: str) -> ProjectView:
        projects = {project.id: project for project in self.list_projects()}
        if project_id not in projects:
            raise ScreeningNotFoundError("project does not exist")
        return projects[project_id]

    def get_candidate(self, project_id: str, candidate_id: str) -> CandidateView:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM candidates WHERE id = ? AND project_id = ?",
                (candidate_id, project_id),
            ).fetchone()
        if row is None:
            raise ScreeningNotFoundError("candidate does not exist")
        with self.database.read() as connection:
            return self._candidate(connection, row)

    def list_candidates(
        self,
        project_id: str,
        *,
        state: CandidateState | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> CandidatePage:
        self.get_project(project_id)
        condition = "project_id = ?"
        parameters: list[object] = [project_id]
        if state is not None:
            condition += " AND state = ?"
            parameters.append(state.value)
        page_limit = min(max(limit, 1), 500)
        page_offset = max(offset, 0)
        with self.database.read() as connection:
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) FROM candidates WHERE {condition}",  # noqa: S608
                    parameters,
                ).fetchone()[0]
            )
            rows = connection.execute(
                f"""
                SELECT * FROM candidates WHERE {condition}
                ORDER BY rank IS NULL, rank, created_at DESC, id DESC
                LIMIT ? OFFSET ?
                """,
                (*parameters, page_limit, page_offset),
            ).fetchall()
            return CandidatePage(
                items=[self._candidate(connection, row) for row in rows],
                total=total,
                limit=page_limit,
                offset=page_offset,
            )

    def get_project_work(self, project_id: str, work_id: str) -> ProjectWorkView:
        with self.database.read() as connection:
            row = connection.execute(
                """
                SELECT pw.*, item.id AS preferred_item_id, item.title,
                       item.translated_title, item.item_type, item.issued_year
                FROM project_works pw
                JOIN bibliographic_items item
                  ON item.work_id = pw.work_id AND item.is_preferred_for_work = 1
                WHERE pw.project_id = ? AND pw.work_id = ?
                """,
                (project_id, work_id),
            ).fetchone()
            if row is None:
                raise ScreeningNotFoundError("work is not in the project")
            return self._project_work(connection, row)

    def list_project_works(
        self,
        project_id: str,
        *,
        status: ProjectWorkStatus | str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> ProjectWorkPage:
        self.get_project(project_id)
        condition = "pw.project_id = ?"
        parameters: list[object] = [project_id]
        if status is not None:
            condition += " AND pw.status = ?"
            parameters.append(
                status.value if isinstance(status, ProjectWorkStatus) else status
            )
        page_limit = min(max(limit, 1), 500)
        page_offset = max(offset, 0)
        with self.database.read() as connection:
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) FROM project_works pw WHERE {condition}",  # noqa: S608
                    parameters,
                ).fetchone()[0]
            )
            rows = connection.execute(
                f"""
                SELECT pw.*, item.id AS preferred_item_id, item.title,
                       item.translated_title, item.item_type, item.issued_year
                FROM project_works pw
                JOIN bibliographic_items item
                  ON item.work_id = pw.work_id AND item.is_preferred_for_work = 1
                WHERE {condition}
                ORDER BY item.issued_year DESC, item.title COLLATE NOCASE, pw.id
                LIMIT ? OFFSET ?
                """,
                (*parameters, page_limit, page_offset),
            ).fetchall()
            return ProjectWorkPage(
                items=[self._project_work(connection, row) for row in rows],
                total=total,
                limit=page_limit,
                offset=page_offset,
            )

    @staticmethod
    def _candidate(connection, row) -> CandidateView:
        evidence = []
        matched_item = None
        if row["matched_work_id"]:
            matched_row = connection.execute(
                """
                SELECT * FROM bibliographic_items
                WHERE work_id = ? AND is_preferred_for_work = 1
                """,
                (row["matched_work_id"],),
            ).fetchone()
            if matched_row is not None:
                matched_item = CatalogQueries._hydrate_items(connection, [matched_row])[0]
        if row["source_record_id"]:
            source = connection.execute(
                "SELECT * FROM source_records WHERE id = ?", (row["source_record_id"],)
            ).fetchone()
            if source is not None:
                evidence.append(
                    {
                        "id": source["id"],
                        "provider": source["provider"],
                        "external_key": source["external_key"],
                        "url": (
                            sanitize_public_url(source["source_url"])
                            if source["source_url"]
                            else None
                        ),
                        "captured_at": source["retrieved_at"],
                        "summary": sanitize_public_text(row["rationale"]),
                        "fields": sanitize_public_payload(json.loads(source["payload_json"])),
                    }
                )
        return CandidateView.model_validate(
            {
                **dict(row),
                "item": json.loads(row["proposed_item_json"]),
                "matched_item": matched_item,
                "evidence": evidence,
            }
        )

    @staticmethod
    def _project_work(connection, row) -> ProjectWorkView:
        roles = [
            value[0]
            for value in connection.execute(
                "SELECT role FROM project_work_roles WHERE project_work_id = ? ORDER BY role",
                (row["id"],),
            )
        ]
        notes = connection.execute(
            """
            SELECT kind, text FROM project_work_notes
            WHERE project_work_id = ? ORDER BY kind, position
            """,
            (row["id"],),
        ).fetchall()
        return ProjectWorkView.model_validate(
            {
                **dict(row),
                "roles": roles,
                "contributions": [item["text"] for item in notes if item["kind"] == "contribution"],
                "reading_focus": [
                    item["text"] for item in notes if item["kind"] == "reading_focus"
                ],
            }
        )

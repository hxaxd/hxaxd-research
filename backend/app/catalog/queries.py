from __future__ import annotations

import sqlite3

from app.platform.db import WorkspaceDatabase

from .domain import CatalogNotFoundError
from .models import (
    BibliographicItemView,
    CreatorView,
    IdentifierView,
    LinkView,
    TagView,
    WorkList,
    WorkView,
)


class CatalogQueries:
    def __init__(self, database: WorkspaceDatabase):
        self.database = database

    def get_work(self, work_id: str) -> WorkView:
        with self.database.read() as connection:
            work = connection.execute("SELECT * FROM works WHERE id = ?", (work_id,)).fetchone()
            if work is None:
                raise CatalogNotFoundError("work does not exist")
            items = connection.execute(
                """
                SELECT * FROM bibliographic_items
                WHERE work_id = ?
                ORDER BY is_preferred_for_work DESC, issued_year DESC, created_at
                """,
                (work_id,),
            ).fetchall()
            hydrated = self._hydrate_items(connection, items)
        return WorkView(
            id=work["id"],
            items=hydrated,
            created_at=work["created_at"],
            updated_at=work["updated_at"],
        )

    def get_item(self, item_id: str) -> BibliographicItemView:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM bibliographic_items WHERE id = ?", (item_id,)
            ).fetchone()
            if row is None:
                raise CatalogNotFoundError("bibliographic item does not exist")
            return self._hydrate_items(connection, [row])[0]

    def get_project_item(self, project_id: str, item_id: str) -> BibliographicItemView:
        """Return an item only when its work is visible in the requested project."""

        with self.database.read() as connection:
            row = connection.execute(
                """
                SELECT item.*
                FROM bibliographic_items item
                JOIN project_works membership ON membership.work_id = item.work_id
                WHERE membership.project_id = ? AND item.id = ?
                """,
                (project_id, item_id),
            ).fetchone()
            if row is None:
                raise CatalogNotFoundError("bibliographic item is not in the project")
            return self._hydrate_items(connection, [row])[0]

    def list_works(
        self, *, search: str | None = None, limit: int = 50, offset: int = 0
    ) -> WorkList:
        limit = min(max(limit, 1), 200)
        offset = max(offset, 0)
        condition = ""
        parameters: list[object] = []
        if search and search.strip():
            condition = (
                "WHERE EXISTS (SELECT 1 FROM bibliographic_items candidate "
                "WHERE candidate.work_id = w.id AND "
                "(candidate.title LIKE ? COLLATE NOCASE OR "
                "candidate.abstract LIKE ? COLLATE NOCASE OR "
                "candidate.container_title LIKE ? COLLATE NOCASE))"
            )
            pattern = f"%{search.strip()}%"
            parameters.extend([pattern, pattern, pattern])
        with self.database.read() as connection:
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) FROM works w {condition}", parameters
                ).fetchone()[0]
            )
            work_rows = connection.execute(
                f"""
                SELECT w.* FROM works w {condition}
                ORDER BY w.updated_at DESC, w.id
                LIMIT ? OFFSET ?
                """,
                [*parameters, limit, offset],
            ).fetchall()
            work_ids = [str(row["id"]) for row in work_rows]
            items_by_work: dict[str, list[BibliographicItemView]] = {
                work_id: [] for work_id in work_ids
            }
            if work_ids:
                placeholders = ",".join("?" for _ in work_ids)
                item_rows = connection.execute(
                    f"""
                    SELECT * FROM bibliographic_items
                    WHERE work_id IN ({placeholders})
                    ORDER BY is_preferred_for_work DESC, issued_year DESC, created_at
                    """,
                    work_ids,
                ).fetchall()
                for item in self._hydrate_items(connection, item_rows):
                    items_by_work[item.work_id].append(item)
        return WorkList(
            items=[
                WorkView(
                    id=row["id"],
                    items=items_by_work[str(row["id"])],
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                )
                for row in work_rows
            ],
            total=total,
            limit=limit,
            offset=offset,
        )

    @staticmethod
    def _hydrate_items(
        connection: sqlite3.Connection, rows: list[sqlite3.Row]
    ) -> list[BibliographicItemView]:
        if not rows:
            return []
        item_ids = [str(row["id"]) for row in rows]
        placeholders = ",".join("?" for _ in item_ids)
        creators: dict[str, list[CreatorView]] = {item_id: [] for item_id in item_ids}
        identifiers: dict[str, list[IdentifierView]] = {item_id: [] for item_id in item_ids}
        links: dict[str, list[LinkView]] = {item_id: [] for item_id in item_ids}
        tags: dict[str, list[TagView]] = {item_id: [] for item_id in item_ids}
        for row in connection.execute(
            f"""
            SELECT * FROM item_creators WHERE item_id IN ({placeholders})
            ORDER BY item_id, role, position
            """,
            item_ids,
        ):
            creators[str(row["item_id"])].append(CreatorView.model_validate(dict(row)))
        for row in connection.execute(
            f"""
            SELECT * FROM item_identifiers WHERE item_id IN ({placeholders})
            ORDER BY item_id, is_primary DESC, scheme, normalized_value
            """,
            item_ids,
        ):
            identifiers[str(row["item_id"])].append(
                IdentifierView.model_validate(
                    {
                        **dict(row),
                        "is_primary": bool(row["is_primary"]),
                        "is_identity": bool(row["is_identity"]),
                    }
                )
            )
        for row in connection.execute(
            f"""
            SELECT * FROM item_links WHERE item_id IN ({placeholders})
            ORDER BY item_id, relation_type, url
            """,
            item_ids,
        ):
            links[str(row["item_id"])].append(LinkView.model_validate(dict(row)))
        for row in connection.execute(
            f"""
            SELECT item_id, tag, kind FROM item_tags WHERE item_id IN ({placeholders})
            ORDER BY item_id, kind, tag COLLATE NOCASE
            """,
            item_ids,
        ):
            tags[str(row["item_id"])].append(TagView(name=str(row["tag"]), kind=str(row["kind"])))
        result = []
        for row in rows:
            item_id = str(row["id"])
            result.append(
                BibliographicItemView.model_validate(
                    {
                        **dict(row),
                        "creator_list_complete": bool(row["creator_list_complete"]),
                        "is_preferred_for_work": bool(row["is_preferred_for_work"]),
                        "creators": creators[item_id],
                        "identifiers": identifiers[item_id],
                        "links": links[item_id],
                        "tags": tags[item_id],
                    }
                )
            )
        return result

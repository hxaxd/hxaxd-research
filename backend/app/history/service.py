from __future__ import annotations

import json
import sqlite3
from typing import Any

from app.platform.db import WorkspaceDatabase
from app.platform.public_projection import sanitize_public_payload, sanitize_public_url

from .models import (
    AttachmentRelationView,
    AuditEventPage,
    AuditEventView,
    DocumentGlossaryEntryView,
    ItemFieldSourceView,
    ItemHistoryView,
    ItemRevisionView,
)


class HistoryNotFoundError(LookupError):
    pass


class HistoryQueryService:
    """Read-only public projection for provenance and audit data."""

    def __init__(self, database: WorkspaceDatabase) -> None:
        self.database = database

    def audit_events(
        self,
        *,
        entity_type: str | None = None,
        entity_id: str | None = None,
        correlation_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> AuditEventPage:
        clauses: list[str] = []
        values: list[object] = []
        for column, value in (
            ("entity_type", entity_type),
            ("entity_id", entity_id),
            ("correlation_id", correlation_id),
        ):
            if value is not None:
                clauses.append(f"{column} = ?")
                values.append(value)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self.database.read() as connection:
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) FROM audit_events{where}", values  # noqa: S608
                ).fetchone()[0]
            )
            rows = connection.execute(
                f"""
                SELECT * FROM audit_events{where}
                ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?
                """,  # noqa: S608
                [*values, limit, offset],
            ).fetchall()
        return AuditEventPage(
            items=[self._audit_event(row) for row in rows],
            total=total,
            limit=limit,
            offset=offset,
        )

    def item_history(self, item_id: str) -> ItemHistoryView:
        with self.database.read() as connection:
            self._require(connection, "bibliographic_items", item_id, "文献不存在")
            revision_rows = connection.execute(
                """
                SELECT * FROM item_revisions WHERE item_id = ?
                ORDER BY revision DESC
                """,
                (item_id,),
            ).fetchall()
            source_rows = connection.execute(
                """
                SELECT source.field_path, source.source_record_id, source.selected_at,
                       record.provider, record.external_key, record.source_url,
                       record.retrieved_at
                FROM item_field_sources source
                JOIN source_records record ON record.id = source.source_record_id
                WHERE source.item_id = ? ORDER BY source.field_path
                """,
                (item_id,),
            ).fetchall()
            relation_rows = connection.execute(
                """
                SELECT relation.*, parent.filename AS parent_filename,
                       child.filename AS child_filename
                FROM attachment_relations relation
                JOIN attachments parent ON parent.id = relation.parent_attachment_id
                JOIN attachments child ON child.id = relation.child_attachment_id
                WHERE parent.item_id = ? OR child.item_id = ?
                ORDER BY relation.created_at DESC
                """,
                (item_id, item_id),
            ).fetchall()
            audit_rows = connection.execute(
                """
                SELECT * FROM audit_events
                WHERE entity_id = ?
                ORDER BY occurred_at DESC, id DESC LIMIT 200
                """,
                (item_id,),
            ).fetchall()
        return ItemHistoryView(
            item_id=item_id,
            revisions=[
                ItemRevisionView(
                    id=str(row["id"]),
                    revision=int(row["revision"]),
                    actor_type=str(row["actor_type"]),
                    actor_id=row["actor_id"],
                    change_set_id=row["change_set_id"],
                    changes=self._object(row["changes_json"]),
                    evidence=self._list(row["evidence_json"]),
                    created_at=row["created_at"],
                )
                for row in revision_rows
            ],
            field_sources=[
                ItemFieldSourceView(
                    field_path=str(row["field_path"]),
                    source_record_id=str(row["source_record_id"]),
                    provider=str(row["provider"]),
                    external_key=row["external_key"],
                    source_url=(
                        sanitize_public_url(str(row["source_url"]))
                        if row["source_url"]
                        else None
                    ),
                    retrieved_at=row["retrieved_at"],
                    selected_at=row["selected_at"],
                )
                for row in source_rows
            ],
            attachment_relations=[
                AttachmentRelationView.model_validate(dict(row)) for row in relation_rows
            ],
            audit_events=[self._audit_event(row) for row in audit_rows],
        )

    def document_glossary(
        self, document_id: str, *, target_language: str | None = None
    ) -> list[DocumentGlossaryEntryView]:
        with self.database.read() as connection:
            self._require(connection, "documents", document_id, "结构化文档不存在")
            if target_language is None:
                rows = connection.execute(
                    """
                    SELECT * FROM document_glossary_entries WHERE document_id = ?
                    ORDER BY target_language, source_term
                    """,
                    (document_id,),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT * FROM document_glossary_entries
                    WHERE document_id = ? AND target_language = ?
                    ORDER BY source_term
                    """,
                    (document_id, target_language),
                ).fetchall()
        return [DocumentGlossaryEntryView.model_validate(dict(row)) for row in rows]

    @classmethod
    def _audit_event(cls, row: sqlite3.Row) -> AuditEventView:
        before = cls._nullable_object(row["before_json"])
        after = cls._nullable_object(row["after_json"])
        return AuditEventView(
            id=str(row["id"]),
            occurred_at=row["occurred_at"],
            actor_type=str(row["actor_type"]),
            actor_id=row["actor_id"],
            action=str(row["action"]),
            entity_type=str(row["entity_type"]),
            entity_id=str(row["entity_id"]),
            correlation_id=row["correlation_id"],
            before=sanitize_public_payload(before) if before is not None else None,
            after=sanitize_public_payload(after) if after is not None else None,
            metadata=sanitize_public_payload(cls._object(row["metadata_json"])),
        )

    @staticmethod
    def _require(
        connection: sqlite3.Connection, table: str, entity_id: str, message: str
    ) -> None:
        if connection.execute(
            f"SELECT 1 FROM {table} WHERE id = ?", (entity_id,)  # noqa: S608
        ).fetchone() is None:
            raise HistoryNotFoundError(message)

    @staticmethod
    def _object(value: str) -> dict[str, Any]:
        decoded = json.loads(value)
        return sanitize_public_payload(decoded) if isinstance(decoded, dict) else {}

    @staticmethod
    def _nullable_object(value: str | None) -> dict[str, Any] | None:
        return HistoryQueryService._object(value) if value is not None else None

    @staticmethod
    def _list(value: str) -> list[dict[str, Any]]:
        decoded = json.loads(value)
        return [
            sanitize_public_payload(item)
            for item in decoded
            if isinstance(item, dict)
        ] if isinstance(decoded, list) else []

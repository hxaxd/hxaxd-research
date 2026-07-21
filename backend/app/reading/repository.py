from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from app.platform.db import WorkspaceDatabase
from app.utils.identity import new_id

from .models import (
    Annotation,
    AnnotationCreate,
    AnnotationUpdate,
    ReadingBookmark,
    ReadingBookmarkCreate,
    ReadingState,
    ReadingStateUpdate,
)


class ReadingNotFoundError(LookupError):
    pass


class ReadingConflictError(RuntimeError):
    pass


class ReadingRepository:
    def __init__(self, database: WorkspaceDatabase) -> None:
        self.database = database

    def list_annotations(self, project_id: str, item_id: str) -> list[Annotation]:
        with self.database.read() as connection:
            self._require_scope(connection, project_id, item_id)
            rows = connection.execute(
                """
                SELECT * FROM annotations
                WHERE project_id = ? AND item_id = ?
                ORDER BY created_at, id
                """,
                (project_id, item_id),
            ).fetchall()
            tags = self._annotation_tags(connection, [str(row["id"]) for row in rows])
        return [self._annotation(row, tags.get(str(row["id"]), [])) for row in rows]

    def create_annotation(
        self, project_id: str, item_id: str, payload: AnnotationCreate
    ) -> Annotation:
        now = _now()
        annotation_id = new_id()
        with self.database.transaction() as connection:
            self._require_scope(connection, project_id, item_id)
            values = self._annotation_anchor(connection, item_id, payload)
            connection.execute(
                """
                INSERT INTO annotations(
                    id, project_id, item_id, attachment_id, block_id, kind,
                    body, quoted_text, source_sha256, page_number, anchor_json,
                    anchor_status, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?)
                """,
                (
                    annotation_id,
                    project_id,
                    item_id,
                    values["attachment_id"],
                    values["block_id"],
                    payload.kind.value,
                    payload.body,
                    values["quoted_text"],
                    values["source_sha256"],
                    values["page_number"],
                    _json(values["anchor"]),
                    now,
                    now,
                ),
            )
            self._replace_tags(connection, annotation_id, payload.tags)
            row = connection.execute(
                "SELECT * FROM annotations WHERE id = ?", (annotation_id,)
            ).fetchone()
            assert row is not None
            result = self._annotation(row, payload.tags)
            self._audit(
                connection,
                action="annotation.created",
                entity_type="annotation",
                entity_id=annotation_id,
                after=result.model_dump(mode="json"),
                metadata={"project_id": project_id, "item_id": item_id},
            )
        return result

    def update_annotation(self, annotation_id: str, payload: AnnotationUpdate) -> Annotation:
        now = _now()
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM annotations WHERE id = ?", (annotation_id,)
            ).fetchone()
            if row is None:
                raise ReadingNotFoundError("批注不存在")
            tags = self._annotation_tags(connection, [annotation_id]).get(annotation_id, [])
            before = self._annotation(row, tags)
            if before.updated_at != payload.expected_updated_at:
                raise ReadingConflictError("批注已经被其他操作修改，请刷新后重试")
            connection.execute(
                """
                UPDATE annotations SET kind = ?, body = ?, updated_at = ?
                WHERE id = ?
                """,
                (payload.kind.value, payload.body, now, annotation_id),
            )
            self._replace_tags(connection, annotation_id, payload.tags)
            updated = connection.execute(
                "SELECT * FROM annotations WHERE id = ?", (annotation_id,)
            ).fetchone()
            assert updated is not None
            result = self._annotation(updated, payload.tags)
            self._audit(
                connection,
                action="annotation.updated",
                entity_type="annotation",
                entity_id=annotation_id,
                before=before.model_dump(mode="json"),
                after=result.model_dump(mode="json"),
                metadata={"item_id": result.item_id},
            )
        return result

    def delete_annotation(self, annotation_id: str, expected_updated_at: datetime) -> None:
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM annotations WHERE id = ?", (annotation_id,)
            ).fetchone()
            if row is None:
                raise ReadingNotFoundError("批注不存在")
            tags = self._annotation_tags(connection, [annotation_id]).get(annotation_id, [])
            before = self._annotation(row, tags)
            if before.updated_at != expected_updated_at:
                raise ReadingConflictError("批注已经被其他操作修改，请刷新后重试")
            connection.execute("DELETE FROM annotations WHERE id = ?", (annotation_id,))
            self._audit(
                connection,
                action="annotation.deleted",
                entity_type="annotation",
                entity_id=annotation_id,
                before=before.model_dump(mode="json"),
                metadata={"item_id": before.item_id},
            )

    def get_reading_state(self, project_id: str, item_id: str) -> ReadingState:
        with self.database.read() as connection:
            self._require_scope(connection, project_id, item_id)
            row = connection.execute(
                "SELECT * FROM reading_states WHERE project_id = ? AND item_id = ?",
                (project_id, item_id),
            ).fetchone()
        return self._reading_state(row, project_id, item_id)

    def update_reading_state(
        self, project_id: str, item_id: str, payload: ReadingStateUpdate
    ) -> ReadingState:
        now = _now()
        with self.database.transaction() as connection:
            self._require_scope(connection, project_id, item_id)
            self._require_reading_anchor(
                connection,
                item_id,
                attachment_id=payload.attachment_id,
                block_id=payload.block_id,
            )
            previous = connection.execute(
                "SELECT * FROM reading_states WHERE project_id = ? AND item_id = ?",
                (project_id, item_id),
            ).fetchone()
            bookmarks = previous["bookmarks_json"] if previous is not None else "[]"
            connection.execute(
                """
                INSERT INTO reading_states(
                    project_id, item_id, attachment_id, block_id, page_number,
                    progress, bookmarks_json, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id, item_id) DO UPDATE SET
                    attachment_id = excluded.attachment_id,
                    block_id = excluded.block_id,
                    page_number = excluded.page_number,
                    progress = excluded.progress,
                    updated_at = excluded.updated_at
                """,
                (
                    project_id,
                    item_id,
                    payload.attachment_id,
                    payload.block_id,
                    payload.page_number,
                    payload.progress,
                    bookmarks,
                    now,
                ),
            )
            row = connection.execute(
                "SELECT * FROM reading_states WHERE project_id = ? AND item_id = ?",
                (project_id, item_id),
            ).fetchone()
            assert row is not None
            result = self._reading_state(row, project_id, item_id)
            self._audit(
                connection,
                action="reading_state.updated",
                entity_type="reading_state",
                entity_id=f"{project_id}:{item_id}",
                before=(
                    self._reading_state(previous, project_id, item_id).model_dump(mode="json")
                    if previous is not None
                    else None
                ),
                after=result.model_dump(mode="json"),
                metadata={"progress": result.progress},
            )
        return result

    def add_bookmark(
        self, project_id: str, item_id: str, payload: ReadingBookmarkCreate
    ) -> ReadingState:
        with self.database.transaction() as connection:
            self._require_scope(connection, project_id, item_id)
            self._require_reading_anchor(
                connection, item_id, attachment_id=None, block_id=payload.block_id
            )
            row = connection.execute(
                "SELECT * FROM reading_states WHERE project_id = ? AND item_id = ?",
                (project_id, item_id),
            ).fetchone()
            state = self._reading_state(row, project_id, item_id)
            if any(
                bookmark.block_id == payload.block_id
                and bookmark.page_number == payload.page_number
                for bookmark in state.bookmarks
            ):
                return state
            bookmark = ReadingBookmark(id=new_id(), created_at=_now(), **payload.model_dump())
            bookmarks = [*state.bookmarks, bookmark]
            result = self._write_bookmarks(connection, project_id, item_id, row, bookmarks)
            self._audit(
                connection,
                action="reading_bookmark.created",
                entity_type="reading_state",
                entity_id=f"{project_id}:{item_id}",
                after=bookmark.model_dump(mode="json"),
                metadata={"bookmark_count": len(bookmarks)},
            )
        return result

    def delete_bookmark(self, project_id: str, item_id: str, bookmark_id: str) -> ReadingState:
        with self.database.transaction() as connection:
            self._require_scope(connection, project_id, item_id)
            row = connection.execute(
                "SELECT * FROM reading_states WHERE project_id = ? AND item_id = ?",
                (project_id, item_id),
            ).fetchone()
            state = self._reading_state(row, project_id, item_id)
            removed = next(
                (bookmark for bookmark in state.bookmarks if bookmark.id == bookmark_id),
                None,
            )
            if removed is None:
                raise ReadingNotFoundError("书签不存在")
            bookmarks = [bookmark for bookmark in state.bookmarks if bookmark.id != bookmark_id]
            result = self._write_bookmarks(connection, project_id, item_id, row, bookmarks)
            self._audit(
                connection,
                action="reading_bookmark.deleted",
                entity_type="reading_state",
                entity_id=f"{project_id}:{item_id}",
                before=removed.model_dump(mode="json"),
                metadata={"bookmark_count": len(bookmarks)},
            )
        return result

    @staticmethod
    def _require_scope(connection: sqlite3.Connection, project_id: str, item_id: str) -> None:
        row = connection.execute(
            """
            SELECT 1 FROM project_works pw
            JOIN bibliographic_items i ON i.work_id = pw.work_id
            WHERE pw.project_id = ? AND i.id = ?
            """,
            (project_id, item_id),
        ).fetchone()
        if row is None:
            raise ReadingNotFoundError("项目中不存在这篇文献")

    @staticmethod
    def _annotation_anchor(
        connection: sqlite3.Connection, item_id: str, payload: AnnotationCreate
    ) -> dict[str, Any]:
        result = {
            "attachment_id": payload.attachment_id,
            "block_id": payload.block_id,
            "quoted_text": payload.quoted_text,
            "source_sha256": None,
            "page_number": payload.page_number,
            "anchor": payload.anchor,
        }
        if payload.attachment_id is not None:
            attachment = connection.execute(
                """
                SELECT a.item_id, b.sha256 FROM attachments a
                JOIN blobs b ON b.id = a.blob_id WHERE a.id = ?
                """,
                (payload.attachment_id,),
            ).fetchone()
            if attachment is None or attachment["item_id"] != item_id:
                raise ReadingConflictError("批注附件不属于当前文献")
            result["source_sha256"] = attachment["sha256"]
        if payload.block_id is not None:
            block = connection.execute(
                """
                SELECT b.source_text, b.source_sha256, b.page_start, b.anchor_json,
                    d.item_id, d.source_attachment_id, d.source_sha256 AS document_sha256
                FROM document_blocks b JOIN documents d ON d.id = b.document_id
                WHERE b.id = ?
                """,
                (payload.block_id,),
            ).fetchone()
            if block is None or block["item_id"] != item_id:
                raise ReadingConflictError("批注阅读块不属于当前文献")
            if payload.attachment_id and payload.attachment_id != block["source_attachment_id"]:
                raise ReadingConflictError("批注附件与阅读块来源不一致")
            block_anchor = json.loads(block["anchor_json"])
            if payload.quoted_text and payload.quoted_text not in block["source_text"]:
                raise ReadingConflictError("批注引文不属于当前阅读块")
            anchor = {**block_anchor, **payload.anchor}
            if payload.quoted_text:
                anchor["text_quote"] = {
                    "type": "TextQuoteSelector",
                    "exact": payload.quoted_text,
                }
            result.update(
                {
                    "attachment_id": block["source_attachment_id"],
                    "quoted_text": payload.quoted_text or block["source_text"],
                    "source_sha256": block["document_sha256"],
                    "page_number": payload.page_number or block["page_start"],
                    "anchor": anchor,
                }
            )
        return result

    @staticmethod
    def _require_reading_anchor(
        connection: sqlite3.Connection,
        item_id: str,
        *,
        attachment_id: str | None,
        block_id: str | None,
    ) -> None:
        if attachment_id is not None:
            attachment = connection.execute(
                "SELECT item_id FROM attachments WHERE id = ?", (attachment_id,)
            ).fetchone()
            if attachment is None or attachment["item_id"] != item_id:
                raise ReadingConflictError("阅读位置附件不属于当前文献")
        if block_id is not None:
            block = connection.execute(
                """
                SELECT d.item_id FROM document_blocks b
                JOIN documents d ON d.id = b.document_id WHERE b.id = ?
                """,
                (block_id,),
            ).fetchone()
            if block is None or block["item_id"] != item_id:
                raise ReadingConflictError("阅读位置块不属于当前文献")

    def _write_bookmarks(
        self,
        connection: sqlite3.Connection,
        project_id: str,
        item_id: str,
        previous: sqlite3.Row | None,
        bookmarks: list[ReadingBookmark],
    ) -> ReadingState:
        now = _now()
        connection.execute(
            """
            INSERT INTO reading_states(
                project_id, item_id, attachment_id, block_id, page_number,
                progress, bookmarks_json, updated_at
            ) VALUES(?, ?, NULL, NULL, NULL, 0, ?, ?)
            ON CONFLICT(project_id, item_id) DO UPDATE SET
                bookmarks_json = excluded.bookmarks_json,
                updated_at = excluded.updated_at
            """,
            (
                project_id,
                item_id,
                _json([bookmark.model_dump(mode="json") for bookmark in bookmarks]),
                now,
            ),
        )
        row = connection.execute(
            "SELECT * FROM reading_states WHERE project_id = ? AND item_id = ?",
            (project_id, item_id),
        ).fetchone()
        assert row is not None
        return self._reading_state(row, project_id, item_id)

    @staticmethod
    def _annotation_tags(
        connection: sqlite3.Connection, annotation_ids: list[str]
    ) -> dict[str, list[str]]:
        if not annotation_ids:
            return {}
        placeholders = ",".join("?" for _ in annotation_ids)
        rows = connection.execute(
            f"""
            SELECT annotation_id, tag FROM annotation_tags
            WHERE annotation_id IN ({placeholders}) ORDER BY tag
            """,  # noqa: S608 - placeholders are generated, not user input
            annotation_ids,
        ).fetchall()
        result: dict[str, list[str]] = {}
        for row in rows:
            result.setdefault(str(row["annotation_id"]), []).append(str(row["tag"]))
        return result

    @staticmethod
    def _replace_tags(connection: sqlite3.Connection, annotation_id: str, tags: list[str]) -> None:
        connection.execute("DELETE FROM annotation_tags WHERE annotation_id = ?", (annotation_id,))
        connection.executemany(
            "INSERT INTO annotation_tags(annotation_id, tag) VALUES(?, ?)",
            [(annotation_id, tag) for tag in tags],
        )

    @staticmethod
    def _annotation(row: sqlite3.Row, tags: list[str]) -> Annotation:
        values = dict(row)
        values["anchor"] = json.loads(values.pop("anchor_json"))
        values["tags"] = tags
        return Annotation.model_validate(values)

    @staticmethod
    def _reading_state(row: sqlite3.Row | None, project_id: str, item_id: str) -> ReadingState:
        if row is None:
            return ReadingState(project_id=project_id, item_id=item_id)
        return ReadingState(
            project_id=project_id,
            item_id=item_id,
            attachment_id=row["attachment_id"],
            block_id=row["block_id"],
            page_number=row["page_number"],
            progress=row["progress"],
            bookmarks=[
                ReadingBookmark.model_validate(bookmark)
                for bookmark in json.loads(row["bookmarks_json"])
            ],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _audit(
        connection: sqlite3.Connection,
        *,
        action: str,
        entity_type: str,
        entity_id: str,
        before: dict[str, Any] | None = None,
        after: dict[str, Any] | None = None,
        metadata: dict[str, Any],
    ) -> None:
        connection.execute(
            """
            INSERT INTO audit_events(
                id, occurred_at, actor_type, actor_id, action,
                entity_type, entity_id, correlation_id,
                before_json, after_json, metadata_json
            ) VALUES(?, ?, 'user', 'local-user', ?, ?, ?, NULL, ?, ?, ?)
            """,
            (
                new_id(),
                _now(),
                action,
                entity_type,
                entity_id,
                _json(before) if before is not None else None,
                _json(after) if after is not None else None,
                _json(metadata),
            ),
        )


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

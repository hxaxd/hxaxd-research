from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import AbstractContextManager
from typing import Protocol

from .errors import AttachmentConflictError, AttachmentNotFoundError
from .models import Attachment


class DatabasePort(Protocol):
    def read(self) -> AbstractContextManager[sqlite3.Connection]: ...

    def transaction(self) -> AbstractContextManager[sqlite3.Connection]: ...


class AttachmentRepository:
    def __init__(self, database: DatabasePort):
        self.database = database

    @staticmethod
    def _from_row(row: sqlite3.Row, purposes: list[str] | None = None) -> Attachment:
        return Attachment.model_validate(
            {**dict(row), "preferred_for": purposes or []}
        )

    @staticmethod
    def _select() -> str:
        return """
            SELECT a.*, b.sha256, b.size, b.media_type, bo.storage_key
            FROM attachments a
            JOIN blobs b ON b.id = a.blob_id
            JOIN blob_objects bo ON bo.blob_id = b.id
                AND bo.is_primary = 1 AND bo.state = 'available'
        """

    def get(self, attachment_id: str) -> Attachment:
        with self.database.read() as connection:
            row = connection.execute(
                self._select() + " WHERE a.id = ?", (attachment_id,)
            ).fetchone()
            if row is None:
                raise AttachmentNotFoundError("附件不存在")
            purposes = [
                item["purpose"]
                for item in connection.execute(
                    "SELECT purpose FROM attachment_preferences WHERE attachment_id = ?",
                    (attachment_id,),
                )
            ]
        return self._from_row(row, purposes)

    def list_for_item(self, item_id: str) -> list[Attachment]:
        with self.database.read() as connection:
            rows = connection.execute(
                self._select()
                + " WHERE a.item_id = ? ORDER BY a.created_at DESC, a.id",
                (item_id,),
            ).fetchall()
            preferences: dict[str, list[str]] = {}
            for row in connection.execute(
                "SELECT attachment_id, purpose FROM attachment_preferences WHERE item_id = ?",
                (item_id,),
            ):
                preferences.setdefault(row["attachment_id"], []).append(row["purpose"])
        return [self._from_row(row, preferences.get(row["id"])) for row in rows]

    def outputs_for_job(
        self, job_id: str, roles: list[str]
    ) -> dict[str, Attachment]:
        if not roles:
            return {}
        placeholders = ",".join("?" for _ in roles)
        with self.database.read() as connection:
            rows = connection.execute(
                self._select()
                + f" WHERE a.created_by_job_id = ? "
                f"AND a.operation_role IN ({placeholders})",
                (job_id, *roles),
            ).fetchall()
            preferences: dict[str, list[str]] = {}
            attachment_ids = [str(row["id"]) for row in rows]
            if attachment_ids:
                attachment_placeholders = ",".join("?" for _ in attachment_ids)
                for row in connection.execute(
                    f"""
                    SELECT attachment_id, purpose FROM attachment_preferences
                    WHERE attachment_id IN ({attachment_placeholders})
                    """,
                    attachment_ids,
                ):
                    preferences.setdefault(str(row["attachment_id"]), []).append(
                        str(row["purpose"])
                    )
        return {
            str(row["operation_role"]): self._from_row(
                row, preferences.get(str(row["id"]))
            )
            for row in rows
        }

    def insert_many(
        self,
        connection: sqlite3.Connection,
        records: list[dict],
    ) -> None:
        try:
            for record in records:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO blobs(
                        id, sha256, size, media_type, created_at, verified_at
                    ) VALUES(:blob_id, :sha256, :size, :media_type, :created_at, :created_at)
                    """,
                    record,
                )
                existing_object = connection.execute(
                    """
                    SELECT storage_key FROM blob_objects
                    WHERE blob_id = ? AND is_primary = 1
                        AND state IN ('staged', 'available')
                    """,
                    (record["blob_id"],),
                ).fetchone()
                if existing_object is None:
                    connection.execute(
                        """
                        INSERT INTO blob_objects(
                            id, blob_id, storage_backend, storage_key,
                            is_primary, state, created_at
                        ) VALUES(
                            :object_id, :blob_id, 'local', :storage_key,
                            1, 'staged', :created_at
                        )
                        """,
                        record,
                    )
                else:
                    record["object_id"] = None
                    record["storage_key"] = existing_object["storage_key"]
                connection.execute(
                    """
                    INSERT INTO attachments(
                        id, item_id, blob_id, created_by_job_id, operation_role,
                        attachment_type, format, language_mode, origin, filename,
                        source_url, created_at
                    ) VALUES(
                        :id, :item_id, :blob_id, :created_by_job_id, :operation_role,
                        :attachment_type, :format, :language_mode, :origin, :filename,
                        :source_url, :created_at
                    )
                    """,
                    record,
                )
                for purpose in record["preferred_for"]:
                    connection.execute(
                        """
                        INSERT INTO attachment_preferences(
                            item_id, purpose, attachment_id, updated_at
                        ) VALUES(?, ?, ?, ?)
                        ON CONFLICT(item_id, purpose) DO UPDATE SET
                            attachment_id = excluded.attachment_id,
                            updated_at = excluded.updated_at
                        """,
                        (record["item_id"], purpose, record["id"], record["created_at"]),
                    )
        except sqlite3.IntegrityError as error:
            raise AttachmentConflictError("附件登记违反唯一性约束") from error

    @staticmethod
    def mark_objects_ready(
        connection: sqlite3.Connection, object_ids: Iterator[str] | list[str]
    ) -> None:
        connection.executemany(
            "UPDATE blob_objects SET state = 'available' WHERE id = ?",
            ((object_id,) for object_id in object_ids),
        )

    def set_preference(self, item_id: str, purpose: str, attachment_id: str, now: str) -> None:
        attachment = self.get(attachment_id)
        if attachment.item_id != item_id:
            raise AttachmentConflictError("首选附件不属于该文献版本")
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO attachment_preferences(item_id, purpose, attachment_id, updated_at)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(item_id, purpose) DO UPDATE SET
                    attachment_id = excluded.attachment_id,
                    updated_at = excluded.updated_at
                """,
                (item_id, purpose, attachment_id, now),
            )

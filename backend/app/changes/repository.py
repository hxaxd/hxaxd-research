from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import UTC, datetime

from app.platform.db import V3Database

from .domain import ChangeSetConflictError, ChangeSetNotFoundError
from .models import (
    ChangeItemStatus,
    ChangeItemView,
    ChangeReviewDecision,
    ChangeSetCreate,
    ChangeSetList,
    ChangeSetStatus,
    ChangeSetView,
)


def _id() -> str:
    return uuid.uuid4().hex


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class ChangeSetRepository:
    def __init__(self, database: V3Database) -> None:
        self.database = database

    def create(
        self,
        payload: ChangeSetCreate,
        *,
        content_hash: str,
        agent_run_id: str | None,
        actor_type: str,
        actor_id: str | None,
    ) -> ChangeSetView:
        now = _now()
        change_set_id = _id()
        with self.database.transaction() as connection:
            if agent_run_id is not None:
                existing = connection.execute(
                    """
                    SELECT id FROM change_sets
                    WHERE agent_run_id = ? AND content_hash = ?
                    """,
                    (agent_run_id, content_hash),
                ).fetchone()
                if existing is not None:
                    return self._get_in(connection, str(existing["id"]))
            connection.execute(
                """
                INSERT INTO change_sets(
                    id, kind, status, agent_run_id, project_id, item_id,
                    source_version, content_hash, summary, created_at, submitted_at
                ) VALUES(?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    change_set_id,
                    payload.kind.value,
                    agent_run_id,
                    payload.project_id,
                    payload.item_id,
                    payload.source_version,
                    content_hash,
                    payload.summary,
                    now,
                    now,
                ),
            )
            for position, item in enumerate(payload.items):
                connection.execute(
                    """
                    INSERT INTO change_items(
                        id, change_set_id, position, operation, target_type,
                        target_id, base_revision, status, payload_json,
                        evidence_json, rationale, created_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)
                    """,
                    (
                        _id(),
                        change_set_id,
                        position,
                        item.operation,
                        item.target_type,
                        item.target_id,
                        str(item.base_revision),
                        _json(item.payload.model_dump(mode="json", exclude_unset=True)),
                        _json([entry.model_dump(mode="json") for entry in item.evidence]),
                        item.rationale,
                        now,
                    ),
                )
            self._audit(
                connection,
                now=now,
                actor_type=actor_type,
                actor_id=actor_id,
                action="changes.submitted",
                entity_type="change_set",
                entity_id=change_set_id,
                correlation_id=agent_run_id,
                metadata={"kind": payload.kind.value, "content_hash": content_hash},
            )
            return self._get_in(connection, change_set_id)

    def get(self, change_set_id: str) -> ChangeSetView:
        with self.database.read() as connection:
            return self._get_in(connection, change_set_id)

    def list(
        self,
        *,
        status: ChangeSetStatus | None = None,
        project_id: str | None = None,
        item_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> ChangeSetList:
        conditions: list[str] = []
        parameters: list[object] = []
        if status is not None:
            conditions.append("status = ?")
            parameters.append(status.value)
        if project_id is not None:
            conditions.append("project_id = ?")
            parameters.append(project_id)
        if item_id is not None:
            conditions.append("item_id = ?")
            parameters.append(item_id)
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        with self.database.read() as connection:
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) FROM change_sets{where}",  # noqa: S608
                    parameters,
                ).fetchone()[0]
            )
            rows = connection.execute(
                f"""
                SELECT id FROM change_sets{where}
                ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
                """,  # noqa: S608
                (*parameters, limit, offset),
            ).fetchall()
            items = [self._get_in(connection, str(row["id"])) for row in rows]
        return ChangeSetList(items=items, total=total, limit=limit, offset=offset)

    def review(
        self,
        change_set_id: str,
        *,
        expected_content_hash: str,
        decisions: list[ChangeReviewDecision],
        reviewed_by: str,
    ) -> ChangeSetView:
        now = _now()
        with self.database.transaction() as connection:
            change_set = connection.execute(
                "SELECT * FROM change_sets WHERE id = ?", (change_set_id,)
            ).fetchone()
            if change_set is None:
                raise ChangeSetNotFoundError("change set does not exist")
            if change_set["content_hash"] != expected_content_hash:
                raise ChangeSetConflictError("change set content hash changed")
            if change_set["status"] in {"applied", "stale"}:
                raise ChangeSetConflictError("change set can no longer be reviewed")
            for decision in decisions:
                row = connection.execute(
                    """
                    SELECT status FROM change_items
                    WHERE id = ? AND change_set_id = ?
                    """,
                    (decision.change_item_id, change_set_id),
                ).fetchone()
                if row is None:
                    raise ChangeSetNotFoundError("change item does not belong to change set")
                if row["status"] in {"applied", "stale"}:
                    raise ChangeSetConflictError("applied or stale change item cannot be reviewed")
                next_status = (
                    ChangeItemStatus.APPROVED.value
                    if decision.decision == "approve"
                    else ChangeItemStatus.REJECTED.value
                )
                connection.execute(
                    """
                    UPDATE change_items
                    SET status = ?, reviewed_at = ?, error_code = NULL, error_message = NULL
                    WHERE id = ?
                    """,
                    (next_status, now, decision.change_item_id),
                )
            statuses = {
                str(row[0])
                for row in connection.execute(
                    "SELECT status FROM change_items WHERE change_set_id = ?",
                    (change_set_id,),
                )
            }
            set_status = (
                ChangeSetStatus.REJECTED.value
                if statuses == {ChangeItemStatus.REJECTED.value}
                else ChangeSetStatus.SUBMITTED.value
            )
            connection.execute(
                """
                UPDATE change_sets
                SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?
                """,
                (set_status, now, reviewed_by, change_set_id),
            )
            self._audit(
                connection,
                now=now,
                actor_type="user",
                actor_id=reviewed_by,
                action="changes.reviewed",
                entity_type="change_set",
                entity_id=change_set_id,
                metadata={
                    "decisions": [decision.model_dump(mode="json") for decision in decisions]
                },
            )
            return self._get_in(connection, change_set_id)

    def mark_item(
        self,
        change_item_id: str,
        status: ChangeItemStatus,
        *,
        result: dict | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        now = _now()
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE change_items
                SET status = ?, result_json = ?, error_code = ?, error_message = ?,
                    applied_at = CASE WHEN ? = 'applied' THEN ? ELSE applied_at END
                WHERE id = ?
                """,
                (
                    status.value,
                    _json(result) if result is not None else None,
                    error_code,
                    error_message,
                    status.value,
                    now,
                    change_item_id,
                ),
            )
            if cursor.rowcount != 1:
                raise ChangeSetNotFoundError("change item does not exist")

    def finish_apply(self, change_set_id: str, status: ChangeSetStatus) -> ChangeSetView:
        now = _now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE change_sets SET status = ?, applied_at = ? WHERE id = ?
                """,
                (status.value, now, change_set_id),
            )
            self._audit(
                connection,
                now=now,
                actor_type="user",
                actor_id="local-user",
                action="changes.apply_finished",
                entity_type="change_set",
                entity_id=change_set_id,
                metadata={"status": status.value},
            )
            return self._get_in(connection, change_set_id)

    @staticmethod
    def _audit(
        connection: sqlite3.Connection,
        *,
        now: str,
        actor_type: str,
        actor_id: str | None,
        action: str,
        entity_type: str,
        entity_id: str,
        metadata: dict,
        correlation_id: str | None = None,
    ) -> None:
        connection.execute(
            """
            INSERT INTO audit_events(
                id, occurred_at, actor_type, actor_id, action,
                entity_type, entity_id, correlation_id, metadata_json
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _id(), now, actor_type, actor_id, action, entity_type, entity_id,
                correlation_id, _json(metadata),
            ),
        )

    @staticmethod
    def _get_in(connection: sqlite3.Connection, change_set_id: str) -> ChangeSetView:
        row = connection.execute(
            "SELECT * FROM change_sets WHERE id = ?", (change_set_id,)
        ).fetchone()
        if row is None:
            raise ChangeSetNotFoundError("change set does not exist")
        item_rows = connection.execute(
            """
            SELECT * FROM change_items
            WHERE change_set_id = ? ORDER BY position
            """,
            (change_set_id,),
        ).fetchall()
        items = [
            ChangeItemView.model_validate(
                {
                    **{
                        key: item[key]
                        for key in (
                            "id",
                            "position",
                            "operation",
                            "target_type",
                            "target_id",
                            "base_revision",
                            "status",
                            "rationale",
                            "error_code",
                            "error_message",
                            "created_at",
                            "reviewed_at",
                            "applied_at",
                        )
                    },
                    "payload": json.loads(item["payload_json"]),
                    "evidence": json.loads(item["evidence_json"]),
                    "result": (
                        json.loads(item["result_json"])
                        if item["result_json"] is not None
                        else None
                    ),
                }
            )
            for item in item_rows
        ]
        return ChangeSetView.model_validate({**dict(row), "items": items})

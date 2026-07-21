from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from app.platform.db import V3Database
from app.utils.identity import new_id

from .models import UserPreferences, UserPreferencesUpdate


class PreferencesConflictError(RuntimeError):
    pass


class PreferencesRepository:
    def __init__(self, database: V3Database) -> None:
        self.database = database

    def get(self) -> UserPreferences:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM user_preferences WHERE id = 'singleton'"
            ).fetchone()
        if row is None:
            return UserPreferences(revision=0)
        payload = json.loads(row["preferences_json"])
        return UserPreferences.model_validate(
            {"revision": row["revision"], **payload, "updated_at": row["updated_at"]}
        )

    def update(self, payload: UserPreferencesUpdate) -> UserPreferences:
        now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        values = payload.model_dump(mode="json", exclude={"expected_revision"})
        encoded = json.dumps(values, ensure_ascii=False, separators=(",", ":"))
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM user_preferences WHERE id = 'singleton'"
            ).fetchone()
            revision = int(row["revision"]) if row is not None else 0
            if revision != payload.expected_revision:
                raise PreferencesConflictError("设置已经改变，请刷新后重试")
            next_revision = revision + 1
            connection.execute(
                """
                INSERT INTO user_preferences(id, revision, preferences_json, updated_at)
                VALUES('singleton', ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    revision = excluded.revision,
                    preferences_json = excluded.preferences_json,
                    updated_at = excluded.updated_at
                """,
                (next_revision, encoded, now),
            )
            connection.execute(
                """
                INSERT INTO audit_events(
                    id, occurred_at, actor_type, actor_id, action, entity_type,
                    entity_id, correlation_id, before_json, after_json, metadata_json
                ) VALUES(?, ?, 'user', 'local-user', ?, ?, ?, NULL, ?, ?, '{}')
                """,
                (
                    new_id(),
                    now,
                    "user_preferences.updated",
                    "user_preferences",
                    "singleton",
                    _json(
                        {"revision": revision, "preferences": json.loads(row["preferences_json"])}
                        if row is not None
                        else None
                    ),
                    _json({"revision": next_revision, "preferences": values}),
                ),
            )
        return UserPreferences.model_validate(
            {"revision": next_revision, **values, "updated_at": now}
        )


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)

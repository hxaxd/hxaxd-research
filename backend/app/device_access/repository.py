from __future__ import annotations

import hashlib
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from app.platform.db import WorkspaceDatabase
from app.utils.identity import new_id

from .models import DeviceSession


class PairingCodeError(ValueError):
    pass


class DeviceSessionNotFoundError(LookupError):
    pass


class DeviceAccessRepository:
    def __init__(self, database: WorkspaceDatabase) -> None:
        self.database = database

    def create_pairing(
        self,
        *,
        code: str,
        label: str | None,
        ttl_seconds: int,
    ) -> tuple[str, str]:
        pairing_id = new_id()
        now = _now()
        expires_at = _timestamp(_utcnow() + timedelta(seconds=ttl_seconds))
        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM device_pairings WHERE claimed_at IS NOT NULL OR expires_at <= ?",
                (now,),
            )
            connection.execute(
                """
                INSERT INTO device_pairings(
                    id, code_digest, label, expires_at, claimed_at, created_at
                ) VALUES(?, ?, ?, ?, NULL, ?)
                """,
                (pairing_id, _digest(code), label, expires_at, now),
            )
            self._audit(
                connection,
                action="device_pairing.created",
                entity_type="device_pairing",
                entity_id=pairing_id,
                after={"label": label, "expires_at": expires_at},
            )
        return pairing_id, expires_at

    def claim_pairing(
        self,
        *,
        code: str,
        label: str,
        user_agent: str | None,
        session_days: int,
    ) -> tuple[str, DeviceSession]:
        now = _now()
        expires_at = _timestamp(_utcnow() + timedelta(days=session_days))
        session_id = new_id()
        token = _session_token()
        with self.database.transaction() as connection:
            pairing = connection.execute(
                """
                SELECT id FROM device_pairings
                WHERE code_digest = ? AND claimed_at IS NULL AND expires_at > ?
                """,
                (_digest(code), now),
            ).fetchone()
            if pairing is None:
                raise PairingCodeError("配对码无效、已使用或已经过期")
            claimed = connection.execute(
                """
                UPDATE device_pairings SET claimed_at = ?
                WHERE id = ? AND claimed_at IS NULL AND expires_at > ?
                """,
                (now, pairing["id"], now),
            )
            if claimed.rowcount != 1:
                raise PairingCodeError("配对码无效、已使用或已经过期")
            connection.execute(
                """
                INSERT INTO device_sessions(
                    id, token_digest, label, user_agent, created_at,
                    last_seen_at, expires_at, revoked_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    session_id,
                    _digest(token),
                    label,
                    user_agent,
                    now,
                    now,
                    expires_at,
                ),
            )
            row = connection.execute(
                "SELECT * FROM device_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            assert row is not None
            session = self._session(row)
            self._audit(
                connection,
                action="device_session.created",
                entity_type="device_session",
                entity_id=session_id,
                after=session.model_dump(mode="json", exclude={"current"}),
            )
        return token, session

    def session_for_token(self, token: str) -> DeviceSession | None:
        now = _now()
        with self.database.read() as connection:
            row = connection.execute(
                """
                SELECT * FROM device_sessions
                WHERE token_digest = ? AND revoked_at IS NULL AND expires_at > ?
                """,
                (_digest(token), now),
            ).fetchone()
        if row is None:
            return None
        session = self._session(row)
        if session.last_seen_at < _utcnow() - timedelta(minutes=5):
            with self.database.transaction() as connection:
                connection.execute(
                    """
                    UPDATE device_sessions SET last_seen_at = ?
                    WHERE id = ? AND revoked_at IS NULL
                    """,
                    (now, session.id),
                )
            session = session.model_copy(update={"last_seen_at": datetime.fromisoformat(now)})
        return session

    def list_sessions(self, current_session_id: str | None) -> list[DeviceSession]:
        with self.database.read() as connection:
            rows = connection.execute(
                "SELECT * FROM device_sessions ORDER BY revoked_at IS NULL DESC, last_seen_at DESC"
            ).fetchall()
        return [
            self._session(row).model_copy(update={"current": str(row["id"]) == current_session_id})
            for row in rows
        ]

    def revoke_session(self, session_id: str) -> DeviceSession:
        now = _now()
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM device_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if row is None:
                raise DeviceSessionNotFoundError("设备会话不存在")
            before = self._session(row)
            connection.execute(
                "UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
                (now, session_id),
            )
            updated = connection.execute(
                "SELECT * FROM device_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            assert updated is not None
            result = self._session(updated)
            self._audit(
                connection,
                action="device_session.revoked",
                entity_type="device_session",
                entity_id=session_id,
                before=before.model_dump(mode="json", exclude={"current"}),
                after=result.model_dump(mode="json", exclude={"current"}),
            )
        return result

    @staticmethod
    def _session(row: sqlite3.Row) -> DeviceSession:
        values = dict(row)
        values.pop("token_digest", None)
        return DeviceSession.model_validate(values)

    @staticmethod
    def _audit(
        connection: sqlite3.Connection,
        *,
        action: str,
        entity_type: str,
        entity_id: str,
        before: dict[str, Any] | None = None,
        after: dict[str, Any] | None = None,
    ) -> None:
        import json

        connection.execute(
            """
            INSERT INTO audit_events(
                id, occurred_at, actor_type, actor_id, action,
                entity_type, entity_id, correlation_id,
                before_json, after_json, metadata_json
            ) VALUES(?, ?, 'user', 'local-user', ?, ?, ?, NULL, ?, ?, '{}')
            """,
            (
                new_id(),
                _now(),
                action,
                entity_type,
                entity_id,
                json.dumps(before, ensure_ascii=False, sort_keys=True) if before else None,
                json.dumps(after, ensure_ascii=False, sort_keys=True) if after else None,
            ),
        )


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _now() -> str:
    return _timestamp(_utcnow())


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _session_token() -> str:
    import secrets

    return secrets.token_urlsafe(32)

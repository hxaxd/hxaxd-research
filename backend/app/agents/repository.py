from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from .models import (
    AgentEvent,
    AgentRun,
    AgentRunCreate,
    AgentRunStatus,
    Approval,
    ApprovalDecision,
    ApprovalStatus,
)


class AgentNotFoundError(LookupError):
    pass


class AgentConflictError(RuntimeError):
    pass


REQUIRED_TABLE_COLUMNS = {
    "agent_runs": {
        "id",
        "task_kind",
        "goal",
        "status",
        "prompt",
        "context_hash",
        "project_id",
        "item_id",
        "target_type",
        "target_id",
        "tool_scopes_json",
        "runtime",
        "reasoning_effort",
        "provider_thread_id",
    },
    "agent_events": {"id", "run_id", "event_type", "visibility", "payload_json"},
    "approvals": {
        "id",
        "run_id",
        "provider_request_id",
        "kind",
        "status",
        "approvable",
        "decision",
    },
}


class SqliteAgentRunRepository:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path

    def initialize_schema(self) -> None:
        if not self.database_path.is_file():
            raise RuntimeError("initialize the workspace database before agent repositories")
        with self._connection() as connection:
            for table, required in REQUIRED_TABLE_COLUMNS.items():
                existing = {
                    row["name"]
                    for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
                }
                if not required.issubset(existing):
                    raise RuntimeError(
                        f"workspace table {table} does not match the agent runtime contract"
                    )

    def create(self, request: AgentRunCreate) -> AgentRun:
        now = _now()
        with self._transaction() as connection:
            connection.execute(
                """
                INSERT INTO agent_runs(
                    id, project_id, item_id, target_type, target_id,
                    task_kind, goal, status, prompt, prompt_version,
                    context_hash, cwd, tool_scopes_json, runtime, runtime_version,
                    model, reasoning_effort, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request.id,
                    request.project_id,
                    request.item_id,
                    request.target_type,
                    request.target_id,
                    request.task_kind,
                    request.goal,
                    request.prompt,
                    request.prompt_version,
                    request.context_hash,
                    request.cwd,
                    _json(request.tool_scopes),
                    request.runtime,
                    request.runtime_version,
                    request.model,
                    request.reasoning_effort,
                    _iso(now),
                    _iso(now),
                ),
            )
            self._append_event(connection, request.id, "run.created", {})
        return self.get(request.id)

    def get(self, run_id: str) -> AgentRun:
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM agent_runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            raise AgentNotFoundError(f"agent run not found: {run_id}")
        return self._run(row)

    def list_runs(
        self,
        *,
        project_id: str | None = None,
        status: AgentRunStatus | None = None,
        limit: int = 200,
    ) -> list[AgentRun]:
        clauses: list[str] = []
        values: list[Any] = []
        if project_id is not None:
            clauses.append("project_id = ?")
            values.append(project_id)
        if status is not None:
            clauses.append("status = ?")
            values.append(status.value)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        values.append(min(max(limit, 1), 1000))
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM agent_runs {where} ORDER BY created_at DESC LIMIT ?",  # noqa: S608
                values,
            ).fetchall()
        return [self._run(row) for row in rows]

    def transition(
        self,
        run_id: str,
        status: AgentRunStatus,
        *,
        provider_thread_id: str | None = None,
        provider_turn_id: str | None = None,
        final_message: str | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> AgentRun:
        now = _now()
        with self._transaction(immediate=True) as connection:
            current = self._require_run(connection, run_id)
            current_status = AgentRunStatus(current["status"])
            if not _allowed_transition(current_status, status):
                raise AgentConflictError(
                    f"agent run cannot transition from {current_status.value} to {status.value}"
                )
            started_at = (
                _iso(now)
                if status in {AgentRunStatus.STARTING, AgentRunStatus.RUNNING}
                and current["started_at"] is None
                else current["started_at"]
            )
            finished_at = _iso(now) if status.terminal else None
            connection.execute(
                """
                UPDATE agent_runs SET status = ?,
                    provider_thread_id = COALESCE(?, provider_thread_id),
                    provider_turn_id = COALESCE(?, provider_turn_id),
                    final_message = COALESCE(?, final_message), error_code = ?, error_message = ?,
                    updated_at = ?, started_at = ?, finished_at = ? WHERE id = ?
                """,
                (
                    status.value,
                    provider_thread_id,
                    provider_turn_id,
                    final_message,
                    error_code,
                    error_message,
                    _iso(now),
                    started_at,
                    finished_at,
                    run_id,
                ),
            )
            self._append_event(connection, run_id, f"run.{status.value}", {})
            updated = self._require_run(connection, run_id)
        return self._run(updated)

    def prepare_resume(self, run_id: str) -> AgentRun:
        now = _now()
        with self._transaction(immediate=True) as connection:
            current = self._require_run(connection, run_id)
            status = AgentRunStatus(current["status"])
            if status not in {AgentRunStatus.CANCELED, AgentRunStatus.FAILED}:
                raise AgentConflictError(f"agent run cannot resume from {status.value}")
            resume_mode = (
                "provider_thread" if current["provider_thread_id"] else "new_provider_thread"
            )
            connection.execute(
                """
                UPDATE agent_runs SET status = 'created', provider_turn_id = NULL,
                    final_message = NULL, error_code = NULL, error_message = NULL,
                    updated_at = ?, finished_at = NULL, cancel_requested_at = NULL WHERE id = ?
                """,
                (_iso(now), run_id),
            )
            self._append_event(
                connection,
                run_id,
                "run.resumed",
                {"mode": resume_mode},
            )
            updated = self._require_run(connection, run_id)
        return self._run(updated)

    def reconcile_interrupted(self) -> int:
        """Closes agent state that cannot still have a live runtime after process restart."""

        now = _now()
        interrupted_statuses = (
            AgentRunStatus.STARTING.value,
            AgentRunStatus.RUNNING.value,
            AgentRunStatus.WAITING_APPROVAL.value,
            AgentRunStatus.CANCELLATION_REQUESTED.value,
        )
        reconciled = 0
        with self._transaction(immediate=True) as connection:
            rows = connection.execute(
                """
                SELECT * FROM agent_runs
                WHERE status IN ('starting', 'running', 'waiting_approval',
                                 'cancellation_requested')
                ORDER BY created_at
                """
            ).fetchall()
            for row in rows:
                if row["status"] not in interrupted_statuses:
                    continue
                reconciled += 1
                pending = connection.execute(
                    """
                    SELECT id FROM approvals
                    WHERE run_id = ? AND status = 'pending'
                    ORDER BY created_at
                    """,
                    (row["id"],),
                ).fetchall()
                for approval in pending:
                    connection.execute(
                        """
                        UPDATE approvals SET status = 'denied', decision = 'cancel',
                            decided_at = ? WHERE id = ? AND status = 'pending'
                        """,
                        (_iso(now), approval["id"]),
                    )
                    self._append_event(
                        connection,
                        row["id"],
                        "approval.resolved",
                        {
                            "approval_id": approval["id"],
                            "decision": ApprovalDecision.CANCEL.value,
                            "status": ApprovalStatus.DENIED.value,
                            "reason": "server_restarted",
                        },
                    )
                canceled = row["status"] == AgentRunStatus.CANCELLATION_REQUESTED.value
                target = AgentRunStatus.CANCELED if canceled else AgentRunStatus.FAILED
                error_code = None if canceled else "agent_worker_restarted"
                error_message = (
                    None if canceled else "agent runtime was interrupted by a server restart"
                )
                connection.execute(
                    """
                    UPDATE agent_runs SET status = ?, error_code = ?, error_message = ?,
                        updated_at = ?, finished_at = ? WHERE id = ?
                    """,
                    (
                        target.value,
                        error_code,
                        error_message,
                        _iso(now),
                        _iso(now),
                        row["id"],
                    ),
                )
                self._append_event(
                    connection,
                    row["id"],
                    f"run.{target.value}",
                    {"reason": "server_restarted", "previous_status": row["status"]},
                )
        return reconciled

    def request_cancel(self, run_id: str) -> AgentRun:
        now = _now()
        with self._transaction(immediate=True) as connection:
            current = self._require_run(connection, run_id)
            status = AgentRunStatus(current["status"])
            if status.terminal:
                return self._run(current)
            target = (
                AgentRunStatus.CANCELED
                if status is AgentRunStatus.CREATED
                else AgentRunStatus.CANCELLATION_REQUESTED
            )
            connection.execute(
                """
                UPDATE agent_runs SET status = ?, cancel_requested_at = ?, updated_at = ?,
                    finished_at = ? WHERE id = ?
                """,
                (
                    target.value,
                    _iso(now),
                    _iso(now),
                    _iso(now) if target.terminal else None,
                    run_id,
                ),
            )
            self._append_event(connection, run_id, f"run.{target.value}", {})
            updated = self._require_run(connection, run_id)
        return self._run(updated)

    def append_event(
        self,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        visibility: str = "public",
    ) -> AgentEvent:
        with self._transaction() as connection:
            self._require_run(connection, run_id)
            event_id = self._append_event(
                connection, run_id, event_type, payload, visibility=visibility
            )
            row = connection.execute(
                "SELECT * FROM agent_events WHERE id = ?", (event_id,)
            ).fetchone()
        assert row is not None
        return self._event(row)

    def list_events(
        self,
        run_id: str,
        *,
        after: int = 0,
        limit: int = 1000,
        visibility: str | None = None,
    ) -> list[AgentEvent]:
        self.get(run_id)
        visibility_clause = " AND visibility = ?" if visibility is not None else ""
        values: list[Any] = [run_id, after]
        if visibility is not None:
            values.append(visibility)
        values.append(min(max(limit, 1), 5000))
        with self._connection() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM agent_events WHERE run_id = ? AND id > ?
                {visibility_clause} ORDER BY id LIMIT ?
                """,
                values,
            ).fetchall()
        return [self._event(row) for row in rows]

    def create_approval(
        self,
        run_id: str,
        provider_request_id: str,
        kind: str,
        request: dict[str, Any],
        *,
        approvable: bool,
    ) -> Approval:
        now = _now()
        approval_id = uuid4().hex
        with self._transaction(immediate=True) as connection:
            self._require_run(connection, run_id)
            connection.execute(
                """
                INSERT INTO approvals(
                    id, run_id, provider_request_id, kind, status, approvable,
                    request_json, created_at
                ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
                """,
                (
                    approval_id,
                    run_id,
                    provider_request_id,
                    kind,
                    int(approvable),
                    _json(request),
                    _iso(now),
                ),
            )
            self._append_event(
                connection,
                run_id,
                "approval.requested",
                {"approval_id": approval_id, "kind": kind, "approvable": approvable},
            )
        return self.get_approval(approval_id)

    def get_approval(self, approval_id: str) -> Approval:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM approvals WHERE id = ?", (approval_id,)
            ).fetchone()
        if row is None:
            raise AgentNotFoundError(f"approval not found: {approval_id}")
        return self._approval(row)

    def pending_approvals(self, run_id: str) -> list[Approval]:
        self.get(run_id)
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM approvals
                WHERE run_id = ? AND status = 'pending' ORDER BY created_at
                """,
                (run_id,),
            ).fetchall()
        return [self._approval(row) for row in rows]

    def resolve_approval(
        self,
        approval_id: str,
        decision: ApprovalDecision,
        *,
        expired: bool = False,
    ) -> Approval:
        now = _now()
        with self._transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM approvals WHERE id = ?", (approval_id,)
            ).fetchone()
            if row is None:
                raise AgentNotFoundError(f"approval not found: {approval_id}")
            if row["status"] != ApprovalStatus.PENDING.value:
                raise AgentConflictError("approval has already been resolved")
            if decision is ApprovalDecision.APPROVE and not bool(row["approvable"]):
                raise AgentConflictError("this runtime request cannot be approved")
            status = (
                ApprovalStatus.EXPIRED
                if expired
                else ApprovalStatus.APPROVED
                if decision is ApprovalDecision.APPROVE
                else ApprovalStatus.DENIED
            )
            connection.execute(
                """
                UPDATE approvals SET status = ?, decision = ?, decided_at = ? WHERE id = ?
                """,
                (status.value, decision.value, _iso(now), approval_id),
            )
            self._append_event(
                connection,
                row["run_id"],
                "approval.resolved",
                {"approval_id": approval_id, "decision": decision.value, "status": status.value},
            )
            updated = connection.execute(
                "SELECT * FROM approvals WHERE id = ?", (approval_id,)
            ).fetchone()
        assert updated is not None
        return self._approval(updated)

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def _transaction(self, *, immediate: bool = True) -> Iterator[sqlite3.Connection]:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            try:
                yield connection
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    @staticmethod
    def _require_run(connection: sqlite3.Connection, run_id: str) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM agent_runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            raise AgentNotFoundError(f"agent run not found: {run_id}")
        return row

    @staticmethod
    def _append_event(
        connection: sqlite3.Connection,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        visibility: str = "public",
    ) -> int:
        cursor = connection.execute(
            """
            INSERT INTO agent_events(run_id, event_type, visibility, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (run_id, event_type, visibility, _json(payload), _iso(_now())),
        )
        return int(cursor.lastrowid)

    @staticmethod
    def _run(row: sqlite3.Row) -> AgentRun:
        values = dict(row)
        values["tool_scopes"] = tuple(json.loads(values.pop("tool_scopes_json")))
        return AgentRun.model_validate(values)

    @staticmethod
    def _event(row: sqlite3.Row) -> AgentEvent:
        values = dict(row)
        values["payload"] = json.loads(values.pop("payload_json"))
        return AgentEvent.model_validate(values)

    @staticmethod
    def _approval(row: sqlite3.Row) -> Approval:
        values = dict(row)
        values["approvable"] = bool(values["approvable"])
        values["request"] = json.loads(values.pop("request_json"))
        return Approval.model_validate(values)


def _allowed_transition(current: AgentRunStatus, target: AgentRunStatus) -> bool:
    if current is target:
        return True
    return (
        target
        in {
            AgentRunStatus.CREATED: {
                AgentRunStatus.STARTING,
                AgentRunStatus.CANCELED,
                AgentRunStatus.FAILED,
            },
            AgentRunStatus.STARTING: {
                AgentRunStatus.RUNNING,
                AgentRunStatus.CANCELLATION_REQUESTED,
                AgentRunStatus.FAILED,
            },
            AgentRunStatus.RUNNING: {
                AgentRunStatus.WAITING_APPROVAL,
                AgentRunStatus.CANCELLATION_REQUESTED,
                AgentRunStatus.COMPLETED,
                AgentRunStatus.FAILED,
            },
            AgentRunStatus.WAITING_APPROVAL: {
                AgentRunStatus.RUNNING,
                AgentRunStatus.CANCELLATION_REQUESTED,
                AgentRunStatus.FAILED,
            },
            AgentRunStatus.CANCELLATION_REQUESTED: {
                AgentRunStatus.CANCELED,
                AgentRunStatus.FAILED,
            },
            AgentRunStatus.CANCELED: set(),
            AgentRunStatus.COMPLETED: set(),
            AgentRunStatus.FAILED: set(),
        }[current]
    )


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from .models import (
    ClaimedJob,
    Job,
    JobAttachment,
    JobAttempt,
    JobAttemptStatus,
    JobCreate,
    JobEvent,
    JobStatus,
)


class JobNotFoundError(LookupError):
    pass


class JobConflictError(RuntimeError):
    pass


class JobSchemaError(RuntimeError):
    pass


REQUIRED_TABLE_COLUMNS = {
    "jobs": {
        "id",
        "kind",
        "status",
        "input_json",
        "max_attempts",
        "lease_owner",
        "available_at",
    },
    "job_attempts": {"id", "job_id", "attempt_number", "worker_id", "status"},
    "job_events": {"id", "job_id", "event_type", "payload_json"},
    "job_attachments": {"id", "job_id", "role", "attachment_id"},
}


class SqliteJobRepository:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path

    def initialize_schema(self) -> None:
        if not self.database_path.is_file():
            raise JobSchemaError("initialize the v3 database baseline before jobs")
        with self._connection() as connection:
            for table, required in REQUIRED_TABLE_COLUMNS.items():
                existing = {
                    row["name"]
                    for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
                }
                if not required.issubset(existing):
                    raise JobSchemaError(
                        f"v3 baseline table {table} does not match the jobs contract"
                    )

    def enqueue(self, request: JobCreate) -> Job:
        now = _now()
        job_id = uuid4().hex
        available_at = request.available_at or now
        try:
            with self._transaction(immediate=True) as connection:
                connection.execute(
                    """
                    INSERT INTO jobs(
                        id, kind, subject_type, subject_id, status, priority, input_json,
                        result_json, error_code, error_message, idempotency_key, concurrency_key,
                        max_attempts, created_at, updated_at, available_at
                    ) VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        request.kind,
                        request.subject_type,
                        request.subject_id,
                        request.priority,
                        _json(request.input),
                        request.idempotency_key,
                        request.concurrency_key,
                        request.max_attempts,
                        _iso(now),
                        _iso(now),
                        _iso(available_at),
                    ),
                )
                self._append_event(connection, job_id, None, "job.queued", {"kind": request.kind})
        except sqlite3.IntegrityError as error:
            if request.idempotency_key is not None:
                existing = self.find_by_idempotency_key(request.idempotency_key)
                if existing is not None:
                    return existing
            raise JobConflictError("an active job already owns this concurrency key") from error
        return self.get(job_id)

    def get(self, job_id: str) -> Job:
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise JobNotFoundError(f"job not found: {job_id}")
        return self._job(row)

    def list_jobs(
        self,
        *,
        status: JobStatus | None = None,
        kind: str | None = None,
        limit: int = 200,
    ) -> list[Job]:
        clauses: list[str] = []
        values: list[Any] = []
        if status is not None:
            clauses.append("status = ?")
            values.append(status.value)
        if kind is not None:
            clauses.append("kind = ?")
            values.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        values.append(min(max(limit, 1), 1000))
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM jobs {where} ORDER BY created_at DESC LIMIT ?",  # noqa: S608
                values,
            ).fetchall()
        return [self._job(row) for row in rows]

    def find_by_idempotency_key(self, key: str) -> Job | None:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE idempotency_key = ?", (key,)
            ).fetchone()
        return self._job(row) if row is not None else None

    def has_active_jobs(self, *, exclude_job_id: str | None = None) -> bool:
        with self._connection() as connection:
            if exclude_job_id is None:
                row = connection.execute(
                    """
                    SELECT 1 FROM jobs
                    WHERE status IN ('queued', 'running', 'cancellation_requested')
                    LIMIT 1
                    """
                ).fetchone()
            else:
                row = connection.execute(
                    """
                    SELECT 1 FROM jobs
                    WHERE status IN ('queued', 'running', 'cancellation_requested')
                      AND id != ?
                    LIMIT 1
                    """,
                    (exclude_job_id,),
                ).fetchone()
        return row is not None

    def active_for_subject(self, subject_type: str, subject_id: str) -> list[Job]:
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM jobs
                WHERE subject_type = ? AND subject_id = ?
                  AND status IN ('queued', 'running', 'cancellation_requested')
                ORDER BY created_at
                """,
                (subject_type, subject_id),
            ).fetchall()
        return [self._job(row) for row in rows]

    def attempts(self, job_id: str) -> list[JobAttempt]:
        self.get(job_id)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_number", (job_id,)
            ).fetchall()
        return [self._attempt(row) for row in rows]

    def attachments(self, job_id: str) -> list[JobAttachment]:
        self.get(job_id)
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM job_attachments WHERE job_id = ? ORDER BY created_at, id",
                (job_id,),
            ).fetchall()
        return [self._attachment(row) for row in rows]

    def list_events(self, job_id: str, *, after: int = 0, limit: int = 500) -> list[JobEvent]:
        self.get(job_id)
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM job_events
                WHERE job_id = ? AND id > ? ORDER BY id LIMIT ?
                """,
                (job_id, after, min(max(limit, 1), 2000)),
            ).fetchall()
        return [self._event(row) for row in rows]

    def append_event(
        self,
        job_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        *,
        attempt_id: str | None = None,
        level: str = "info",
    ) -> JobEvent:
        with self._transaction() as connection:
            self._require_job(connection, job_id)
            event_id = self._append_event(
                connection, job_id, attempt_id, event_type, payload or {}, level=level
            )
            row = connection.execute(
                "SELECT * FROM job_events WHERE id = ?", (event_id,)
            ).fetchone()
        assert row is not None
        return self._event(row)

    def claim_next(self, worker_id: str, *, lease_seconds: int = 30) -> ClaimedJob | None:
        now = _now()
        lease_expires = now + timedelta(seconds=lease_seconds)
        with self._transaction(immediate=True) as connection:
            row = connection.execute(
                """
                SELECT * FROM jobs
                WHERE status = 'queued' AND available_at <= ?
                ORDER BY priority DESC, available_at, created_at LIMIT 1
                """,
                (_iso(now),),
            ).fetchone()
            if row is None:
                return None
            attempt_number = (
                int(
                    connection.execute(
                        "SELECT COUNT(*) FROM job_attempts WHERE job_id = ?", (row["id"],)
                    ).fetchone()[0]
                )
                + 1
            )
            attempt_id = uuid4().hex
            connection.execute(
                """
                UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?,
                    heartbeat_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?,
                    finished_at = NULL
                WHERE id = ? AND status = 'queued'
                """,
                (
                    worker_id,
                    _iso(lease_expires),
                    _iso(now),
                    _iso(now),
                    _iso(now),
                    row["id"],
                ),
            )
            connection.execute(
                """
                INSERT INTO job_attempts(
                    id, job_id, attempt_number, worker_id, status, started_at, heartbeat_at
                ) VALUES (?, ?, ?, ?, 'running', ?, ?)
                """,
                (attempt_id, row["id"], attempt_number, worker_id, _iso(now), _iso(now)),
            )
            self._append_event(
                connection,
                row["id"],
                attempt_id,
                "job.started",
                {"attempt": attempt_number, "worker_id": worker_id},
            )
            job_row = connection.execute("SELECT * FROM jobs WHERE id = ?", (row["id"],)).fetchone()
            attempt_row = connection.execute(
                "SELECT * FROM job_attempts WHERE id = ?", (attempt_id,)
            ).fetchone()
        assert job_row is not None and attempt_row is not None
        return ClaimedJob(job=self._job(job_row), attempt=self._attempt(attempt_row))

    def heartbeat(
        self, job_id: str, attempt_id: str, worker_id: str, *, lease_seconds: int = 30
    ) -> bool:
        now = _now()
        with self._transaction() as connection:
            updated = connection.execute(
                """
                UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
                WHERE id = ? AND lease_owner = ?
                  AND status IN ('running', 'cancellation_requested')
                """,
                (
                    _iso(now),
                    _iso(now + timedelta(seconds=lease_seconds)),
                    _iso(now),
                    job_id,
                    worker_id,
                ),
            ).rowcount
            if updated:
                connection.execute(
                    "UPDATE job_attempts SET heartbeat_at = ? WHERE id = ? AND status = 'running'",
                    (_iso(now), attempt_id),
                )
        return bool(updated)

    def record_process(
        self,
        attempt_id: str,
        *,
        process_id: int | None,
        executable: str,
        exit_code: int | None = None,
    ) -> None:
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT job_id FROM job_attempts WHERE id = ?", (attempt_id,)
            ).fetchone()
            if row is None:
                raise JobNotFoundError(f"job attempt not found: {attempt_id}")
            connection.execute(
                """
                UPDATE job_attempts SET process_id = ?, executable = ?, exit_code = ?
                WHERE id = ? AND status = 'running'
                """,
                (process_id, executable, exit_code, attempt_id),
            )
            self._append_event(
                connection,
                row["job_id"],
                attempt_id,
                "process.finished" if exit_code is not None else "process.started",
                {
                    "process_id": process_id,
                    "executable": executable,
                    "exit_code": exit_code,
                },
            )

    def request_cancel(self, job_id: str) -> Job:
        now = _now()
        with self._transaction(immediate=True) as connection:
            row = self._require_job(connection, job_id)
            status = JobStatus(row["status"])
            if status.terminal:
                return self._job(row)
            target = (
                JobStatus.CANCELED
                if status is JobStatus.QUEUED
                else JobStatus.CANCELLATION_REQUESTED
            )
            finished_at = _iso(now) if target is JobStatus.CANCELED else None
            connection.execute(
                """
                UPDATE jobs SET status = ?, cancel_requested_at = ?, updated_at = ?,
                    finished_at = COALESCE(?, finished_at)
                WHERE id = ?
                """,
                (target.value, _iso(now), _iso(now), finished_at, job_id),
            )
            self._append_event(
                connection,
                job_id,
                None,
                "job.canceled" if target is JobStatus.CANCELED else "job.cancel_requested",
                {},
            )
            updated = self._require_job(connection, job_id)
        return self._job(updated)

    def resume(self, job_id: str) -> Job:
        now = _now()
        with self._transaction(immediate=True) as connection:
            row = self._require_job(connection, job_id)
            status = JobStatus(row["status"])
            if status not in {JobStatus.CANCELED, JobStatus.FAILED}:
                raise JobConflictError(f"job cannot be resumed from {status.value}")
            attempts = int(
                connection.execute(
                    "SELECT COUNT(*) FROM job_attempts WHERE job_id = ?", (job_id,)
                ).fetchone()[0]
            )
            connection.execute(
                """
                UPDATE jobs SET status = 'queued', max_attempts = MAX(max_attempts, ?),
                    result_json = NULL, error_code = NULL, error_message = NULL,
                    lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                    updated_at = ?, available_at = ?, finished_at = NULL,
                    cancel_requested_at = NULL
                WHERE id = ?
                """,
                (attempts + 1, _iso(now), _iso(now), job_id),
            )
            self._append_event(connection, job_id, None, "job.resumed", {})
            updated = self._require_job(connection, job_id)
        return self._job(updated)

    def complete(
        self,
        claimed: ClaimedJob,
        result: dict[str, Any],
        attachments: list[JobAttachment],
        *,
        commit_point_reached: bool = False,
    ) -> Job:
        now = _now()
        with self._transaction(immediate=True) as connection:
            row = self._require_owned(connection, claimed)
            cancellation_requested = (
                row["status"] == JobStatus.CANCELLATION_REQUESTED.value
            )
            cancellation = cancellation_requested and not commit_point_reached
            final_status = JobStatus.CANCELED if cancellation else JobStatus.SUCCEEDED
            attempt_status = (
                JobAttemptStatus.CANCELED if cancellation else JobAttemptStatus.SUCCEEDED
            )
            if not cancellation:
                for attachment in attachments:
                    connection.execute(
                        """
                        INSERT INTO job_attachments(
                            id, job_id, attempt_id, role, attachment_id, media_type,
                            metadata_json, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            attachment.id,
                            claimed.job.id,
                            claimed.attempt.id,
                            attachment.role,
                            attachment.attachment_id,
                            attachment.media_type,
                            _json(attachment.metadata),
                            _iso(now),
                        ),
                    )
            connection.execute(
                """
                UPDATE job_attempts SET status = ?, finished_at = ?, heartbeat_at = ?
                WHERE id = ?
                """,
                (attempt_status.value, _iso(now), _iso(now), claimed.attempt.id),
            )
            connection.execute(
                """
                UPDATE jobs SET status = ?, result_json = ?, error_code = NULL,
                    error_message = NULL, lease_owner = NULL, lease_expires_at = NULL,
                    heartbeat_at = ?, updated_at = ?, finished_at = ? WHERE id = ?
                """,
                (
                    final_status.value,
                    _json(result) if not cancellation else None,
                    _iso(now),
                    _iso(now),
                    _iso(now),
                    claimed.job.id,
                ),
            )
            if cancellation_requested and commit_point_reached:
                self._append_event(
                    connection,
                    claimed.job.id,
                    claimed.attempt.id,
                    "job.cancel_too_late",
                    {"reason": "durable side effects were already committed"},
                    level="warning",
                )
            self._append_event(
                connection,
                claimed.job.id,
                claimed.attempt.id,
                "job.canceled" if cancellation else "job.succeeded",
                (
                    {"attachments": 0}
                    if cancellation
                    else _public_success_payload(claimed.job.id, result, attachments)
                ),
            )
        return self.get(claimed.job.id)

    def reconcile_committed(
        self,
        job_id: str,
        result: dict[str, Any],
        attachments: list[JobAttachment] | None = None,
    ) -> Job:
        """Converge an interrupted job whose durable domain effects are already visible."""

        now = _now()
        with self._transaction(immediate=True) as connection:
            row = self._require_job(connection, job_id)
            status = JobStatus(row["status"])
            if status.terminal:
                return self._job(row)
            attempt = connection.execute(
                """
                SELECT * FROM job_attempts
                WHERE job_id = ? ORDER BY attempt_number DESC LIMIT 1
                """,
                (job_id,),
            ).fetchone()
            if attempt is None or attempt["status"] != JobAttemptStatus.RUNNING.value:
                raise JobConflictError("committed job has no interrupted running attempt")
            for attachment in attachments or []:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO job_attachments(
                        id, job_id, attempt_id, role, attachment_id, media_type,
                        metadata_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        attachment.id,
                        job_id,
                        attempt["id"],
                        attachment.role,
                        attachment.attachment_id,
                        attachment.media_type,
                        _json(attachment.metadata),
                        _iso(now),
                    ),
                )
            connection.execute(
                """
                UPDATE job_attempts SET status = 'succeeded', finished_at = ?,
                    heartbeat_at = ? WHERE id = ?
                """,
                (_iso(now), _iso(now), attempt["id"]),
            )
            connection.execute(
                """
                UPDATE jobs SET status = 'succeeded', result_json = ?, error_code = NULL,
                    error_message = NULL, lease_owner = NULL, lease_expires_at = NULL,
                    heartbeat_at = ?, updated_at = ?, finished_at = ? WHERE id = ?
                """,
                (_json(result), _iso(now), _iso(now), _iso(now), job_id),
            )
            self._append_event(
                connection,
                job_id,
                attempt["id"],
                "job.commit_reconciled",
                {"attachments": len(attachments or [])},
                level="warning",
            )
            self._append_event(
                connection,
                job_id,
                attempt["id"],
                "job.succeeded",
                _public_success_payload(job_id, result, attachments or []),
            )
        return self.get(job_id)

    def fail(
        self,
        claimed: ClaimedJob,
        *,
        code: str,
        message: str,
        retryable: bool,
        retry_delay_seconds: float = 0,
    ) -> Job:
        now = _now()
        with self._transaction(immediate=True) as connection:
            row = self._require_owned(connection, claimed)
            cancellation = row["status"] == JobStatus.CANCELLATION_REQUESTED.value
            can_retry = retryable and claimed.attempt.attempt_number < claimed.job.max_attempts
            if cancellation:
                final_status = JobStatus.CANCELED
                attempt_status = JobAttemptStatus.CANCELED
            elif can_retry:
                final_status = JobStatus.QUEUED
                attempt_status = JobAttemptStatus.FAILED
            else:
                final_status = JobStatus.FAILED
                attempt_status = JobAttemptStatus.FAILED
            finished_at = None if can_retry and not cancellation else _iso(now)
            connection.execute(
                """
                UPDATE job_attempts SET status = ?, error_message = ?, finished_at = ?,
                    heartbeat_at = ? WHERE id = ?
                """,
                (
                    attempt_status.value,
                    message[-4000:],
                    _iso(now),
                    _iso(now),
                    claimed.attempt.id,
                ),
            )
            connection.execute(
                """
                UPDATE jobs SET status = ?, error_code = ?, error_message = ?,
                    lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ?,
                    updated_at = ?, available_at = ?, finished_at = ? WHERE id = ?
                """,
                (
                    final_status.value,
                    code,
                    message[-4000:],
                    _iso(now),
                    _iso(now),
                    _iso(now + timedelta(seconds=retry_delay_seconds)),
                    finished_at,
                    claimed.job.id,
                ),
            )
            event_type = (
                "job.canceled"
                if cancellation
                else "job.retry_scheduled"
                if can_retry
                else "job.failed"
            )
            self._append_event(
                connection,
                claimed.job.id,
                claimed.attempt.id,
                event_type,
                {
                    "code": code,
                    "message": message[-1000:],
                    "retryable": bool(retryable and not cancellation),
                    "automatic_retry": can_retry,
                    "attempt": claimed.attempt.attempt_number,
                    "max_attempts": claimed.job.max_attempts,
                },
                level="warning" if can_retry else "error",
            )
        return self.get(claimed.job.id)

    def recover_interrupted(self) -> int:
        now = _now()
        recovered = 0
        with self._transaction(immediate=True) as connection:
            rows = connection.execute(
                "SELECT * FROM jobs WHERE status IN ('running', 'cancellation_requested')"
            ).fetchall()
            for row in rows:
                recovered += 1
                attempts = int(
                    connection.execute(
                        "SELECT COUNT(*) FROM job_attempts WHERE job_id = ?", (row["id"],)
                    ).fetchone()[0]
                )
                connection.execute(
                    """
                    UPDATE job_attempts SET status = 'interrupted', finished_at = ?,
                        error_message = 'worker process restarted'
                    WHERE job_id = ? AND status = 'running'
                    """,
                    (_iso(now), row["id"]),
                )
                canceled = row["status"] == JobStatus.CANCELLATION_REQUESTED.value
                retry = not canceled and attempts < int(row["max_attempts"])
                status = (
                    JobStatus.CANCELED
                    if canceled
                    else JobStatus.QUEUED
                    if retry
                    else JobStatus.FAILED
                )
                connection.execute(
                    """
                    UPDATE jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
                        heartbeat_at = NULL, updated_at = ?, available_at = ?, finished_at = ?,
                        error_code = ?, error_message = ? WHERE id = ?
                    """,
                    (
                        status.value,
                        _iso(now),
                        _iso(now),
                        None if retry else _iso(now),
                        None if retry or canceled else "worker_restarted",
                        None if retry or canceled else "worker process restarted",
                        row["id"],
                    ),
                )
                self._append_event(
                    connection,
                    row["id"],
                    None,
                    "job.recovered" if retry else "job.canceled" if canceled else "job.failed",
                    {"previous_status": row["status"]},
                    level="warning",
                )
        return recovered

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
    def _require_job(connection: sqlite3.Connection, job_id: str) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise JobNotFoundError(f"job not found: {job_id}")
        return row

    def _require_owned(self, connection: sqlite3.Connection, claimed: ClaimedJob) -> sqlite3.Row:
        row = self._require_job(connection, claimed.job.id)
        if row["lease_owner"] != claimed.attempt.worker_id or row["status"] not in {
            JobStatus.RUNNING.value,
            JobStatus.CANCELLATION_REQUESTED.value,
        }:
            raise JobConflictError("job lease is no longer owned by this attempt")
        return row

    def _append_event(
        self,
        connection: sqlite3.Connection,
        job_id: str,
        attempt_id: str | None,
        event_type: str,
        payload: dict[str, Any],
        *,
        level: str = "info",
    ) -> int:
        cursor = connection.execute(
            """
            INSERT INTO job_events(job_id, attempt_id, event_type, level, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (job_id, attempt_id, event_type, level, _json(payload), _iso(_now())),
        )
        return int(cursor.lastrowid)

    @staticmethod
    def _job(row: sqlite3.Row) -> Job:
        values = dict(row)
        values["input"] = json.loads(values.pop("input_json"))
        result = values.pop("result_json")
        values["result"] = json.loads(result) if result is not None else None
        return Job.model_validate(values)

    @staticmethod
    def _attempt(row: sqlite3.Row) -> JobAttempt:
        return JobAttempt.model_validate(dict(row))

    @staticmethod
    def _event(row: sqlite3.Row) -> JobEvent:
        values = dict(row)
        values["payload"] = json.loads(values.pop("payload_json"))
        return JobEvent.model_validate(values)

    @staticmethod
    def _attachment(row: sqlite3.Row) -> JobAttachment:
        values = dict(row)
        values["metadata"] = json.loads(values.pop("metadata_json"))
        return JobAttachment.model_validate(values)


def _public_success_payload(
    job_id: str,
    result: dict[str, Any],
    attachments: list[JobAttachment],
) -> dict[str, Any]:
    outputs = [attachment for attachment in attachments if attachment.role != "input"]
    products: list[dict[str, str]] = [
        {
            "type": "attachment",
            "id": attachment.attachment_id,
            "role": attachment.role,
            "href": f"/api/attachments/{attachment.attachment_id}/content",
        }
        for attachment in outputs
    ]
    ordered_attachment_ids = [attachment.attachment_id for attachment in outputs]
    recorded_ids = set(ordered_attachment_ids)
    result_attachment_ids = result.get("attachment_ids")
    if isinstance(result_attachment_ids, list):
        for attachment_id in result_attachment_ids:
            if isinstance(attachment_id, str) and attachment_id not in recorded_ids:
                products.append(
                    {
                        "type": "attachment",
                        "id": attachment_id,
                        "role": "output",
                        "href": f"/api/attachments/{attachment_id}/content",
                    }
                )
                recorded_ids.add(attachment_id)
                ordered_attachment_ids.append(attachment_id)
    document_id = result.get("document_id")
    if isinstance(document_id, str):
        products.append(
            {
                "type": "document",
                "id": document_id,
                "role": "structured_document",
                "href": f"/tasks?job={job_id}",
            }
        )
    return {
        "attachments": len(recorded_ids),
        "attachment_ids": ordered_attachment_ids,
        "document_id": document_id if isinstance(document_id, str) else None,
        "product_link": f"/tasks?job={job_id}",
        "products": products,
    }


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

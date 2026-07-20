from __future__ import annotations

import json
import sqlite3

from app.core.database import Database
from app.core.errors import ResourceConflictError, ResourceNotFoundError
from app.modules.resources.models import Resource
from app.modules.resources.repository import SqliteResourceRepository
from app.utils.time import utc_now

from .models import Job, JobOperation


class SqliteJobRepository:
    def __init__(self, database: Database):
        self.database = database
        self.resources = SqliteResourceRepository(database)

    def _from_row(self, row: sqlite3.Row) -> Job:
        outputs: list[Resource] = []
        with self.database.connection() as connection:
            resource_rows = connection.execute(
                "SELECT * FROM resources WHERE job_id = ? ORDER BY created_at", (row["id"],)
            ).fetchall()
        outputs = [self.resources._from_row(item) for item in resource_rows]
        return Job.model_validate(
            {**dict(row), "options": json.loads(row["options_json"]), "outputs": outputs}
        )

    def get(self, job_id: str) -> Job:
        with self.database.connection() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise ResourceNotFoundError("任务不存在")
        return self._from_row(row)

    def save(self, job: Job) -> Job:
        values = {
            **job.model_dump(mode="json", exclude={"outputs", "options"}),
            "options_json": json.dumps(job.options, ensure_ascii=False),
        }
        try:
            with self.database.connection() as connection:
                connection.execute(
                    """
                    INSERT INTO jobs(
                        id, paper_id, operation, input_resource_id, status, progress,
                        options_json, tool, tool_version, message, log_excerpt, error_summary,
                        created_at, started_at, finished_at
                    ) VALUES(
                        :id, :paper_id, :operation, :input_resource_id, :status, :progress,
                        :options_json, :tool, :tool_version, :message, :log_excerpt, :error_summary,
                        :created_at, :started_at, :finished_at
                    )
                    ON CONFLICT(id) DO UPDATE SET
                        status = excluded.status,
                        progress = excluded.progress,
                        tool = excluded.tool,
                        tool_version = excluded.tool_version,
                        message = excluded.message,
                        log_excerpt = excluded.log_excerpt,
                        error_summary = excluded.error_summary,
                        started_at = excluded.started_at,
                        finished_at = excluded.finished_at
                    """,
                    values,
                )
        except sqlite3.IntegrityError as error:
            raise ResourceConflictError("该论文已有同类活动任务") from error
        return self.get(job.id)

    def has_active(self, paper_id: str, operation: JobOperation) -> bool:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT 1 FROM jobs WHERE paper_id = ? AND operation = ?
                AND status IN ('queued', 'running') LIMIT 1
                """,
                (paper_id, operation.value),
            ).fetchone()
        return row is not None

    def has_active_jobs(self) -> bool:
        with self.database.connection() as connection:
            return (
                connection.execute(
                    "SELECT 1 FROM jobs WHERE status IN ('queued', 'running') LIMIT 1"
                ).fetchone()
                is not None
            )

    def fail_interrupted(self) -> None:
        with self.database.connection() as connection:
            connection.execute(
                """
                UPDATE jobs SET status = 'failed', progress = 100,
                    message = '服务重启导致任务中断',
                    error_summary = 'Backend process restarted', finished_at = ?
                WHERE status IN ('queued', 'running')
                """,
                (utc_now().isoformat(),),
            )

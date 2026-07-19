from __future__ import annotations

import sqlite3

from app.core.database import Database
from app.core.errors import ResourceConflictError, ResourceNotFoundError
from app.modules.translations.models import Job
from app.utils.time import utc_now


class SqliteJobRepository:
    def __init__(self, database: Database):
        self.database = database

    @staticmethod
    def _from_row(row: sqlite3.Row) -> Job:
        return Job.model_validate(dict(row))

    def get(self, job_id: str) -> Job:
        with self.database.connection() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise ResourceNotFoundError("任务不存在")
        return self._from_row(row)

    def save(self, job: Job) -> Job:
        values = job.model_dump(mode="json")
        try:
            with self.database.connection() as connection:
                connection.execute(
                    """
                    INSERT INTO jobs(
                        id, paper_id, job_type, status, progress, message, error_summary,
                        created_at, started_at, finished_at
                    ) VALUES(
                        :id, :paper_id, :job_type, :status, :progress, :message, :error_summary,
                        :created_at, :started_at, :finished_at
                    )
                    ON CONFLICT(id) DO UPDATE SET
                        status = excluded.status,
                        progress = excluded.progress,
                        message = excluded.message,
                        error_summary = excluded.error_summary,
                        started_at = excluded.started_at,
                        finished_at = excluded.finished_at
                    """,
                    values,
                )
        except sqlite3.IntegrityError as error:
            raise ResourceConflictError("该论文已有正在执行的翻译任务") from error
        return job

    def has_active_translation(self, paper_id: str) -> bool:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT 1 FROM jobs
                WHERE paper_id = ? AND job_type = 'translate'
                  AND status IN ('queued', 'running')
                LIMIT 1
                """,
                (paper_id,),
            ).fetchone()
        return row is not None

    def fail_interrupted(self) -> None:
        with self.database.connection() as connection:
            connection.execute(
                """
                UPDATE jobs SET
                    status = 'failed',
                    progress = 100,
                    message = '服务重启导致任务中断',
                    error_summary = 'Backend process restarted',
                    finished_at = ?
                WHERE status IN ('queued', 'running')
                """,
                (utc_now().isoformat(),),
            )

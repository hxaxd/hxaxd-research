from __future__ import annotations

from app.core.errors import ResourceConflictError
from app.modules.artifacts.models import ArtifactKind
from app.modules.artifacts.repository import SqliteArtifactRepository
from app.utils.identity import new_id
from app.utils.time import utc_now

from .executor import ThreadedTranslationExecutor
from .models import Job, JobStatus, TranslationRequest
from .repository import SqliteJobRepository


class TranslationService:
    def __init__(
        self,
        jobs: SqliteJobRepository,
        artifacts: SqliteArtifactRepository,
        executor: ThreadedTranslationExecutor,
    ):
        self.jobs = jobs
        self.artifacts = artifacts
        self.executor = executor

    def get_job(self, job_id: str) -> Job:
        return self.jobs.get(job_id)

    def translate(self, paper_id: str, payload: TranslationRequest) -> Job:
        self.artifacts.get(paper_id, ArtifactKind.ORIGINAL)
        if self.jobs.has_active_translation(paper_id):
            raise ResourceConflictError("该论文已有正在执行的翻译任务")
        job = self.jobs.save(
            Job(
                id=new_id(),
                paper_id=paper_id,
                job_type="translate",
                status=JobStatus.QUEUED,
                progress=0,
                message="等待执行",
                error_summary=None,
                created_at=utc_now(),
                started_at=None,
                finished_at=None,
            )
        )
        self.executor.submit(job.id, paper_id, payload.qps, payload.workers)
        return job

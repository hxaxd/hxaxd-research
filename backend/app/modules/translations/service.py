from __future__ import annotations

from app.core.errors import ResourceConflictError
from app.modules.resources.models import ResourceFormat, ResourceRepresentation
from app.modules.resources.repository import SqliteResourceRepository
from app.utils.identity import new_id
from app.utils.time import utc_now

from .executor import ThreadedJobExecutor
from .models import Job, JobOperation, JobRequest, JobStatus, TranslationRequest
from .repository import SqliteJobRepository


class JobService:
    def __init__(
        self,
        jobs: SqliteJobRepository,
        resources: SqliteResourceRepository,
        executor: ThreadedJobExecutor,
    ):
        self.jobs = jobs
        self.resources = resources
        self.executor = executor

    def get_job(self, job_id: str) -> Job:
        return self.jobs.get(job_id)

    def create(self, payload: JobRequest) -> Job:
        resource = self.resources.get(payload.input_resource_id)
        expected = (
            ResourceFormat.TEX if payload.operation == JobOperation.COMPILE else ResourceFormat.PDF
        )
        if resource.format != expected:
            raise ResourceConflictError(
                f"{payload.operation.value} requires {expected.value} input"
            )
        if payload.operation == JobOperation.TRANSLATE and (
            resource.representation != ResourceRepresentation.ORIGINAL
        ):
            raise ResourceConflictError("translate requires an original PDF")
        if self.jobs.has_active(resource.paper_id, payload.operation):
            raise ResourceConflictError("该论文已有同类活动任务")
        job = self.jobs.save(
            Job(
                id=new_id(),
                paper_id=resource.paper_id,
                operation=payload.operation,
                input_resource_id=resource.id,
                status=JobStatus.QUEUED,
                progress=0,
                options=payload.options,
                tool="latexmk" if payload.operation == JobOperation.COMPILE else "pdf2zh",
                tool_version=None,
                message="等待执行",
                log_excerpt=None,
                error_summary=None,
                created_at=utc_now(),
                started_at=None,
                finished_at=None,
            )
        )
        self.executor.submit(job.id)
        return job

    def translate_legacy(self, paper_id: str, payload: TranslationRequest) -> Job:
        resource = self.resources.preferred(
            paper_id, ResourceFormat.PDF, ResourceRepresentation.ORIGINAL
        )
        return self.create(
            JobRequest(
                operation=JobOperation.TRANSLATE,
                input_resource_id=resource.id,
                options={"qps": payload.qps, "workers": payload.workers},
            )
        )

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from app.modules.artifacts.models import ArtifactKind
from app.modules.artifacts.repository import SqliteArtifactRepository
from app.modules.artifacts.service import ArtifactService
from app.modules.artifacts.storage import LocalPdfStorage
from app.modules.translations.models import JobStatus
from app.utils.time import utc_now

from .backend import Pdf2zhBackend
from .repository import SqliteJobRepository


class ThreadedTranslationExecutor:
    def __init__(
        self,
        jobs: SqliteJobRepository,
        artifacts: SqliteArtifactRepository,
        storage: LocalPdfStorage,
        registrar: ArtifactService,
        backend: Pdf2zhBackend,
    ):
        self.jobs = jobs
        self.artifacts = artifacts
        self.storage = storage
        self.registrar = registrar
        self.backend = backend
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="translation")

    def submit(
        self,
        job_id: str,
        paper_id: str,
        qps: int,
        workers: int,
    ) -> None:
        self.pool.submit(self._run, job_id, paper_id, qps, workers)

    def shutdown(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=False)

    def _run(self, job_id: str, paper_id: str, qps: int, workers: int) -> None:
        job = self.jobs.get(job_id)
        running_job = job.model_copy(
            update={
                "status": JobStatus.RUNNING,
                "progress": 10,
                "message": "正在翻译",
                "started_at": utc_now(),
            }
        )
        self.jobs.save(running_job)
        try:
            original = self.artifacts.get(paper_id, ArtifactKind.ORIGINAL)
            original_path = self.storage.resolve(original.relative_path)
            output_directory = self.storage.directory_for(paper_id)
            generated = self.backend.translate(
                original_path,
                output_directory,
                qps,
                workers,
            )
            for kind, path in generated.items():
                self.registrar.register_generated(paper_id, kind, path)
            self.jobs.save(
                running_job.model_copy(
                    update={
                        "status": JobStatus.SUCCEEDED,
                        "progress": 100,
                        "message": "翻译完成",
                        "error_summary": None,
                        "finished_at": utc_now(),
                    }
                )
            )
        except Exception as error:
            self.jobs.save(
                running_job.model_copy(
                    update={
                        "status": JobStatus.FAILED,
                        "progress": 100,
                        "message": "翻译失败",
                        "error_summary": str(error)[-2000:],
                        "finished_at": utc_now(),
                    }
                )
            )

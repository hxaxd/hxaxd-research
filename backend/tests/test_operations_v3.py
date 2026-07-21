from __future__ import annotations

import socket
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.jobs.models import (
    ClaimedJob,
    Job,
    JobAttempt,
    JobAttemptStatus,
    JobCreate,
    JobFailure,
    JobStatus,
)
from app.jobs.scheduler import JobExecutionContext
from app.library.models import (
    Attachment,
    AttachmentFormat,
    AttachmentOrigin,
    AttachmentType,
    LanguageMode,
)
from app.operations.api import router as operations_router
from app.operations.handlers import (
    OperationHandlers,
    _activate_tool_directory,
    _download_https,
    _extract_zip_safely,
    _validate_public_https_url,
)
from app.operations.models import (
    AttachmentDownloadRequest,
    CompileJobRequest,
    ManagedToolName,
    ManagedToolStatus,
    TranslationJobRequest,
)
from app.operations.service import OperationService
from app.platform.processes import (
    CancellationToken,
    ExecutableRegistry,
    ProcessOutcome,
    ProcessResult,
    ProcessSpec,
)

NOW = datetime(2026, 7, 21, tzinfo=UTC)


class FakeScheduler:
    def __init__(self) -> None:
        self.requests: list[JobCreate] = []

    def create(self, request: JobCreate) -> Job:
        self.requests.append(request)
        return _job(request.kind, request.input, subject_id=request.subject_id)


class FakeJobRepository:
    def __init__(self) -> None:
        self.active: list[Job] = []
        self.history: list[Job] = []

    def active_for_subject(self, subject_type: str, subject_id: str) -> list[Job]:
        return [
            job
            for job in self.active
            if job.subject_type == subject_type and job.subject_id == subject_id
        ]

    def list_jobs(
        self,
        *,
        status: JobStatus | None = None,
        kind: str | None = None,
        limit: int = 200,
    ) -> list[Job]:
        return [
            job
            for job in self.history
            if (status is None or job.status is status) and (kind is None or job.kind == kind)
        ][:limit]


class FakeAttachmentService:
    def __init__(self, source: Attachment, source_path: Path) -> None:
        self.source = source
        self.source_path = source_path
        self.batch_calls: list[dict[str, Any]] = []
        self.fail_registration = False

    def locate(self, attachment_id: str) -> tuple[Attachment, Path]:
        if attachment_id != self.source.id:
            raise LookupError(attachment_id)
        return self.source, self.source_path

    def outputs_for_job(self, _job_id: str, _roles: list[str]) -> dict[str, Attachment]:
        return {}

    def register_generated_batch(
        self,
        item_id: str,
        outputs,
        *,
        parent_attachment_id: str | None,
        job_id: str | None,
        operation_roles: list[str] | None = None,
    ) -> list[Attachment]:
        call = {
            "item_id": item_id,
            "outputs": list(outputs),
            "parent_attachment_id": parent_attachment_id,
            "job_id": job_id,
            "operation_roles": operation_roles,
        }
        self.batch_calls.append(call)
        if self.fail_registration:
            raise RuntimeError("atomic registration rejected")
        generated: list[Attachment] = []
        for position, (path, metadata) in enumerate(call["outputs"]):
            generated.append(
                Attachment(
                    id=f"generated-{position}",
                    item_id=item_id,
                    blob_id=f"blob-{position}",
                    attachment_type=metadata.attachment_type,
                    format=metadata.format or AttachmentFormat.PDF,
                    language_mode=metadata.language_mode,
                    origin=metadata.origin,
                    filename=metadata.filename,
                    source_url=metadata.source_url,
                    media_type="application/pdf",
                    sha256="a" * 64,
                    size=path.stat().st_size,
                    storage_key=f"artifacts/{item_id}/generated-{position}/{metadata.filename}",
                    preferred_for=metadata.preferred_for,
                    created_at=NOW,
                )
            )
        return generated


class FakeRunner:
    def __init__(self, outcome: ProcessOutcome = ProcessOutcome.COMPLETED) -> None:
        self.registry = ExecutableRegistry()
        self.outcome = outcome
        self.specs: list[ProcessSpec] = []

    def run(self, spec: ProcessSpec, **_: object) -> ProcessResult:
        self.specs.append(spec)
        if self.outcome is ProcessOutcome.COMPLETED:
            if spec.executable == "pdf2zh":
                output = Path(spec.argv[spec.argv.index("--output") + 1])
                (output / "paper.mono.pdf").write_bytes(b"translated-pdf")
                (output / "paper.dual.pdf").write_bytes(b"bilingual-pdf")
            elif spec.executable == "latexmk":
                argument = next(item for item in spec.argv if item.startswith("-outdir="))
                output = Path(argument.removeprefix("-outdir="))
                (output / "main.pdf").write_bytes(b"compiled-pdf")
        return ProcessResult(
            outcome=self.outcome,
            executable=spec.executable,
            argv=spec.argv,
            pid=123,
            returncode=0 if self.outcome is ProcessOutcome.COMPLETED else None,
            started_at=NOW,
            finished_at=NOW,
            duration_seconds=0,
            stdout_tail="",
            stderr_tail="",
        )


def test_pdf_tool_reports_and_schedules_the_ocr_bundle_upgrade(tmp_path) -> None:
    settings = _settings(tmp_path)
    settings.pdf2zh_executable.parent.mkdir(parents=True)
    settings.pdf2zh_executable.write_bytes(b"fake executable")
    source_path = tmp_path / "source.pdf"
    source_path.write_bytes(b"pdf")
    scheduler = FakeScheduler()
    service = OperationService(
        settings,
        FakeAttachmentService(
            _attachment("source", AttachmentType.FULLTEXT, AttachmentFormat.PDF),
            source_path,
        ),  # type: ignore[arg-type]
        scheduler,  # type: ignore[arg-type]
        FakeJobRepository(),  # type: ignore[arg-type]
        FakeRunner(),  # type: ignore[arg-type]
    )

    partial = service.get_tool(ManagedToolName.PDF2ZH)
    assert partial.status is ManagedToolStatus.UPGRADE_REQUIRED
    service.install_tool(ManagedToolName.PDF2ZH)
    assert scheduler.requests[-1].kind == "tool.install.pdf2zh"

    rapidocr = (
        settings.pdf2zh_dir / ".venv" / "Lib" / "site-packages" / "rapidocr"
    )
    rapidocr.mkdir(parents=True)
    ready = service.get_tool(ManagedToolName.PDF2ZH)
    assert ready.status is ManagedToolStatus.READY
    service.install_tool(ManagedToolName.PDF2ZH)
    assert scheduler.requests[-1].kind == "tool.verify.pdf2zh"


def test_scheduling_validates_attachment_kind_and_hides_url_from_concurrency_key(tmp_path):
    settings = _settings(tmp_path)
    source_path = tmp_path / "source.pdf"
    source_path.write_bytes(b"pdf")
    source = _attachment("source", AttachmentType.FULLTEXT, AttachmentFormat.PDF)
    attachments = FakeAttachmentService(source, source_path)
    scheduler = FakeScheduler()
    service = OperationService(
        settings,
        attachments,  # type: ignore[arg-type]
        scheduler,  # type: ignore[arg-type]
        FakeJobRepository(),  # type: ignore[arg-type]
        FakeRunner(),  # type: ignore[arg-type]
    )

    job = service.download_attachment(
        "item-1",
        AttachmentDownloadRequest(url="https://papers.example.test/file.pdf?token=secret"),
    )

    request = scheduler.requests[-1]
    assert job.kind == "attachment.download"
    assert "secret" not in (request.concurrency_key or "")
    assert len(request.concurrency_key or "") < 120
    with pytest.raises(ValueError, match="TeX"):
        service.compile_attachment(source.id, CompileJobRequest())

    attachments.source = _attachment(
        source.id,
        AttachmentType.SOURCE_ARCHIVE,
        AttachmentFormat.TEX,
    )
    service.compile_attachment(source.id, CompileJobRequest(main_tex="paper/main.tex"))
    compile_request = scheduler.requests[-1]
    assert compile_request.max_attempts == 2
    assert compile_request.input["main_tex"] == "paper/main.tex"

    attachments.source = source.model_copy(update={"language_mode": LanguageMode.TRANSLATED})
    with pytest.raises(ValueError, match="原文 PDF"):
        service.translate_attachment(source.id, TranslationJobRequest())


def test_download_rejects_private_dns_and_cancellation_without_network(tmp_path, monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))
        ],
    )
    with pytest.raises(JobFailure) as private:
        _validate_public_https_url("https://example.test/paper.pdf")
    assert private.value.code == "unsafe_url"

    target = tmp_path / "download"
    with pytest.raises(JobFailure) as canceled:
        _download_https(
            "https://example.test/paper.pdf",
            target,
            cancellation=lambda: True,
        )
    assert canceled.value.code == "canceled"
    assert canceled.value.retryable
    assert not target.exists()


def test_public_download_route_keeps_path_and_rejects_non_https_before_scheduling(tmp_path):
    settings = _settings(tmp_path)
    source_path = tmp_path / "source.pdf"
    source_path.write_bytes(b"pdf")
    attachments = FakeAttachmentService(
        _attachment("source", AttachmentType.FULLTEXT, AttachmentFormat.PDF),
        source_path,
    )
    scheduler = FakeScheduler()
    service = OperationService(
        settings,
        attachments,  # type: ignore[arg-type]
        scheduler,  # type: ignore[arg-type]
        FakeJobRepository(),  # type: ignore[arg-type]
        FakeRunner(),  # type: ignore[arg-type]
    )
    app = FastAPI()
    app.state.context = SimpleNamespace(operations=service)
    app.include_router(operations_router, prefix="/api")

    with TestClient(app) as client:
        rejected = client.post(
            "/api/items/item-1/attachments/download",
            json={"url": "http://example.test/paper.pdf"},
        )
        accepted = client.post(
            "/api/items/item-1/attachments/download",
            json={"url": "https://example.test/paper.pdf"},
        )

    assert rejected.status_code == 422
    assert accepted.status_code == 202
    assert len(scheduler.requests) == 1


@pytest.mark.parametrize("member", ["../escape.tex", "C:/escape.tex", "dir/file.tex:ads"])
def test_archive_extraction_rejects_unsafe_paths(tmp_path, member):
    archive = tmp_path / "source.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr(member, "unsafe")
    target = tmp_path / "extract"
    target.mkdir()

    with pytest.raises(JobFailure) as failure:
        _extract_zip_safely(archive, target, cancellation=lambda: False)

    assert failure.value.code == "unsafe_archive"
    assert list(target.rglob("*")) == []


def test_translation_registers_both_outputs_in_one_batch_and_records_job_attachments(
    tmp_path, monkeypatch
):
    settings = _settings(tmp_path)
    executable = settings.pdf2zh_executable
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"fake executable")
    source_path = tmp_path / "paper.pdf"
    source_path.write_bytes(b"source pdf")
    source = _attachment("source", AttachmentType.FULLTEXT, AttachmentFormat.PDF)
    attachments = FakeAttachmentService(source, source_path)
    runner = FakeRunner()
    handler = OperationHandlers(
        settings,
        attachments,  # type: ignore[arg-type]
        runner,  # type: ignore[arg-type]
    )
    context = _context(
        "attachment.translate",
        {
            "attachment_id": source.id,
            "item_id": source.item_id,
            "qps": 3,
            "workers": 2,
        },
    )
    monkeypatch.setenv("PDF2ZH_DEEPSEEK_API_KEY", "secret-key")

    result = handler.translate(context)

    assert len(attachments.batch_calls) == 1
    assert len(attachments.batch_calls[0]["outputs"]) == 2
    assert [item.role for item in result.attachments] == [
        "input",
        "translated",
        "bilingual",
    ]
    assert all(item.job_id == context.claimed.job.id for item in result.attachments)
    assert all(item.attempt_id == context.claimed.attempt.id for item in result.attachments)
    assert runner.specs[0].environment["PDF2ZH_DEEPSEEK_API_KEY"] == "secret-key"
    assert runner.specs[0].sensitive_values == ("secret-key",)


def test_translation_registration_failure_does_not_split_the_output_batch(
    tmp_path, monkeypatch
):
    settings = _settings(tmp_path)
    settings.pdf2zh_executable.parent.mkdir(parents=True)
    settings.pdf2zh_executable.write_bytes(b"fake executable")
    source_path = tmp_path / "paper.pdf"
    source_path.write_bytes(b"source pdf")
    source = _attachment("source", AttachmentType.FULLTEXT, AttachmentFormat.PDF)
    attachments = FakeAttachmentService(source, source_path)
    attachments.fail_registration = True
    handler = OperationHandlers(
        settings,
        attachments,  # type: ignore[arg-type]
        FakeRunner(),  # type: ignore[arg-type]
    )
    monkeypatch.setenv("PDF2ZH_DEEPSEEK_API_KEY", "secret-key")

    with pytest.raises(RuntimeError, match="atomic"):
        handler.translate(
            _context(
                "attachment.translate",
                {"attachment_id": source.id, "item_id": source.item_id},
            )
        )

    assert len(attachments.batch_calls) == 1
    assert len(attachments.batch_calls[0]["outputs"]) == 2


def test_canceled_translation_is_retryable_and_never_registers_outputs(tmp_path, monkeypatch):
    settings = _settings(tmp_path)
    settings.pdf2zh_executable.parent.mkdir(parents=True)
    settings.pdf2zh_executable.write_bytes(b"fake executable")
    source_path = tmp_path / "paper.pdf"
    source_path.write_bytes(b"source pdf")
    source = _attachment("source", AttachmentType.FULLTEXT, AttachmentFormat.PDF)
    attachments = FakeAttachmentService(source, source_path)
    handler = OperationHandlers(
        settings,
        attachments,  # type: ignore[arg-type]
        FakeRunner(ProcessOutcome.CANCELED),  # type: ignore[arg-type]
    )
    monkeypatch.setenv("PDF2ZH_DEEPSEEK_API_KEY", "secret-key")

    with pytest.raises(JobFailure) as failure:
        handler.translate(
            _context(
                "attachment.translate",
                {"attachment_id": source.id, "item_id": source.item_id},
            )
        )

    assert failure.value.code == "canceled"
    assert failure.value.retryable
    assert attachments.batch_calls == []


def test_compile_uses_process_runner_with_shell_escape_disabled(tmp_path):
    settings = _settings(tmp_path)
    latexmk = settings.tex_dir / "texlive" / "bin" / "windows" / "latexmk.exe"
    latexmk.parent.mkdir(parents=True)
    latexmk.write_bytes(b"fake executable")
    archive = tmp_path / "source.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
        output.writestr(
            "main.tex",
            "\\documentclass{article}\n\\begin{document}test\\end{document}\n",
        )
    source = _attachment("source", AttachmentType.SOURCE_ARCHIVE, AttachmentFormat.TEX)
    attachments = FakeAttachmentService(source, archive)
    runner = FakeRunner()
    handler = OperationHandlers(
        settings,
        attachments,  # type: ignore[arg-type]
        runner,  # type: ignore[arg-type]
    )

    result = handler.compile(
        _context(
            "attachment.compile",
            {"attachment_id": source.id, "item_id": source.item_id, "main_tex": "main.tex"},
        )
    )

    assert len(runner.specs) == 1
    assert "-no-shell-escape" in runner.specs[0].argv
    assert [item.role for item in result.attachments] == ["input", "output"]
    assert len(attachments.batch_calls) == 1


def test_tool_directory_activation_preserves_previous_installation(tmp_path):
    target = tmp_path / "tools" / "pdf2zh"
    target.mkdir(parents=True)
    (target / "version.txt").write_text("old", encoding="utf-8")
    candidate = tmp_path / "staging" / "pdf2zh"
    candidate.mkdir(parents=True)
    (candidate / "version.txt").write_text("new", encoding="utf-8")

    previous = _activate_tool_directory(candidate, target)

    assert (target / "version.txt").read_text(encoding="utf-8") == "new"
    assert previous is not None
    assert (previous / "version.txt").read_text(encoding="utf-8") == "old"


def _settings(tmp_path: Path) -> Settings:
    data_dir = (tmp_path / "data").resolve()
    return Settings(
        data_dir=data_dir,
        database_path=data_dir / "research.sqlite3",
        artifact_dir=data_dir / "artifacts",
        tools_dir=(tmp_path / "tools").resolve(),
        snapshot_dir=tmp_path / "snapshots",
        frontend_origins=("http://testserver",),
    )


def _attachment(
    attachment_id: str,
    attachment_type: AttachmentType,
    format_: AttachmentFormat,
) -> Attachment:
    return Attachment(
        id=attachment_id,
        item_id="item-1",
        blob_id=f"blob-{attachment_id}",
        attachment_type=attachment_type,
        format=format_,
        language_mode=LanguageMode.ORIGINAL,
        origin=AttachmentOrigin.USER,
        filename="source.pdf" if format_ is AttachmentFormat.PDF else "source.zip",
        source_url=None,
        media_type=("application/pdf" if format_ is AttachmentFormat.PDF else "application/zip"),
        sha256="b" * 64,
        size=100,
        storage_key=f"artifacts/item-1/{attachment_id}/source",
        preferred_for=[],
        created_at=NOW,
    )


def _job(kind: str, input_: dict[str, Any], *, subject_id: str | None = None) -> Job:
    return Job(
        id="job-1",
        kind=kind,
        subject_type="attachment",
        subject_id=subject_id,
        status=JobStatus.QUEUED,
        priority=0,
        input=input_,
        result=None,
        error_code=None,
        error_message=None,
        idempotency_key=None,
        concurrency_key=None,
        max_attempts=1,
        lease_owner=None,
        lease_expires_at=None,
        heartbeat_at=None,
        created_at=NOW,
        updated_at=NOW,
        available_at=NOW,
        started_at=None,
        finished_at=None,
        cancel_requested_at=None,
    )


def _context(kind: str, input_: dict[str, Any]) -> JobExecutionContext:
    job = _job(kind, input_).model_copy(
        update={
            "id": "job-operation",
            "status": JobStatus.RUNNING,
            "lease_owner": "test-worker",
            "started_at": NOW,
        }
    )
    attempt = JobAttempt(
        id="attempt-1",
        job_id=job.id,
        attempt_number=1,
        worker_id="test-worker",
        status=JobAttemptStatus.RUNNING,
        process_id=None,
        executable=None,
        exit_code=None,
        error_message=None,
        started_at=NOW,
        heartbeat_at=NOW,
        finished_at=None,
    )
    return JobExecutionContext(
        claimed=ClaimedJob(job=job, attempt=attempt),
        cancellation=CancellationToken(),
        emit=lambda *_args: None,
        record_process=lambda *_args: None,
    )

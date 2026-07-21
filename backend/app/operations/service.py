from __future__ import annotations

import hashlib
import re
from pathlib import Path
from uuid import uuid4

from app.core.config import Settings
from app.documents.capabilities import PdfPipelineCapabilityProbe
from app.jobs.models import Job, JobAttachment, JobCreate, JobStatus
from app.jobs.repository import SqliteJobRepository
from app.jobs.scheduler import JobScheduler
from app.library.models import AttachmentFormat, AttachmentType, LanguageMode
from app.library.service import AttachmentService
from app.platform.processes import ExecutableIdentity, ProcessRunner, ProcessSpec

from .models import (
    AttachmentDownloadJobInput,
    AttachmentDownloadRequest,
    CompileJobInput,
    CompileJobRequest,
    ManagedTool,
    ManagedToolName,
    ManagedToolStatus,
    TranslationJobInput,
    TranslationJobRequest,
)


class OperationService:
    def __init__(
        self,
        settings: Settings,
        attachments: AttachmentService,
        jobs: JobScheduler,
        job_repository: SqliteJobRepository,
        runner: ProcessRunner,
        capability_probe: PdfPipelineCapabilityProbe | None = None,
    ) -> None:
        self.settings = settings
        self.attachments = attachments
        self.jobs = jobs
        self.job_repository = job_repository
        self.runner = runner
        self.capability_probe = capability_probe or PdfPipelineCapabilityProbe(
            settings, runner
        )

    def list_tools(self) -> list[ManagedTool]:
        return [self.get_tool(name) for name in ManagedToolName]

    def reconcile_committed(self) -> int:
        """Finish jobs that crashed after their typed domain effect committed."""

        reconciled = 0
        active = [
            *self.job_repository.list_jobs(status=JobStatus.RUNNING, limit=1000),
            *self.job_repository.list_jobs(
                status=JobStatus.CANCELLATION_REQUESTED, limit=1000
            ),
        ]
        output_roles = {
            "attachment.download": ["output"],
            "attachment.compile": ["output"],
            "attachment.translate": ["translated", "bilingual"],
        }
        for job in active:
            roles = output_roles.get(job.kind)
            if roles is not None:
                outputs = self.attachments.outputs_for_job(job.id, roles)
                if len(outputs) != len(roles):
                    continue
                records: list[JobAttachment] = []
                input_id = job.input.get("attachment_id")
                if isinstance(input_id, str):
                    source, _ = self.attachments.locate(input_id)
                    records.append(self._job_attachment(job.id, "input", source))
                records.extend(
                    self._job_attachment(job.id, role, outputs[role]) for role in roles
                )
                result: dict[str, object] = {
                    "attachment_ids": [outputs[role].id for role in roles]
                }
                if isinstance(input_id, str):
                    result["input_attachment_id"] = input_id
                self.job_repository.reconcile_committed(job.id, result, records)
                reconciled += 1
                continue
            if (
                job.kind == "tool.install.pdf2zh"
                and self.capability_probe.get().compatible
            ):
                probe = self.capability_probe.get()
                self.job_repository.reconcile_committed(
                    job.id, {"tool": "pdf2zh", "version": probe.pdf2zh_version}
                )
                reconciled += 1
            elif job.kind == "tool.install.tex" and self._executable(ManagedToolName.TEX):
                self.job_repository.reconcile_committed(
                    job.id, {"tool": "tex", "ready": True}
                )
                reconciled += 1
        return reconciled

    def get_tool(self, name: ManagedToolName) -> ManagedTool:
        executable = self._executable(name)
        pdf_probe = (
            self.capability_probe.get()
            if name is ManagedToolName.PDF2ZH and executable is not None
            else None
        )
        installing = self._has_active_job(f"tool.install.{name.value}")
        last_failure = self._last_failure(f"tool.install.{name.value}")
        upgrade_required = (
            name is ManagedToolName.PDF2ZH
            and executable is not None
            and (pdf_probe is None or not pdf_probe.compatible)
        )
        status = (
            ManagedToolStatus.INSTALLING
            if installing
            else ManagedToolStatus.UPGRADE_REQUIRED
            if upgrade_required
            else ManagedToolStatus.READY
            if executable is not None
            else ManagedToolStatus.FAILED
            if last_failure
            else ManagedToolStatus.MISSING
        )
        metadata = self._metadata(name)
        return ManagedTool(
            name=name,
            label=metadata["label"],
            description=metadata["description"],
            status=status,
            version=(
                pdf_probe.pdf2zh_version
                if pdf_probe is not None
                else self._version(name, executable)
                if executable
                else None
            ),
            executable_path=str(executable) if executable else None,
            install_path=str(
                self.settings.pdf2zh_dir
                if name is ManagedToolName.PDF2ZH
                else self.settings.tex_dir
            ),
            message=(
                "正在安装"
                if installing
                else pdf_probe.message
                if upgrade_required
                else "可以使用"
                if executable
                else "上次安装或校验失败；请查看任务事件"
                if last_failure
                else "尚未安装"
            ),
        )

    def install_tool(self, name: ManagedToolName) -> Job:
        if self.get_tool(name).status is ManagedToolStatus.READY:
            return self.jobs.create(
                JobCreate(
                    kind=f"tool.verify.{name.value}",
                    subject_type="tool",
                    subject_id=name.value,
                    idempotency_key=f"tool-ready:{name.value}",
                    input={"name": name.value},
                )
            )
        return self.jobs.create(
            JobCreate(
                kind=f"tool.install.{name.value}",
                subject_type="tool",
                subject_id=name.value,
                concurrency_key=f"tool:{name.value}",
                input={"name": name.value},
                max_attempts=2,
            )
        )

    def download_attachment(
        self,
        item_id: str,
        request: AttachmentDownloadRequest,
        *,
        idempotency_key: str | None = None,
    ) -> Job:
        payload = AttachmentDownloadJobInput(
            item_id=item_id,
            **request.model_dump(mode="json"),
        )
        url_digest = hashlib.sha256(str(request.url).encode("utf-8")).hexdigest()
        return self.jobs.create(
            JobCreate(
                kind="attachment.download",
                subject_type="item",
                subject_id=item_id,
                idempotency_key=idempotency_key,
                concurrency_key=f"attachment-download:{item_id}:{url_digest}",
                input=payload.model_dump(mode="json"),
                max_attempts=3,
            )
        )

    def compile_attachment(
        self, attachment_id: str, request: CompileJobRequest
    ) -> Job:
        attachment, _ = self.attachments.locate(attachment_id)
        if (
            attachment.attachment_type is not AttachmentType.SOURCE_ARCHIVE
            or attachment.format is not AttachmentFormat.TEX
        ):
            raise ValueError("只有 TeX 源码附件可以编译")
        payload = CompileJobInput(
            attachment_id=attachment_id,
            item_id=attachment.item_id,
            **request.model_dump(mode="json"),
        )
        return self.jobs.create(
            JobCreate(
                kind="attachment.compile",
                subject_type="attachment",
                subject_id=attachment_id,
                concurrency_key=f"attachment-compile:{attachment_id}",
                input=payload.model_dump(mode="json"),
                max_attempts=2,
            )
        )

    def translate_attachment(
        self, attachment_id: str, request: TranslationJobRequest
    ) -> Job:
        attachment, _ = self.attachments.locate(attachment_id)
        if (
            attachment.attachment_type is not AttachmentType.FULLTEXT
            or attachment.format is not AttachmentFormat.PDF
            or attachment.language_mode is not LanguageMode.ORIGINAL
        ):
            raise ValueError("只有原文 PDF 全文附件可以翻译")
        payload = TranslationJobInput(
            attachment_id=attachment_id,
            item_id=attachment.item_id,
            **request.model_dump(mode="json"),
        )
        return self.jobs.create(
            JobCreate(
                kind="attachment.translate",
                subject_type="attachment",
                subject_id=attachment_id,
                concurrency_key=f"attachment-translate:{attachment_id}",
                input=payload.model_dump(mode="json"),
                max_attempts=2,
            )
        )

    def _has_active_job(self, kind: str) -> bool:
        tool_name = kind.rsplit(".", maxsplit=1)[-1]
        return any(
            job.kind == kind
            for job in self.job_repository.active_for_subject("tool", tool_name)
        )

    def _last_failure(self, kind: str) -> str | None:
        jobs = self.job_repository.list_jobs(
            status=JobStatus.FAILED,
            kind=kind,
            limit=1,
        )
        return jobs[0].error_message[-500:] if jobs and jobs[0].error_message else None

    def _version(self, name: ManagedToolName, executable: Path) -> str | None:
        identity = f"managed-{name.value}"
        self.runner.registry.register(
            ExecutableIdentity(identity, executable, executable.parent)
        )
        try:
            result = self.runner.run(
                ProcessSpec(
                    executable=identity,
                    argv=("--version",)
                    if name is ManagedToolName.PDF2ZH
                    else ("-version",),
                    cwd=self.settings.tools_dir,
                    allowed_cwd_root=self.settings.tools_dir,
                    timeout_seconds=15,
                    inherit_environment=("PATH", "SYSTEMROOT", "WINDIR"),
                )
            )
        except (OSError, ValueError):
            return None
        if not result.succeeded:
            return None
        output = (result.stdout_tail or result.stderr_tail).strip()
        if name is ManagedToolName.PDF2ZH:
            match = re.search(r"pdf2zh-next version:\s*([^\s]+)", output)
        else:
            match = re.search(r"Version\s+([^\s,]+)", output, re.IGNORECASE)
        return match.group(1) if match else (output.splitlines()[0][:80] if output else None)

    def _executable(self, name: ManagedToolName) -> Path | None:
        if name is ManagedToolName.PDF2ZH:
            path = self.settings.pdf2zh_executable
            return path if path.is_file() else None
        windows = self.settings.tex_dir / "texlive" / "bin" / "windows" / "latexmk.exe"
        if windows.is_file():
            return windows
        root = self.settings.tex_dir / "texlive" / "bin"
        if root.is_dir():
            for path in sorted(root.glob("*/latexmk")):
                if path.is_file():
                    return path
        return None

    @staticmethod
    def _metadata(name: ManagedToolName) -> dict[str, str]:
        if name is ManagedToolName.PDF2ZH:
            return {
                "label": "PDF 论文处理",
                "description": "保留版式、生成双语 PDF，并为扫描件提供离线文字识别",
            }
        return {
            "label": "TeX 编译环境",
            "description": "从安全的 TeX 源码包生成 PDF",
        }

    @staticmethod
    def _job_attachment(job_id: str, role: str, attachment) -> JobAttachment:
        return JobAttachment(
            id=uuid4().hex,
            job_id=job_id,
            attempt_id=None,
            role=role,
            attachment_id=attachment.id,
            media_type=attachment.media_type,
            metadata={"language_mode": attachment.language_mode.value},
        )

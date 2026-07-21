from __future__ import annotations

import hashlib
import json

from pydantic import ValidationError

from app.jobs.models import Job, JobCreate, JobExecutionResult, JobFailure, JobStatus
from app.jobs.repository import SqliteJobRepository
from app.jobs.scheduler import JobExecutionContext, JobRegistry, JobScheduler
from app.library.models import AttachmentFormat, AttachmentType
from app.library.service import AttachmentService

from .extractor import (
    BabelDocExtractor,
    DocumentExtractionError,
    ExtractionCallbacks,
)
from .models import (
    Document,
    DocumentBlocksPage,
    DocumentExtractionJobInput,
    DocumentExtractionRequest,
    DocumentStatus,
    DocumentTranslationJobInput,
    DocumentTranslationRequest,
    TranslationInputBlock,
)
from .prompts import TRANSLATION_PROMPT_VERSION
from .repository import DocumentConflictError, DocumentRepository
from .translation import DocumentTranslationError, TranslationProvider


class DocumentService:
    def __init__(
        self,
        repository: DocumentRepository,
        attachments: AttachmentService,
        jobs: JobScheduler,
        job_repository: SqliteJobRepository,
        extractor: BabelDocExtractor,
        translation_provider: TranslationProvider,
    ) -> None:
        self.repository = repository
        self.attachments = attachments
        self.jobs = jobs
        self.job_repository = job_repository
        self.extractor = extractor
        self.translation_provider = translation_provider

    def register_handlers(self, registry: JobRegistry) -> None:
        registry.register("document.extract", self._extract)
        registry.register("document.translate", self._translate)

    def list_for_item(self, item_id: str) -> list[Document]:
        return self.repository.list_for_item(item_id)

    def get(self, document_id: str) -> Document:
        return self.repository.get(document_id)

    def blocks(
        self,
        document_id: str,
        *,
        offset: int,
        limit: int,
        target_language: str | None,
    ) -> DocumentBlocksPage:
        return self.repository.list_blocks(
            document_id,
            offset=offset,
            limit=limit,
            target_language=target_language,
        )

    def extract_attachment(
        self, attachment_id: str, request: DocumentExtractionRequest
    ) -> Job:
        attachment, _ = self.attachments.locate(attachment_id)
        if (
            attachment.attachment_type is not AttachmentType.FULLTEXT
            or attachment.format is not AttachmentFormat.PDF
        ):
            raise ValueError("只有 PDF 全文附件可以生成结构化文档")
        payload = DocumentExtractionJobInput(
            attachment_id=attachment.id,
            item_id=attachment.item_id,
            source_sha256=attachment.sha256,
            extractor=self.extractor.name,
            extractor_version=self.extractor.version,
            structure_version=self.extractor.structure_version,
            **request.model_dump(mode="json"),
        )
        identity = ":".join(
            (
                attachment.id,
                attachment.sha256,
                self.extractor.name,
                self.extractor.version,
                request.ocr_mode.value,
            )
        )
        return self.jobs.create(
            JobCreate(
                kind="document.extract",
                subject_type="attachment",
                subject_id=attachment.id,
                idempotency_key=f"document-extract:{_digest(identity)}",
                concurrency_key=f"document-extract:{attachment.id}",
                input=payload.model_dump(mode="json"),
                max_attempts=2,
            )
        )

    def translate_document(
        self, document_id: str, request: DocumentTranslationRequest
    ) -> Job:
        document = self.repository.get(document_id)
        if document.status is not DocumentStatus.READY or document.structure_hash is None:
            raise ValueError("只有就绪的结构化文档可以翻译")
        payload = DocumentTranslationJobInput(
            document_id=document.id,
            structure_hash=document.structure_hash,
            target_language=request.target_language,
            provider=self.translation_provider.name,
            model=self.translation_provider.model,
            prompt_version=TRANSLATION_PROMPT_VERSION,
        )
        identity = ":".join(
            (
                document.id,
                document.structure_hash,
                request.target_language,
                self.translation_provider.name,
                self.translation_provider.model,
                TRANSLATION_PROMPT_VERSION,
            )
        )
        return self.jobs.create(
            JobCreate(
                kind="document.translate",
                subject_type="document",
                subject_id=document.id,
                idempotency_key=f"document-translate:{_digest(identity)}",
                concurrency_key=f"document-translate:{document.id}",
                input=payload.model_dump(mode="json"),
                max_attempts=2,
            )
        )

    def reconcile_committed(self) -> int:
        reconciled = 0
        active = [
            *self.job_repository.list_jobs(status=JobStatus.RUNNING, limit=1000),
            *self.job_repository.list_jobs(
                status=JobStatus.CANCELLATION_REQUESTED, limit=1000
            ),
        ]
        for job in active:
            if job.kind == "document.extract":
                document = self.repository.find_for_job(job.id)
                if document is None:
                    continue
                self.job_repository.reconcile_committed(
                    job.id,
                    {
                        "document_id": document.id,
                        "page_count": document.page_count,
                        "block_count": document.block_count,
                    },
                )
                reconciled += 1
            elif job.kind == "document.translate":
                translated = self.repository.translation_count_for_job(job.id)
                if translated == 0:
                    continue
                self.job_repository.reconcile_committed(
                    job.id,
                    {
                        "document_id": job.input.get("document_id"),
                        "target_language": job.input.get("target_language"),
                        "translated_blocks": translated,
                    },
                )
                reconciled += 1
        return reconciled

    def _extract(self, context: JobExecutionContext) -> JobExecutionResult:
        request = _validated(DocumentExtractionJobInput, context.claimed.job.input)
        existing = self.repository.find_exact(
            source_attachment_id=request.attachment_id,
            source_sha256=request.source_sha256,
            extractor=request.extractor,
            extractor_version=request.extractor_version,
        )
        if existing is not None:
            context.emit(
                "document.extraction_reused", {"document_id": existing.id}, "info"
            )
            return _document_result(existing)
        attachment, path = self.attachments.locate(request.attachment_id)
        if attachment.item_id != request.item_id or attachment.sha256 != request.source_sha256:
            raise JobFailure("subject_mismatch", "源附件与任务快照不一致")
        try:
            extracted = self.extractor.extract(
                path,
                ocr_mode=request.ocr_mode,
                callbacks=ExtractionCallbacks(
                    cancellation=context.cancellation,
                    emit=context.emit,
                    record_process=context.record_process,
                ),
            )
        except DocumentExtractionError as error:
            raise JobFailure(error.code, str(error), retryable=error.retryable) from error
        if context.cancellation.is_cancelled:
            raise JobFailure("canceled", "文档结构提取已取消", retryable=True)
        structure_hash = _structure_hash(extracted.model_dump(mode="json"))
        try:
            document = self.repository.commit_extraction(
                item_id=request.item_id,
                source_attachment_id=request.attachment_id,
                source_sha256=request.source_sha256,
                extractor=request.extractor,
                extractor_version=request.extractor_version,
                structure_version=request.structure_version,
                structure_hash=structure_hash,
                extracted=extracted,
                job_id=context.claimed.job.id,
            )
        except DocumentConflictError as error:
            raise JobFailure("document_conflict", str(error)) from error
        context.emit(
            "document.extraction_committed",
            {
                "document_id": document.id,
                "structure_hash": document.structure_hash,
                "blocks": document.block_count,
            },
            "info",
        )
        return _document_result(document)

    def _translate(self, context: JobExecutionContext) -> JobExecutionResult:
        request = _validated(DocumentTranslationJobInput, context.claimed.job.input)
        document = self.repository.get(request.document_id)
        if document.structure_hash != request.structure_hash:
            raise JobFailure("document_stale", "文档结构在任务创建后发生变化")
        blocks = [
            block
            for block in self.repository.all_blocks(document.id)
            if block.source_text and block.kind.value != "formula"
        ]
        if not blocks:
            raise JobFailure("empty_document", "结构化文档没有可翻译的文本块")
        translated = self.repository.translation_count_for_job(context.claimed.job.id)
        if translated == len(blocks):
            context.emit(
                "document.translation_reused",
                {"document_id": document.id, "translated_blocks": translated},
                "info",
            )
            return JobExecutionResult(
                result={
                    "document_id": document.id,
                    "target_language": request.target_language,
                    "translated_blocks": translated,
                },
                commit_point_reached=True,
            )
        input_blocks = [
            TranslationInputBlock(
                id=block.id,
                kind=block.kind,
                source_text=block.source_text,
                section_path=block.section_path,
                page=block.page_start,
            )
            for block in blocks
        ]
        context.emit(
            "document.translation_started",
            {
                "document_id": document.id,
                "blocks": len(input_blocks),
                "provider": request.provider,
                "model": request.model,
                "mode": "whole_document_single_request",
            },
            "info",
        )
        try:
            output = self.translation_provider.translate_document(
                input_blocks,
                request.target_language,
                cancellation=lambda: context.cancellation.is_cancelled,
            )
        except DocumentTranslationError as error:
            raise JobFailure(error.code, str(error), retryable=error.retryable) from error
        expected_ids = [block.id for block in input_blocks]
        actual_ids = [item.id for item in output.translations]
        if actual_ids != expected_ids:
            raise JobFailure(
                "invalid_translation_output",
                "整篇翻译结果遗漏、重复、增加或重排了文档块",
            )
        if context.cancellation.is_cancelled:
            raise JobFailure("canceled", "整篇翻译已取消", retryable=True)
        try:
            count = self.repository.commit_translation(
                document_id=document.id,
                expected_structure_hash=request.structure_hash,
                target_language=request.target_language,
                provider=request.provider,
                model=request.model,
                prompt_version=request.prompt_version,
                output=output,
                job_id=context.claimed.job.id,
            )
        except DocumentConflictError as error:
            raise JobFailure("document_conflict", str(error)) from error
        context.emit(
            "document.translation_committed",
            {
                "document_id": document.id,
                "translated_blocks": count,
                "target_language": request.target_language,
            },
            "info",
        )
        return JobExecutionResult(
            result={
                "document_id": document.id,
                "target_language": request.target_language,
                "translated_blocks": count,
            },
            commit_point_reached=True,
        )


def _validated(model, payload):
    try:
        return model.model_validate(payload)
    except ValidationError as error:
        raise JobFailure("invalid_job_input", "任务参数不符合文档领域契约") from error


def _document_result(document: Document) -> JobExecutionResult:
    return JobExecutionResult(
        result={
            "document_id": document.id,
            "page_count": document.page_count,
            "block_count": document.block_count,
        },
        commit_point_reached=True,
    )


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _structure_hash(value: dict) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


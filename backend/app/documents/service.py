from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable

from pydantic import ValidationError

from app.jobs.models import Job, JobCreate, JobExecutionResult, JobFailure, JobStatus
from app.jobs.repository import SqliteJobRepository
from app.jobs.scheduler import JobExecutionContext, JobRegistry, JobScheduler
from app.library.models import AttachmentFormat, AttachmentType
from app.library.service import AttachmentService
from app.preferences import PreferencesService

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
    DocumentTranslationOutput,
    DocumentTranslationRequest,
    GlossaryOutputItem,
    TranslationGlossaryTerm,
    TranslationInputBlock,
    TranslationOutputItem,
)
from .prompts import TRANSLATION_PROMPT_VERSION
from .repository import DocumentConflictError, DocumentRepository
from .tex import TexStructureError, TexStructureExtractor
from .translation import (
    DocumentTranslationError,
    TranslationCapacity,
    TranslationProvider,
    TranslationProviderResponse,
    estimate_translation_output_tokens,
)

_PLACEHOLDER_PATTERN = re.compile(
    r"https?://[^\s)\]}]+|10\.\d{4,9}/[^\s)\]}]+|`[^`\n]+`|\$[^$\n]+\$|"
    r"\\\([^\n]+?\\\)|\\\[[^\n]+?\\\]|\[[0-9][0-9,;\-–—\s]*\]"
)
_FALLBACK_ERROR_CODES = {
    "document_too_large",
    "document_output_too_large",
    "translation_truncated",
    "translation_incomplete",
    "invalid_provider_response",
    "invalid_translation_output",
    "translation_placeholder_damaged",
    "translation_glossary_conflict",
    "translation_language_conflict",
}


class DocumentService:
    def __init__(
        self,
        repository: DocumentRepository,
        attachments: AttachmentService,
        jobs: JobScheduler,
        job_repository: SqliteJobRepository,
        extractor: BabelDocExtractor,
        tex_extractor: TexStructureExtractor,
        translation_provider: TranslationProvider,
        preferences: PreferencesService,
    ) -> None:
        self.repository = repository
        self.attachments = attachments
        self.jobs = jobs
        self.job_repository = job_repository
        self.extractor = extractor
        self.tex_extractor = tex_extractor
        self.translation_provider = translation_provider
        self.preferences = preferences

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

    def extract_attachment(self, attachment_id: str, request: DocumentExtractionRequest) -> Job:
        attachment, _ = self.attachments.locate(attachment_id)
        if (
            attachment.attachment_type is not AttachmentType.FULLTEXT
            or attachment.format is not AttachmentFormat.PDF
        ):
            raise ValueError("只有 PDF 全文附件可以生成结构化文档")
        tex_attachment = self._preferred_tex_attachment(attachment.item_id)
        extractor_name = self.extractor.name
        extractor_version = self.extractor.version
        if tex_attachment is not None:
            extractor_name = f"{extractor_name}+{self.tex_extractor.name}"
            extractor_version = (
                f"{extractor_version}+tex.{self.tex_extractor.version}.{tex_attachment.sha256[:12]}"
            )
        payload = DocumentExtractionJobInput(
            attachment_id=attachment.id,
            item_id=attachment.item_id,
            source_sha256=attachment.sha256,
            extractor=extractor_name,
            extractor_version=extractor_version,
            structure_version=self.extractor.structure_version,
            tex_attachment_id=tex_attachment.id if tex_attachment else None,
            tex_source_sha256=tex_attachment.sha256 if tex_attachment else None,
            **request.model_dump(mode="json"),
        )
        identity = ":".join(
            (
                attachment.id,
                attachment.sha256,
                extractor_name,
                extractor_version,
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

    def _preferred_tex_attachment(self, item_id: str):
        candidates = [
            attachment
            for attachment in self.attachments.list_for_item(item_id)
            if attachment.format is AttachmentFormat.TEX
            and attachment.attachment_type is AttachmentType.SOURCE_ARCHIVE
        ]
        if not candidates:
            return None
        return max(
            candidates,
            key=lambda attachment: (
                "structure" in attachment.preferred_for,
                "compile" in attachment.preferred_for,
                attachment.created_at,
                attachment.id,
            ),
        )

    def translate_document(self, document_id: str, request: DocumentTranslationRequest) -> Job:
        document = self.repository.get(document_id)
        if document.status is not DocumentStatus.READY or document.structure_hash is None:
            raise ValueError("只有就绪的结构化文档可以翻译")
        settings = self.preferences.get().translation
        if settings.provider.casefold() != self.translation_provider.name.casefold():
            raise ValueError("当前运行环境没有配置所选翻译提供者")
        previous_translation_job_id = (
            self.repository.latest_translation_job_id(document.id, request.target_language)
            if settings.retranslate_scope == "document"
            else None
        )
        payload = DocumentTranslationJobInput(
            document_id=document.id,
            structure_hash=document.structure_hash,
            target_language=request.target_language,
            provider=settings.provider,
            model=settings.model,
            prompt_version=TRANSLATION_PROMPT_VERSION,
            style=settings.style,
            batching=settings.batching,
            retranslate_scope=settings.retranslate_scope,
            previous_translation_job_id=previous_translation_job_id,
            glossary=[
                TranslationGlossaryTerm.model_validate(item.model_dump(mode="json"))
                for item in settings.glossary
            ],
        )
        identity = ":".join(
            (
                document.id,
                document.structure_hash,
                request.target_language,
                self.translation_provider.name,
                settings.model,
                TRANSLATION_PROMPT_VERSION,
                _digest(json.dumps(payload.model_dump(mode="json"), sort_keys=True)),
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
                max_attempts=3,
            )
        )

    def reconcile_committed(self) -> int:
        reconciled = 0
        active = [
            *self.job_repository.list_jobs(status=JobStatus.RUNNING, limit=1000),
            *self.job_repository.list_jobs(status=JobStatus.CANCELLATION_REQUESTED, limit=1000),
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
            context.emit("document.extraction_reused", {"document_id": existing.id}, "info")
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
            if request.tex_attachment_id is not None:
                tex_attachment, tex_path = self.attachments.locate(request.tex_attachment_id)
                if (
                    tex_attachment.item_id != request.item_id
                    or tex_attachment.format is not AttachmentFormat.TEX
                    or tex_attachment.sha256 != request.tex_source_sha256
                ):
                    raise JobFailure("tex_subject_mismatch", "TeX 源附件与任务快照不一致")
                try:
                    extracted = self.tex_extractor.enrich(tex_path, extracted)
                    context.emit(
                        "document.tex_structure_applied",
                        {
                            "tex_attachment_id": tex_attachment.id,
                            "blocks": len(extracted.blocks),
                            "anchor_matches": extracted.diagnostics.get(
                                "tex_pdf_anchor_matches", 0
                            ),
                        },
                        "info",
                    )
                except TexStructureError as error:
                    context.emit(
                        "document.tex_structure_fallback",
                        {"reason": str(error), "fallback": "pdf_layout"},
                        "warning",
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
        protected_blocks, placeholders = _protect_blocks(input_blocks)
        outline = [
            block.source_text for block in input_blocks if block.kind.value in {"title", "heading"}
        ]
        context.emit(
            "document.translation_started",
            {
                "document_id": document.id,
                "blocks": len(input_blocks),
                "provider": request.provider,
                "model": request.model,
                "mode": request.batching,
                "retranslate_scope": request.retranslate_scope,
                "previous_translation_job_id": request.previous_translation_job_id,
            },
            "info",
        )
        try:
            output = self._translate_with_fallback(
                context,
                request,
                protected_blocks,
                outline,
                placeholders,
            )
        except DocumentTranslationError as error:
            raise JobFailure(error.code, str(error), retryable=error.retryable) from error
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

    def _translate_with_fallback(
        self,
        context: JobExecutionContext,
        request: DocumentTranslationJobInput,
        blocks: list[TranslationInputBlock],
        outline: list[str],
        placeholders: dict[str, dict[str, str]],
    ) -> DocumentTranslationOutput:
        source_characters = sum(len(block.source_text) for block in blocks)
        capacity = self.translation_provider.capacity
        estimated_output_tokens = estimate_translation_output_tokens(blocks)
        safe_input_characters = max(1, int(capacity.max_input_characters * 0.82))
        safe_output_tokens = max(1, int(capacity.max_output_tokens * 0.82))
        use_chapters = request.batching == "chapter" or (
            request.batching == "whole_with_fallback"
            and (
                source_characters > safe_input_characters
                or estimated_output_tokens > safe_output_tokens
            )
        )
        if use_chapters:
            context.emit(
                "document.translation_fallback",
                {
                    "reason": "configured_chapters"
                    if request.batching == "chapter"
                    else (
                        "input_budget"
                        if source_characters > safe_input_characters
                        else "output_budget"
                    ),
                    "source_characters": source_characters,
                    "estimated_output_tokens": estimated_output_tokens,
                    "provider_input_budget": capacity.max_input_characters,
                    "provider_output_budget": capacity.max_output_tokens,
                },
                "warning",
            )
            return self._translate_batches(
                context,
                request,
                _chapter_batches(blocks, capacity),
                outline,
                placeholders,
                ordinal_offset=1,
            )
        try:
            return self._translate_batches(
                context,
                request,
                [blocks],
                outline,
                placeholders,
                ordinal_offset=0,
            )
        except DocumentTranslationError as error:
            if request.batching != "whole_with_fallback" or error.code not in _FALLBACK_ERROR_CODES:
                raise
            context.emit(
                "document.translation_fallback",
                {"reason": error.code, "message": str(error)},
                "warning",
            )
            return self._translate_batches(
                context,
                request,
                _chapter_batches(blocks, capacity),
                outline,
                placeholders,
                ordinal_offset=1,
            )

    def _translate_batches(
        self,
        context: JobExecutionContext,
        request: DocumentTranslationJobInput,
        batches: list[list[TranslationInputBlock]],
        outline: list[str],
        placeholders: dict[str, dict[str, str]],
        *,
        ordinal_offset: int,
    ) -> DocumentTranslationOutput:
        outputs: list[DocumentTranslationOutput] = []
        for index, batch in enumerate(batches):
            if context.cancellation.is_cancelled:
                raise DocumentTranslationError("canceled", "整篇翻译已取消", retryable=True)
            ordinal = index + ordinal_offset
            input_hash = _batch_hash(request, batch, outline)
            cached = self.repository.get_translation_checkpoint(
                context.claimed.job.id, ordinal, input_hash
            )
            if cached is not None:
                outputs.append(_validate_translation_output(batch, cached, placeholders))
                context.emit(
                    "document.translation_batch_reused",
                    {"batch": index + 1, "batches": len(batches)},
                    "info",
                )
                continue
            context.emit(
                "document.translation_batch_started",
                {
                    "batch": index + 1,
                    "batches": len(batches),
                    "blocks": len(batch),
                },
                "info",
            )
            provider_result = self.translation_provider.translate_document(
                batch,
                request.target_language,
                model=request.model,
                style=request.style,
                glossary=request.glossary,
                document_outline=outline,
                batch_label=f"chapter_{index + 1}_of_{len(batches)}",
                preceding_context=_neighbor_context(batches, index - 1, tail=True),
                following_context=_neighbor_context(batches, index + 1, tail=False),
                cancellation=lambda: context.cancellation.is_cancelled,
            )
            response = (
                provider_result
                if isinstance(provider_result, TranslationProviderResponse)
                else TranslationProviderResponse(output=provider_result)
            )
            validated = _validate_translation_output(batch, response.output, placeholders)
            try:
                self.repository.save_translation_checkpoint(
                    job_id=context.claimed.job.id,
                    batch_ordinal=ordinal,
                    input_sha256=input_hash,
                    output=response.output,
                    provider_request_id=response.request_id,
                    usage=dict(response.usage or {}),
                )
            except DocumentConflictError as error:
                raise DocumentTranslationError(
                    "translation_checkpoint_conflict", str(error)
                ) from error
            outputs.append(validated)
            context.emit(
                "document.translation_batch_verified",
                {
                    "batch": index + 1,
                    "batches": len(batches),
                    "blocks": len(batch),
                },
                "info",
            )
        return _merge_translation_outputs(outputs, request.glossary)


def _protect_blocks(
    blocks: list[TranslationInputBlock],
) -> tuple[list[TranslationInputBlock], dict[str, dict[str, str]]]:
    protected: list[TranslationInputBlock] = []
    placeholders: dict[str, dict[str, str]] = {}
    for block in blocks:
        source_text, replacements = _protect_text(block.source_text)
        protected.append(block.model_copy(update={"source_text": source_text}))
        placeholders[block.id] = replacements
    return protected, placeholders


def _protect_text(source_text: str) -> tuple[str, dict[str, str]]:
    replacements: dict[str, str] = {}

    def replace(match: re.Match[str]) -> str:
        original = match.group(0)
        token = (
            f"⟦HXAXD_{len(replacements):04d}_"
            f"{hashlib.sha256(original.encode('utf-8')).hexdigest()[:8]}⟧"
        )
        replacements[token] = original
        return token

    return _PLACEHOLDER_PATTERN.sub(replace, source_text), replacements


def _validate_translation_output(
    blocks: list[TranslationInputBlock],
    output: DocumentTranslationOutput,
    placeholders: dict[str, dict[str, str]],
) -> DocumentTranslationOutput:
    expected_ids = [block.id for block in blocks]
    actual_ids = [item.id for item in output.translations]
    if actual_ids != expected_ids:
        raise DocumentTranslationError(
            "invalid_translation_output",
            "翻译结果遗漏、重复、增加或重排了文档块",
        )
    restored: list[TranslationOutputItem] = []
    for item in output.translations:
        text = item.translated_text
        expected = placeholders.get(item.id, {})
        for token, original in expected.items():
            if text.count(token) != 1:
                raise DocumentTranslationError(
                    "translation_placeholder_damaged",
                    f"翻译块 {item.id} 损坏了公式、引用或链接占位符",
                )
            text = text.replace(token, original)
        if "⟦HXAXD_" in text:
            raise DocumentTranslationError(
                "translation_placeholder_damaged",
                f"翻译块 {item.id} 返回了未知占位符",
            )
        restored.append(item.model_copy(update={"translated_text": text}))
    return output.model_copy(update={"translations": restored})


def _chapter_batches(
    blocks: list[TranslationInputBlock], capacity: TranslationCapacity
) -> list[list[TranslationInputBlock]]:
    input_budget = max(1, int(capacity.max_input_characters * 0.72))
    output_budget = max(1, int(capacity.max_output_tokens * 0.72))
    batches: list[list[TranslationInputBlock]] = []
    current: list[TranslationInputBlock] = []
    current_input_size = 0
    current_section: str | None = None
    for block in blocks:
        input_size = len(block.source_text)
        output_size = estimate_translation_output_tokens([block])
        if input_size > capacity.max_input_characters or output_size > capacity.max_output_tokens:
            raise DocumentTranslationError(
                "document_block_too_large",
                f"阅读块 {block.id} 单独超过翻译提供者的输入或输出预算",
            )
        section = block.section_path[0] if block.section_path else None
        section_changed = bool(current) and section != current_section
        prospective = [*current, block]
        over_budget = bool(current) and (
            current_input_size + input_size > input_budget
            or estimate_translation_output_tokens(prospective) > output_budget
        )
        if section_changed or over_budget:
            batches.append(current)
            current = []
            current_input_size = 0
        current.append(block)
        current_input_size += input_size
        current_section = section
    if current:
        batches.append(current)
    return batches


def _neighbor_context(
    batches: list[list[TranslationInputBlock]], index: int, *, tail: bool
) -> str | None:
    if index < 0 or index >= len(batches):
        return None
    texts: Iterable[str]
    texts = (block.source_text for block in batches[index])
    value = "\n".join(texts)
    return value[-1200:] if tail else value[:1200]


def _batch_hash(
    request: DocumentTranslationJobInput,
    blocks: list[TranslationInputBlock],
    outline: list[str],
) -> str:
    payload = {
        "request": request.model_dump(mode="json"),
        "outline": outline,
        "blocks": [block.model_dump(mode="json") for block in blocks],
    }
    return _digest(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _merge_translation_outputs(
    outputs: list[DocumentTranslationOutput],
    required_glossary: list[TranslationGlossaryTerm],
) -> DocumentTranslationOutput:
    translations = [item for output in outputs for item in output.translations]
    terms: dict[str, GlossaryOutputItem] = {}
    for required in required_glossary:
        terms[required.source_term.casefold()] = GlossaryOutputItem(
            source_term=required.source_term,
            translated_term=required.translated_term,
            note="用户术语表",
        )
    for output in outputs:
        for item in output.glossary:
            normalized = item.source_term.casefold().strip()
            existing = terms.get(normalized)
            if existing and existing.translated_term != item.translated_term:
                raise DocumentTranslationError(
                    "translation_glossary_conflict",
                    f"翻译批次对术语 {item.source_term} 给出了不一致译名",
                )
            terms.setdefault(normalized, item)
    languages = {
        output.detected_source_language for output in outputs if output.detected_source_language
    }
    if len(languages) > 1:
        raise DocumentTranslationError(
            "translation_language_conflict", "翻译批次对源语言判断不一致"
        )
    return DocumentTranslationOutput(
        translations=translations,
        glossary=list(terms.values()),
        detected_source_language=next(iter(languages), None),
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
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    return hashlib.sha256(encoded).hexdigest()

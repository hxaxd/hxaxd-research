from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from app.platform.db import V3Database
from app.utils.identity import new_id

from .models import (
    BlockTranslation,
    Document,
    DocumentBlock,
    DocumentBlocksPage,
    DocumentBlockView,
    DocumentTranslationOutput,
    ExtractedDocument,
)


class DocumentNotFoundError(LookupError):
    pass


class DocumentConflictError(RuntimeError):
    pass


class DocumentRepository:
    def __init__(self, database: V3Database) -> None:
        self.database = database

    def get(self, document_id: str) -> Document:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
        if row is None:
            raise DocumentNotFoundError("结构化文档不存在")
        return self._document(row)

    def list_for_item(self, item_id: str) -> list[Document]:
        with self.database.read() as connection:
            rows = connection.execute(
                """
                SELECT * FROM documents WHERE item_id = ?
                ORDER BY created_at DESC, id DESC
                """,
                (item_id,),
            ).fetchall()
        return [self._document(row) for row in rows]

    def find_exact(
        self,
        *,
        source_attachment_id: str,
        source_sha256: str,
        extractor: str,
        extractor_version: str,
    ) -> Document | None:
        with self.database.read() as connection:
            row = connection.execute(
                """
                SELECT * FROM documents
                WHERE source_attachment_id = ? AND source_sha256 = ?
                  AND extractor = ? AND extractor_version = ?
                """,
                (
                    source_attachment_id,
                    source_sha256,
                    extractor,
                    extractor_version,
                ),
            ).fetchone()
        return self._document(row) if row is not None else None

    def find_for_job(self, job_id: str) -> Document | None:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM documents WHERE created_by_job_id = ?", (job_id,)
            ).fetchone()
        return self._document(row) if row is not None else None

    def list_blocks(
        self,
        document_id: str,
        *,
        offset: int = 0,
        limit: int = 200,
        target_language: str | None = None,
    ) -> DocumentBlocksPage:
        self.get(document_id)
        with self.database.read() as connection:
            total = int(
                connection.execute(
                    "SELECT COUNT(*) FROM document_blocks WHERE document_id = ?",
                    (document_id,),
                ).fetchone()[0]
            )
            if target_language is None:
                rows = connection.execute(
                    """
                    SELECT b.* FROM document_blocks b
                    WHERE b.document_id = ? ORDER BY b.ordinal LIMIT ? OFFSET ?
                    """,
                    (document_id, limit, offset),
                ).fetchall()
                items = [
                    DocumentBlockView(**self._block(row).model_dump(), translation=None)
                    for row in rows
                ]
            else:
                rows = connection.execute(
                    """
                    SELECT b.*, t.id AS translation_id, t.target_language,
                        t.translated_text, t.source_sha256 AS translation_source_sha256,
                        t.provider, t.model, t.prompt_version, t.batch_id,
                        t.validation_status,
                        t.created_by_job_id AS translation_created_by_job_id,
                        t.created_at AS translation_created_at
                    FROM document_blocks b
                    LEFT JOIN block_translations t ON t.id = (
                        SELECT candidate.id FROM block_translations candidate
                        WHERE candidate.block_id = b.id
                          AND candidate.target_language = ?
                        ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
                    )
                    WHERE b.document_id = ?
                    ORDER BY b.ordinal LIMIT ? OFFSET ?
                    """,
                    (target_language, document_id, limit, offset),
                ).fetchall()
                items = [self._block_view(row) for row in rows]
        return DocumentBlocksPage(
            document_id=document_id,
            offset=offset,
            limit=limit,
            total=total,
            items=items,
        )

    def all_blocks(self, document_id: str) -> list[DocumentBlock]:
        with self.database.read() as connection:
            rows = connection.execute(
                """
                SELECT * FROM document_blocks WHERE document_id = ?
                ORDER BY ordinal
                """,
                (document_id,),
            ).fetchall()
        return [self._block(row) for row in rows]

    def commit_extraction(
        self,
        *,
        item_id: str,
        source_attachment_id: str,
        source_sha256: str,
        extractor: str,
        extractor_version: str,
        structure_version: str,
        structure_hash: str,
        extracted: ExtractedDocument,
        job_id: str,
    ) -> Document:
        now = _now()
        document_id = new_id()
        with self.database.transaction() as connection:
            attachment = connection.execute(
                """
                SELECT a.item_id, b.sha256 FROM attachments a
                JOIN blobs b ON b.id = a.blob_id WHERE a.id = ?
                """,
                (source_attachment_id,),
            ).fetchone()
            if attachment is None:
                raise DocumentConflictError("源附件不存在")
            if attachment["item_id"] != item_id or attachment["sha256"] != source_sha256:
                raise DocumentConflictError("源附件在提取期间发生变化")
            existing = connection.execute(
                """
                SELECT * FROM documents
                WHERE source_attachment_id = ? AND source_sha256 = ?
                  AND extractor = ? AND extractor_version = ?
                """,
                (
                    source_attachment_id,
                    source_sha256,
                    extractor,
                    extractor_version,
                ),
            ).fetchone()
            if existing is not None:
                return self._document(existing)
            connection.execute(
                """
                UPDATE documents SET status = 'superseded'
                WHERE source_attachment_id = ? AND status = 'ready'
                """,
                (source_attachment_id,),
            )
            connection.execute(
                """
                INSERT INTO documents(
                    id, item_id, source_attachment_id, source_sha256,
                    extractor, extractor_version, structure_version, status,
                    language, page_count, block_count, structure_hash,
                    created_by_job_id, created_at, completed_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    document_id,
                    item_id,
                    source_attachment_id,
                    source_sha256,
                    extractor,
                    extractor_version,
                    structure_version,
                    extracted.language,
                    extracted.page_count,
                    len(extracted.blocks),
                    structure_hash,
                    job_id,
                    now,
                    now,
                ),
            )
            for ordinal, block in enumerate(extracted.blocks):
                connection.execute(
                    """
                    INSERT INTO document_blocks(
                        id, document_id, parent_id, ordinal, kind, semantic_role,
                        source_text, source_sha256, page_start, page_end,
                        anchor_json, section_path_json, created_at
                    ) VALUES(?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        new_id(),
                        document_id,
                        ordinal,
                        block.kind.value,
                        block.semantic_role.value if block.semantic_role else None,
                        block.source_text,
                        _sha256(block.source_text),
                        block.page_start,
                        block.page_end,
                        _json(block.anchor),
                        _json(block.section_path),
                        now,
                    ),
                )
            self._audit(
                connection,
                now=now,
                action="document.extracted",
                entity_type="document",
                entity_id=document_id,
                correlation_id=job_id,
                metadata={
                    "source_attachment_id": source_attachment_id,
                    "source_sha256": source_sha256,
                    "structure_hash": structure_hash,
                    "page_count": extracted.page_count,
                    "block_count": len(extracted.blocks),
                    "extractor": extractor,
                    "extractor_version": extractor_version,
                },
            )
            row = connection.execute(
                "SELECT * FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
        assert row is not None
        return self._document(row)

    def commit_translation(
        self,
        *,
        document_id: str,
        expected_structure_hash: str,
        target_language: str,
        provider: str,
        model: str,
        prompt_version: str,
        output: DocumentTranslationOutput,
        job_id: str,
    ) -> int:
        now = _now()
        with self.database.transaction() as connection:
            document = connection.execute(
                "SELECT * FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
            if document is None:
                raise DocumentNotFoundError("结构化文档不存在")
            if document["status"] != "ready":
                raise DocumentConflictError("只有就绪文档可以翻译")
            if document["structure_hash"] != expected_structure_hash:
                raise DocumentConflictError("文档结构在翻译期间发生变化")
            blocks = connection.execute(
                """
                SELECT id, source_sha256 FROM document_blocks
                WHERE document_id = ? AND source_text != '' AND kind != 'formula'
                ORDER BY ordinal
                """,
                (document_id,),
            ).fetchall()
            expected_ids = [str(row["id"]) for row in blocks]
            actual_ids = [item.id for item in output.translations]
            if actual_ids != expected_ids:
                raise DocumentConflictError("翻译块标识或顺序不符合当前文档结构")
            for row, item in zip(blocks, output.translations, strict=True):
                connection.execute(
                    """
                    INSERT INTO block_translations(
                        id, block_id, target_language, translated_text,
                        source_sha256, provider, model, prompt_version, batch_id,
                        validation_status, created_by_job_id, created_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)
                    ON CONFLICT(
                        block_id, target_language, source_sha256,
                        provider, model, prompt_version
                    ) DO UPDATE SET
                        translated_text = excluded.translated_text,
                        batch_id = excluded.batch_id,
                        validation_status = 'verified',
                        created_by_job_id = excluded.created_by_job_id,
                        created_at = excluded.created_at
                    """,
                    (
                        new_id(),
                        row["id"],
                        target_language,
                        item.translated_text,
                        row["source_sha256"],
                        provider,
                        model,
                        prompt_version,
                        job_id,
                        job_id,
                        now,
                    ),
                )
                connection.execute(
                    "UPDATE document_blocks SET semantic_role = ? WHERE id = ?",
                    (item.semantic_role.value, row["id"]),
                )
            seen_terms: set[str] = set()
            for glossary in output.glossary:
                normalized = glossary.source_term.casefold().strip()
                if normalized in seen_terms:
                    raise DocumentConflictError("翻译术语表包含重复源词")
                seen_terms.add(normalized)
                connection.execute(
                    """
                    INSERT INTO document_glossary_entries(
                        id, document_id, target_language, source_term,
                        translated_term, note, batch_id, created_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(document_id, target_language, source_term)
                    DO UPDATE SET
                        translated_term = excluded.translated_term,
                        note = excluded.note,
                        batch_id = excluded.batch_id,
                        created_at = excluded.created_at
                    """,
                    (
                        new_id(),
                        document_id,
                        target_language,
                        glossary.source_term,
                        glossary.translated_term,
                        glossary.note,
                        job_id,
                        now,
                    ),
                )
            if output.detected_source_language:
                connection.execute(
                    "UPDATE documents SET language = ? WHERE id = ?",
                    (output.detected_source_language, document_id),
                )
            self._audit(
                connection,
                now=now,
                action="document.translated",
                entity_type="document",
                entity_id=document_id,
                correlation_id=job_id,
                metadata={
                    "target_language": target_language,
                    "provider": provider,
                    "model": model,
                    "prompt_version": prompt_version,
                    "translated_blocks": len(output.translations),
                    "glossary_entries": len(output.glossary),
                },
            )
        return len(output.translations)

    def get_translation_checkpoint(
        self, job_id: str, batch_ordinal: int, input_sha256: str
    ) -> DocumentTranslationOutput | None:
        with self.database.read() as connection:
            row = connection.execute(
                """
                SELECT input_sha256, output_json FROM translation_batch_checkpoints
                WHERE job_id = ? AND batch_ordinal = ?
                """,
                (job_id, batch_ordinal),
            ).fetchone()
        if row is None:
            return None
        if row["input_sha256"] != input_sha256:
            raise DocumentConflictError("翻译批次检查点与当前任务输入不一致")
        return DocumentTranslationOutput.model_validate(json.loads(row["output_json"]))

    def save_translation_checkpoint(
        self,
        *,
        job_id: str,
        batch_ordinal: int,
        input_sha256: str,
        output: DocumentTranslationOutput,
        provider_request_id: str | None,
        usage: dict[str, object],
    ) -> None:
        now = _now()
        encoded_output = _json(output.model_dump(mode="json"))
        with self.database.transaction() as connection:
            existing = connection.execute(
                """
                SELECT input_sha256, output_json FROM translation_batch_checkpoints
                WHERE job_id = ? AND batch_ordinal = ?
                """,
                (job_id, batch_ordinal),
            ).fetchone()
            if existing is not None:
                if existing["input_sha256"] != input_sha256:
                    raise DocumentConflictError("翻译批次检查点与当前任务输入不一致")
                if existing["output_json"] != encoded_output:
                    raise DocumentConflictError("已验证翻译批次不能被不同结果覆盖")
                return
            connection.execute(
                """
                INSERT INTO translation_batch_checkpoints(
                    job_id, batch_ordinal, input_sha256, output_json,
                    provider_request_id, usage_json, created_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    batch_ordinal,
                    input_sha256,
                    encoded_output,
                    provider_request_id,
                    _json(usage),
                    now,
                ),
            )
            self._audit(
                connection,
                now=now,
                action="document.translation_batch_verified",
                entity_type="translation_batch",
                entity_id=f"{job_id}:{batch_ordinal}",
                correlation_id=job_id,
                metadata={
                    "batch_ordinal": batch_ordinal,
                    "input_sha256": input_sha256,
                    "provider_request_id": provider_request_id,
                    "usage": usage,
                },
            )

    def translation_count_for_job(self, job_id: str) -> int:
        with self.database.read() as connection:
            return int(
                connection.execute(
                    "SELECT COUNT(*) FROM block_translations WHERE created_by_job_id = ?",
                    (job_id,),
                ).fetchone()[0]
            )

    @staticmethod
    def _document(row: sqlite3.Row) -> Document:
        return Document.model_validate(dict(row))

    @staticmethod
    def _block(row: sqlite3.Row) -> DocumentBlock:
        values = {
            key: row[key]
            for key in (
                "id",
                "document_id",
                "parent_id",
                "ordinal",
                "kind",
                "semantic_role",
                "source_text",
                "source_sha256",
                "page_start",
                "page_end",
                "created_at",
            )
        }
        values["anchor"] = json.loads(row["anchor_json"])
        values["section_path"] = json.loads(row["section_path_json"])
        return DocumentBlock.model_validate(values)

    @classmethod
    def _block_view(cls, row: sqlite3.Row) -> DocumentBlockView:
        block = cls._block(row)
        translation = None
        if row["translation_id"] is not None:
            translation = BlockTranslation(
                id=row["translation_id"],
                block_id=row["id"],
                target_language=row["target_language"],
                translated_text=row["translated_text"],
                source_sha256=row["translation_source_sha256"],
                provider=row["provider"],
                model=row["model"],
                prompt_version=row["prompt_version"],
                batch_id=row["batch_id"],
                validation_status=row["validation_status"],
                created_by_job_id=row["translation_created_by_job_id"],
                created_at=row["translation_created_at"],
            )
        return DocumentBlockView(**block.model_dump(), translation=translation)

    @staticmethod
    def _audit(
        connection: sqlite3.Connection,
        *,
        now: str,
        action: str,
        entity_type: str,
        entity_id: str,
        correlation_id: str | None,
        metadata: dict[str, Any],
    ) -> None:
        connection.execute(
            """
            INSERT INTO audit_events(
                id, occurred_at, actor_type, actor_id, action,
                entity_type, entity_id, correlation_id,
                before_json, after_json, metadata_json
            ) VALUES(?, ?, 'system', NULL, ?, ?, ?, ?, NULL, NULL, ?)
            """,
            (
                new_id(),
                now,
                action,
                entity_type,
                entity_id,
                correlation_id,
                _json(metadata),
            ),
        )


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

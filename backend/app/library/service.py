from __future__ import annotations

from pathlib import Path

from fastapi import UploadFile

from app.utils.identity import new_id
from app.utils.time import utc_now

from .models import (
    Attachment,
    AttachmentFormat,
    AttachmentOrigin,
    AttachmentPreferenceCommand,
    AttachmentType,
    GeneratedAttachment,
    LanguageMode,
)
from .repository import AttachmentRepository
from .storage import AttachmentStorage, StagedObject


class AttachmentService:
    def __init__(self, repository: AttachmentRepository, storage: AttachmentStorage):
        self.repository = repository
        self.storage = storage

    def list_for_item(self, item_id: str) -> list[Attachment]:
        return self.repository.list_for_item(item_id)

    def outputs_for_job(
        self, job_id: str, roles: list[str]
    ) -> dict[str, Attachment]:
        return self.repository.outputs_for_job(job_id, roles)

    async def upload(
        self,
        item_id: str,
        upload: UploadFile,
        attachment_type: AttachmentType,
        language_mode: LanguageMode,
        origin: AttachmentOrigin,
        source_url: str | None,
        preferred_for: list[str],
    ) -> Attachment:
        staged = await self.storage.stage_upload(upload, attachment_type)
        return self._commit_batch(
            item_id,
            [(staged, GeneratedAttachment(
                filename=staged.filename,
                attachment_type=attachment_type,
                language_mode=language_mode,
                origin=origin,
                source_url=source_url,
                preferred_for=preferred_for,
            ))],
        )[0]

    def register_generated_batch(
        self,
        item_id: str,
        outputs: list[tuple[Path, GeneratedAttachment]],
        *,
        parent_attachment_id: str | None,
        job_id: str | None,
        operation_roles: list[str] | None = None,
    ) -> list[Attachment]:
        if operation_roles is not None and len(operation_roles) != len(outputs):
            raise ValueError("每个生成附件都必须有且只有一个操作角色")
        if operation_roles is not None and job_id is None:
            raise ValueError("操作角色必须绑定持久任务")
        if operation_roles is not None:
            existing = self.repository.outputs_for_job(job_id, operation_roles)
            if len(existing) == len(operation_roles):
                return [existing[role] for role in operation_roles]
        staged: list[tuple[StagedObject, GeneratedAttachment]] = []
        try:
            for path, metadata in outputs:
                staged.append(
                    (
                        self.storage.stage_generated(
                            path, metadata.filename, metadata.attachment_type
                        ),
                        metadata,
                    )
                )
            return self._commit_batch(
                item_id,
                staged,
                parent_attachment_id=parent_attachment_id,
                job_id=job_id,
                operation_roles=operation_roles,
            )
        except Exception:
            for item, _ in staged:
                item.source.unlink(missing_ok=True)
            raise

    def set_preference(
        self, item_id: str, command: AttachmentPreferenceCommand
    ) -> Attachment:
        self.repository.set_preference(
            item_id,
            command.purpose,
            command.attachment_id,
            utc_now().isoformat(),
        )
        return self.repository.get(command.attachment_id)

    def locate(self, attachment_id: str) -> tuple[Attachment, Path]:
        attachment = self.repository.get(attachment_id)
        return attachment, self.storage.resolve(attachment.storage_key)

    def _commit_batch(
        self,
        item_id: str,
        staged: list[tuple[StagedObject, GeneratedAttachment]],
        *,
        parent_attachment_id: str | None = None,
        job_id: str | None = None,
        operation_roles: list[str] | None = None,
    ) -> list[Attachment]:
        now = utc_now().isoformat()
        records: list[dict] = []
        roles = operation_roles or [None] * len(staged)
        for (content, metadata), operation_role in zip(staged, roles, strict=True):
            attachment_id = new_id()
            records.append(
                {
                    "id": attachment_id,
                    "item_id": item_id,
                    "blob_id": content.sha256,
                    "object_id": new_id(),
                    "created_by_job_id": job_id,
                    "operation_role": operation_role,
                    "attachment_type": metadata.attachment_type.value,
                    "format": (
                        metadata.format
                        or (
                            AttachmentFormat.PDF
                            if metadata.attachment_type == AttachmentType.FULLTEXT
                            else AttachmentFormat.TEX
                            if metadata.attachment_type == AttachmentType.SOURCE_ARCHIVE
                            else AttachmentFormat.OTHER
                        )
                    ).value,
                    "language_mode": metadata.language_mode.value,
                    "origin": metadata.origin.value,
                    "filename": content.filename,
                    "source_url": metadata.source_url,
                    "media_type": content.media_type,
                    "sha256": content.sha256,
                    "size": content.size,
                    "storage_key": (
                        Path("artifacts") / item_id / attachment_id / content.filename
                    ).as_posix(),
                    "preferred_for": list(dict.fromkeys(metadata.preferred_for)),
                    "created_at": now,
                }
            )

        committed: list[str] = []
        try:
            with self.repository.database.transaction() as connection:
                self.repository.insert_many(connection, records)
                for (content, _), record in zip(staged, records, strict=True):
                    if record["object_id"] is None:
                        content.source.unlink(missing_ok=True)
                        continue
                    storage_key = self.storage.commit(content, item_id, record["id"])
                    if storage_key != record["storage_key"]:
                        raise RuntimeError("附件存储路径与登记路径不一致")
                    committed.append(storage_key)
                self.repository.mark_objects_ready(
                    connection,
                    [record["object_id"] for record in records if record["object_id"]],
                )
                if parent_attachment_id:
                    connection.executemany(
                        """
                        INSERT INTO attachment_relations(
                            parent_attachment_id, child_attachment_id,
                            relation_type, job_id, created_at
                        ) VALUES(?, ?, 'derived_from', ?, ?)
                        """,
                        (
                            (parent_attachment_id, record["id"], job_id, now)
                            for record in records
                        ),
                    )
        except Exception:
            for storage_key in committed:
                self.storage.rollback_committed(storage_key)
            for content, _ in staged:
                content.source.unlink(missing_ok=True)
            raise
        return [self.repository.get(record["id"]) for record in records]

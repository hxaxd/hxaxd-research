from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class _HistoryModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AuditEventView(_HistoryModel):
    id: str
    occurred_at: datetime
    actor_type: str
    actor_id: str | None
    action: str
    entity_type: str
    entity_id: str
    correlation_id: str | None
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    metadata: dict[str, Any]


class AuditEventPage(_HistoryModel):
    items: list[AuditEventView]
    total: int
    limit: int
    offset: int


class ItemRevisionView(_HistoryModel):
    id: str
    revision: int
    actor_type: str
    actor_id: str | None
    change_set_id: str | None
    changes: dict[str, Any]
    evidence: list[dict[str, Any]]
    created_at: datetime


class ItemFieldSourceView(_HistoryModel):
    field_path: str
    source_record_id: str
    provider: str
    external_key: str | None
    source_url: str | None
    retrieved_at: datetime
    selected_at: datetime


class AttachmentRelationView(_HistoryModel):
    parent_attachment_id: str
    parent_filename: str
    child_attachment_id: str
    child_filename: str
    relation_type: str
    job_id: str | None
    created_at: datetime


class ItemHistoryView(_HistoryModel):
    item_id: str
    revisions: list[ItemRevisionView]
    field_sources: list[ItemFieldSourceView]
    attachment_relations: list[AttachmentRelationView]
    audit_events: list[AuditEventView]


class DocumentGlossaryEntryView(_HistoryModel):
    id: str
    document_id: str
    target_language: str
    source_term: str
    translated_term: str
    note: str | None
    batch_id: str
    created_at: datetime

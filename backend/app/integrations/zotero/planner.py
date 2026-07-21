from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from .models import (
    BibliographicDraft,
    ConflictKind,
    FieldDifference,
    TransferAction,
    TransferAttachmentPlan,
    TransferAttachmentSnapshot,
    TransferCandidate,
    TransferConflict,
    TransferFingerprint,
    TransferPlanItem,
    TransferPlanRequest,
    TransferPreview,
    TransferSummary,
)


def canonical_hash(value: Any) -> str:
    serialized = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(serialized).hexdigest()


def bibliographic_payload(draft: BibliographicDraft) -> dict[str, Any]:
    """Semantic fields that must round-trip; provider envelope metadata is excluded."""

    payload = draft.model_dump(
        mode="json",
        exclude={"external_key", "external_version", "raw"},
    )
    for creator in payload["creators"]:
        creator.pop("raw", None)
    for tag in payload["tags"]:
        tag.pop("raw", None)
    return payload


def fingerprint(draft: BibliographicDraft) -> TransferFingerprint:
    return TransferFingerprint(
        key=draft.external_key,
        version=draft.external_version,
        content_hash=canonical_hash(bibliographic_payload(draft)),
    )


def candidate_fingerprint(
    draft: BibliographicDraft,
    attachments: list[TransferAttachmentSnapshot],
) -> TransferFingerprint:
    if not attachments:
        return fingerprint(draft)
    payload = {
        "metadata": bibliographic_payload(draft),
        "attachments": sorted(
            (_attachment_payload(attachment) for attachment in attachments),
            key=lambda value: (
                value["filename"].casefold(),
                value.get("checksum") or "",
                value.get("size") or 0,
            ),
        ),
    }
    return TransferFingerprint(
        key=draft.external_key,
        version=draft.external_version,
        content_hash=canonical_hash(payload),
    )


class ZoteroDiffPlanner:
    def __init__(self, clock: Callable[[], datetime] | None = None):
        self._clock = clock or (lambda: datetime.now(UTC))

    def plan(self, request: TransferPlanRequest) -> TransferPreview:
        created_at = self._clock()
        items = [self._plan_item(candidate) for candidate in request.items]
        summary = self._summarize(items)
        preview_core = {
            "direction": request.direction.value,
            "library": request.library.model_dump(mode="json"),
            "project_id": request.project_id,
            "items": [item.model_dump(mode="json") for item in items],
        }
        preview_hash = canonical_hash(preview_core)
        return TransferPreview(
            id=uuid4().hex,
            direction=request.direction,
            library=request.library,
            project_id=request.project_id,
            created_at=created_at,
            expires_at=created_at + timedelta(seconds=request.ttl_seconds),
            items=items,
            summary=summary,
            preview_hash=preview_hash,
        )

    def _plan_item(self, candidate: TransferCandidate) -> TransferPlanItem:
        source_fingerprint = candidate_fingerprint(
            candidate.source, candidate.source_attachments
        )
        target_fingerprint = (
            candidate_fingerprint(candidate.target, candidate.target_attachments)
            if candidate.target
            else None
        )
        differences = _differences(candidate.source, candidate.target)
        attachment_plans = _attachment_plans(
            candidate.source_attachments, candidate.target_attachments
        )
        if any(attachment.action != TransferAction.UNCHANGED for attachment in attachment_plans):
            differences.append(
                FieldDifference(
                    field="attachments",
                    source=[_attachment_payload(item) for item in candidate.source_attachments],
                    target=[_attachment_payload(item) for item in candidate.target_attachments],
                )
            )
        blocked_reason = _blocked_reason(candidate)
        action: TransferAction
        conflicts: list[TransferConflict] = []

        if blocked_reason:
            action = TransferAction.BLOCKED
        elif candidate.target is None:
            action = TransferAction.NEW
        elif source_fingerprint.content_hash == target_fingerprint.content_hash:
            action = TransferAction.UNCHANGED
        elif any(attachment.action == TransferAction.CONFLICT for attachment in attachment_plans):
            action = TransferAction.CONFLICT
            conflicts = [
                _conflict(
                    candidate.item_id,
                    ConflictKind.UNLINKED_TARGET,
                    "A target PDF has the same filename but different content.",
                    differences,
                )
            ]
        elif candidate.baseline is None:
            action = TransferAction.CONFLICT
            conflicts = [
                _conflict(
                    candidate.item_id,
                    ConflictKind.UNLINKED_TARGET,
                    "A different target exists but has no shared synchronization baseline.",
                    differences,
                )
            ]
        else:
            source_changed = source_fingerprint.content_hash != candidate.baseline.source_hash
            target_changed = target_fingerprint.content_hash != candidate.baseline.target_hash
            if source_changed and not target_changed:
                action = TransferAction.UPDATE
            elif source_changed and target_changed:
                action = TransferAction.CONFLICT
                conflicts = [
                    _conflict(
                        candidate.item_id,
                        ConflictKind.SOURCE_AND_TARGET_CHANGED,
                        "Source and target both changed since the shared baseline.",
                        differences,
                    )
                ]
            elif not source_changed and target_changed:
                action = TransferAction.CONFLICT
                conflicts = [
                    _conflict(
                        candidate.item_id,
                        ConflictKind.TARGET_CHANGED,
                        "The target changed since the shared baseline.",
                        differences,
                    )
                ]
            else:
                action = TransferAction.CONFLICT
                conflicts = [
                    _conflict(
                        candidate.item_id,
                        ConflictKind.INCONSISTENT_BASELINE,
                        "Current data differs although neither side differs "
                        "from its baseline hash.",
                        differences,
                    )
                ]

        return TransferPlanItem(
            item_id=candidate.item_id,
            action=action,
            source=candidate.source,
            target=candidate.target,
            source_fingerprint=source_fingerprint,
            target_fingerprint=target_fingerprint,
            differences=differences,
            attachments=attachment_plans,
            conflicts=conflicts,
            blocked_reason=blocked_reason,
        )

    @staticmethod
    def _summarize(items: list[TransferPlanItem]) -> TransferSummary:
        counts = {action: 0 for action in TransferAction}
        for item in items:
            counts[item.action] += 1
        return TransferSummary(
            total=len(items),
            new=counts[TransferAction.NEW],
            update=counts[TransferAction.UPDATE],
            unchanged=counts[TransferAction.UNCHANGED],
            conflict=counts[TransferAction.CONFLICT],
            blocked=counts[TransferAction.BLOCKED],
        )


def _differences(
    source: BibliographicDraft, target: BibliographicDraft | None
) -> list[FieldDifference]:
    source_data = bibliographic_payload(source)
    target_data = bibliographic_payload(target) if target else {}
    result: list[FieldDifference] = []
    for field in sorted(source_data.keys() | target_data.keys()):
        if source_data.get(field) != target_data.get(field):
            result.append(
                FieldDifference(
                    field=field,
                    source=source_data.get(field),
                    target=target_data.get(field),
                )
            )
    return result


def _blocked_reason(candidate: TransferCandidate) -> str | None:
    if candidate.blocked_reason:
        return candidate.blocked_reason
    if not candidate.source.item_type.strip():
        return "Source item type is required."
    if not candidate.source.title.strip():
        return "Source title is required."
    return None


def _attachment_payload(attachment: TransferAttachmentSnapshot) -> dict[str, Any]:
    return attachment.model_dump(
        mode="json",
        exclude={"ref", "local_attachment_id", "external_key", "external_version"},
    )


def _attachment_plans(
    source: list[TransferAttachmentSnapshot],
    target: list[TransferAttachmentSnapshot],
) -> list[TransferAttachmentPlan]:
    unused = list(target)
    plans: list[TransferAttachmentPlan] = []
    for attachment in sorted(source, key=lambda value: (value.filename.casefold(), value.ref)):
        exact = next(
            (
                candidate
                for candidate in unused
                if attachment.checksum
                and attachment.checksum_algorithm == candidate.checksum_algorithm
                and attachment.checksum == candidate.checksum
            ),
            None,
        )
        named = next(
            (
                candidate
                for candidate in unused
                if candidate.filename.casefold() == attachment.filename.casefold()
            ),
            None,
        )
        matched = exact or named
        if matched is not None:
            unused.remove(matched)
        action = (
            TransferAction.NEW
            if matched is None
            else TransferAction.UNCHANGED
            if exact is not None
            else TransferAction.CONFLICT
        )
        plans.append(
            TransferAttachmentPlan(
                ref=attachment.ref,
                action=action,
                source=attachment,
                target=matched,
                blocked_reason=(
                    "A target attachment already uses this filename."
                    if action == TransferAction.CONFLICT
                    else None
                ),
            )
        )
    return plans


def _conflict(
    item_id: str,
    kind: ConflictKind,
    message: str,
    differences: list[FieldDifference],
) -> TransferConflict:
    fields = [difference.field for difference in differences]
    conflict_hash = canonical_hash({"item_id": item_id, "kind": kind.value, "fields": fields})
    return TransferConflict(
        id=f"conflict-{conflict_hash[:24]}",
        item_id=item_id,
        kind=kind,
        message=message,
        fields=fields,
    )

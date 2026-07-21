from __future__ import annotations

import hashlib
import re
import tempfile
from collections.abc import Sequence
from contextlib import ExitStack
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.catalog.models import BibliographicItemView
from app.library.models import Attachment, AttachmentFormat

from .domain import ZoteroDomainPort
from .http import ZoteroHttpError, ZoteroLocalClient, ZoteroWebClient
from .mapping import catalog_item_to_draft, draft_to_zotero_data, zotero_item_to_draft
from .models import (
    BibliographicDraft,
    ConflictChoice,
    ConflictResolution,
    SyncBaseline,
    TransferAction,
    TransferAttachmentSnapshot,
    TransferCandidate,
    TransferFingerprint,
    TransferItemReceipt,
    TransferPlanItem,
    TransferPreview,
    TransferPreviewRequest,
    ZoteroBinding,
    ZoteroEndpointStatus,
    ZoteroIntegrationStatus,
    ZoteroLibraryRef,
)
from .planner import candidate_fingerprint
from .repository import ZoteroTransferRepository

_IDENTITY_SCHEMES = {"arxiv", "doi", "isbn", "openreview", "pmid", "pubmed"}
_PDF = re.compile(r"\.pdf$", re.IGNORECASE)


class ZoteroCapabilityUnavailableError(RuntimeError):
    pass


class ZoteroSyncEngine:
    """Deterministic v3↔Zotero synchronization; no agent participates in writes."""

    def __init__(
        self,
        *,
        domain: ZoteroDomainPort,
        repository: ZoteroTransferRepository,
        local_client: ZoteroLocalClient | None = None,
        web_client: ZoteroWebClient | None = None,
    ) -> None:
        self.domain = domain
        self.repository = repository
        self.local_client = local_client
        self.web_client = web_client

    def status(self) -> ZoteroIntegrationStatus:
        local_available = False
        local_message = "Zotero Desktop local API is not configured."
        if self.local_client is not None:
            local_available = self.local_client.probe()
            local_message = (
                "Zotero Desktop local API is available for read-only imports."
                if local_available
                else "Zotero Desktop local API is not reachable."
            )
        web_available = self.web_client is not None
        return ZoteroIntegrationStatus(
            local=ZoteroEndpointStatus(
                available=local_available,
                read_only=True,
                message=local_message,
            ),
            web=ZoteroEndpointStatus(
                available=web_available,
                read_only=False,
                message=(
                    "Zotero Web API credentials are configured for version-safe writes."
                    if web_available
                    else "Zotero Web API key is not configured; exports are unavailable."
                ),
            ),
            import_available=local_available or web_available,
            export_available=web_available,
        )

    def build_candidates(self, request: TransferPreviewRequest) -> list[TransferCandidate]:
        if request.direction == "export":
            if self.web_client is None:
                raise ZoteroCapabilityUnavailableError(
                    "Zotero export requires a configured Web API key"
                )
            return self._build_export(request)
        endpoint = self._select_import_endpoint()
        return self._build_import(request, endpoint=endpoint)

    def inspect(
        self, preview: TransferPreview
    ) -> dict[str, tuple[TransferFingerprint, TransferFingerprint | None]]:
        request = TransferPreviewRequest(
            direction=preview.direction,
            library=preview.library,
            project_id=preview.project_id,
        )
        endpoint = _preview_endpoint(preview) if preview.direction == "import" else None
        candidates = (
            self._build_import(request, endpoint=endpoint)
            if endpoint is not None
            else self._build_export(request)
        )
        return {
            candidate.item_id: (
                candidate_fingerprint(candidate.source, candidate.source_attachments),
                (
                    candidate_fingerprint(candidate.target, candidate.target_attachments)
                    if candidate.target is not None
                    else None
                ),
            )
            for candidate in candidates
        }

    def apply(
        self,
        preview: TransferPreview,
        item: TransferPlanItem,
        resolutions: Sequence[ConflictResolution],
    ) -> TransferItemReceipt:
        source = _resolved_source(item.source, resolutions)
        if preview.direction == "export":
            return self._apply_export(preview, item, source)
        return self._apply_import(preview, item, source)

    def _build_export(self, request: TransferPreviewRequest) -> list[TransferCandidate]:
        if self.web_client is None:
            raise ZoteroCapabilityUnavailableError(
                "Zotero export requires a configured Web API key"
            )
        local_items = self.domain.list_project_items(request.project_id)
        remote_items = self._list_web_items(request.library)
        remote_drafts = [_remote_draft(item, "web") for item in remote_items]
        remote_by_key = {
            draft.external_key: draft for draft in remote_drafts if draft.external_key
        }
        remote_by_identity = _identity_index(remote_drafts)
        result: list[TransferCandidate] = []
        for local_item in local_items:
            binding = self.repository.get_binding_by_entity(
                request.library, "bibliographic_item", local_item.id
            )
            source = _local_draft(local_item, binding=binding)
            source_attachments = self._local_attachments(local_item.id)
            target: BibliographicDraft | None = None
            blocked_reason: str | None = None
            if binding is not None:
                target = remote_by_key.get(binding.external_key)
                if target is None:
                    blocked_reason = "The bound Zotero item no longer exists."
            else:
                matches = _identity_matches(source, remote_by_identity)
                if len(matches) == 1:
                    target = matches[0]
                elif len(matches) > 1:
                    blocked_reason = "Multiple Zotero items share this item's identifiers."
            target_attachments = (
                self._remote_attachments(request.library, target, endpoint="web")
                if target is not None
                else []
            )
            result.append(
                TransferCandidate(
                    item_id=local_item.id,
                    source=source,
                    target=target,
                    source_attachments=source_attachments,
                    target_attachments=target_attachments,
                    baseline=_baseline(binding, direction="export"),
                    blocked_reason=blocked_reason,
                )
            )
        return result

    def _build_import(
        self, request: TransferPreviewRequest, *, endpoint: str
    ) -> list[TransferCandidate]:
        remote_items = (
            self._list_local_items(request.library)
            if endpoint == "local"
            else self._list_web_items(request.library)
        )
        remote_drafts = [_remote_draft(item, endpoint) for item in remote_items]
        catalog_items = self.domain.list_catalog_items()
        catalog_by_id = {item.id: item for item in catalog_items}
        local_drafts = [_local_draft(item) for item in catalog_items]
        local_by_identity = _identity_index(local_drafts)
        result: list[TransferCandidate] = []
        for source in remote_drafts:
            if not source.external_key:
                continue
            binding = self.repository.get_binding_by_external(
                request.library, "bibliographic_item", source.external_key
            )
            local_item: BibliographicItemView | None = None
            blocked_reason: str | None = None
            if binding is not None:
                local_item = catalog_by_id.get(binding.entity_id)
                if local_item is None:
                    blocked_reason = "The bound local catalog item no longer exists."
            else:
                local_matches = _identity_matches(source, local_by_identity)
                if len(local_matches) == 1:
                    local_id = local_matches[0].external_key
                    local_item = catalog_by_id.get(local_id or "")
                elif len(local_matches) > 1:
                    blocked_reason = "Multiple local items share this Zotero item's identifiers."
            target = (
                _local_draft(local_item, binding=binding)
                if local_item is not None
                else None
            )
            target_attachments = (
                self._local_attachments(local_item.id) if local_item is not None else []
            )
            result.append(
                TransferCandidate(
                    item_id=local_item.id if local_item is not None else source.external_key,
                    source=source,
                    target=target,
                    source_attachments=self._remote_attachments(
                        request.library, source, endpoint=endpoint
                    ),
                    target_attachments=target_attachments,
                    baseline=_baseline(binding, direction="import"),
                    blocked_reason=blocked_reason,
                )
            )
        return result

    def _apply_export(
        self,
        preview: TransferPreview,
        item: TransferPlanItem,
        source: BibliographicDraft,
    ) -> TransferItemReceipt:
        if self.web_client is None:
            raise ZoteroCapabilityUnavailableError(
                "Zotero export requires a configured Web API key"
            )
        target = item.target
        if item.action == TransferAction.NEW:
            created = self.web_client.create_items(
                preview.library, [draft_to_zotero_data(source, for_create=True)]
            )
            success = created.get("success")
            external_key = success.get("0") if isinstance(success, dict) else None
            if not isinstance(external_key, str):
                raise ZoteroHttpError("Zotero did not return the created item key")
            outcome = "created"
        else:
            if target is None or target.external_key is None:
                raise ZoteroHttpError("Zotero update target is missing")
            external_key = target.external_key
            if any(difference.field != "attachments" for difference in item.differences):
                if target.external_version is None:
                    raise ZoteroHttpError("Zotero update target has no version")
                changes = draft_to_zotero_data(
                    _with_provider_envelope(source, target)
                )
                changes.pop("key", None)
                changes.pop("version", None)
                self.web_client.update_item(
                    preview.library,
                    external_key,
                    changes,
                    expected_version=target.external_version,
                )
            outcome = "unchanged" if item.action == TransferAction.UNCHANGED else "updated"
        self._export_attachments(preview.library, external_key, item)
        remote = _remote_draft(
            self.web_client.get_item(preview.library, external_key), "web"
        )
        local_item = self.domain.get_item(item.item_id)
        self._save_item_binding(
            preview,
            local_item,
            remote,
            endpoint="web",
        )
        return TransferItemReceipt(
            item_id=item.item_id,
            planned_action=item.action,
            outcome=outcome,
            external_key=external_key,
            external_version=remote.external_version,
        )

    def _apply_import(
        self,
        preview: TransferPreview,
        item: TransferPlanItem,
        source: BibliographicDraft,
    ) -> TransferItemReceipt:
        if source.external_key is None:
            raise ZoteroHttpError("Zotero source item has no key")
        endpoint = _draft_endpoint(source)
        metadata_changed = any(
            difference.field != "attachments" for difference in item.differences
        )
        with ExitStack() as stack:
            materialized = self._materialize_import_attachments(
                stack, preview.library, item, endpoint=endpoint
            )
            if item.target is None:
                local_item = self.domain.import_item(
                    preview.project_id,
                    source,
                    external_key=source.external_key,
                    raw_payload=source.raw,
                )
                outcome = "created"
            elif metadata_changed:
                local_id = item.target.external_key or item.item_id
                local_item = self.domain.replace_item(
                    preview.project_id,
                    local_id,
                    source,
                    external_key=source.external_key,
                    raw_payload=source.raw,
                )
                outcome = "updated"
            else:
                local_id = item.target.external_key or item.item_id
                local_item = self.domain.get_item(local_id)
                outcome = (
                    "unchanged" if item.action == TransferAction.UNCHANGED else "updated"
                )
            self._register_import_attachments(
                preview.library, local_item.id, materialized
            )
        remote = self._get_remote_item(preview.library, source.external_key, endpoint=endpoint)
        self._save_item_binding(preview, local_item, remote, endpoint=endpoint)
        return TransferItemReceipt(
            item_id=item.item_id,
            planned_action=item.action,
            outcome=outcome,
            external_key=source.external_key,
            external_version=remote.external_version,
        )

    def _export_attachments(
        self, library: ZoteroLibraryRef, parent_key: str, item: TransferPlanItem
    ) -> None:
        assert self.web_client is not None
        for plan in item.attachments:
            if plan.action == TransferAction.UNCHANGED:
                continue
            attachment_id = plan.source.local_attachment_id
            if attachment_id is None:
                raise ZoteroHttpError("Local PDF attachment identity is missing")
            attachment, path = self.domain.locate_attachment(attachment_id)
            uploaded = self.web_client.create_and_upload_attachment(
                library,
                parent_item=parent_key,
                file_path=path,
                content_type=attachment.media_type,
                title=attachment.filename,
            )
            self._save_attachment_binding(
                library,
                attachment,
                uploaded.item_key,
                uploaded.library_version,
                parent_item_id=item.item_id,
                remote_md5=uploaded.md5,
            )

    def _materialize_import_attachments(
        self,
        stack: ExitStack,
        library: ZoteroLibraryRef,
        item: TransferPlanItem,
        *,
        endpoint: str,
    ) -> list[tuple[TransferAttachmentSnapshot, Path, str]]:
        result: list[tuple[TransferAttachmentSnapshot, Path, str]] = []
        for plan in item.attachments:
            if plan.action == TransferAction.UNCHANGED:
                continue
            external_key = plan.source.external_key
            if external_key is None:
                raise ZoteroHttpError("Zotero PDF attachment key is missing")
            source_url = _zotero_select_url(library, external_key)
            if endpoint == "local":
                if self.local_client is None:
                    raise ZoteroCapabilityUnavailableError(
                        "The local Zotero source used by this preview is unavailable"
                    )
                path = self.local_client.attachment_file_path(
                    external_key, library=library
                )
                _verify_attachment(path, plan.source)
            else:
                if self.web_client is None:
                    raise ZoteroCapabilityUnavailableError(
                        "The Zotero Web API source used by this preview is unavailable"
                    )
                directory = stack.enter_context(
                    tempfile.TemporaryDirectory(prefix="zotero-import-")
                )
                path = Path(directory) / _safe_filename(plan.source.filename)
                self.web_client.download_attachment_file(library, external_key, path)
                _verify_attachment(path, plan.source)
            result.append((plan.source, path, source_url))
        return result

    def _register_import_attachments(
        self,
        library: ZoteroLibraryRef,
        local_item_id: str,
        materialized: list[tuple[TransferAttachmentSnapshot, Path, str]],
    ) -> None:
        for source, path, source_url in materialized:
            external_key = source.external_key
            if external_key is None:
                raise ZoteroHttpError("Zotero PDF attachment key is missing")
            attachment = self.domain.import_pdf(
                local_item_id,
                path,
                filename=source.filename,
                source_url=source_url,
            )
            self._save_attachment_binding(
                library,
                attachment,
                external_key,
                source.external_version,
                parent_item_id=local_item_id,
                remote_md5=(
                    source.checksum
                    if source.checksum_algorithm == "md5"
                    else None
                ),
            )

    def _save_item_binding(
        self,
        preview: TransferPreview,
        local_item: BibliographicItemView,
        remote: BibliographicDraft,
        *,
        endpoint: str,
    ) -> None:
        if remote.external_key is None:
            raise ZoteroHttpError("Zotero item has no key")
        existing = self.repository.get_binding_by_external(
            preview.library, "bibliographic_item", remote.external_key
        ) or self.repository.get_binding_by_entity(
            preview.library, "bibliographic_item", local_item.id
        )
        local_draft = _local_draft(local_item, provider=remote)
        local_attachments = self._local_attachments(local_item.id)
        remote_attachments = self._remote_attachments(
            preview.library, remote, endpoint=endpoint
        )
        now = datetime.now(UTC)
        self.repository.save_binding(
            ZoteroBinding(
                id=existing.id if existing else uuid4().hex,
                library=preview.library,
                entity_type="bibliographic_item",
                entity_id=local_item.id,
                external_key=remote.external_key,
                external_version=remote.external_version,
                local_hash=candidate_fingerprint(
                    local_draft, local_attachments
                ).content_hash,
                remote_hash=candidate_fingerprint(
                    remote, remote_attachments
                ).content_hash,
                project_id=preview.project_id,
                raw={
                    "endpoint": endpoint,
                    "remote_draft": remote.model_dump(mode="json"),
                },
                created_at=existing.created_at if existing else now,
                updated_at=now,
            )
        )

    def _save_attachment_binding(
        self,
        library: ZoteroLibraryRef,
        attachment: Attachment,
        external_key: str,
        external_version: int | None,
        *,
        parent_item_id: str,
        remote_md5: str | None,
    ) -> None:
        existing = self.repository.get_binding_by_external(
            library, "attachment", external_key
        ) or self.repository.get_binding_by_entity(
            library, "attachment", attachment.id
        )
        now = datetime.now(UTC)
        self.repository.save_binding(
            ZoteroBinding(
                id=existing.id if existing else uuid4().hex,
                library=library,
                entity_type="attachment",
                entity_id=attachment.id,
                external_key=external_key,
                external_version=external_version,
                local_hash=attachment.sha256,
                remote_hash=None,
                parent_item_id=parent_item_id,
                raw={"remote_md5": remote_md5},
                created_at=existing.created_at if existing else now,
                updated_at=now,
            )
        )

    def _select_import_endpoint(self) -> str:
        if self.local_client is not None and self.local_client.probe():
            return "local"
        if self.web_client is not None:
            return "web"
        raise ZoteroCapabilityUnavailableError(
            "Zotero import requires a running Desktop local API or configured Web API key"
        )

    def _list_local_items(self, library: ZoteroLibraryRef) -> list[dict[str, Any]]:
        if self.local_client is None:
            raise ZoteroCapabilityUnavailableError("Zotero local API is unavailable")
        return _paginate(
            lambda start, limit: self.local_client.list_items(
                start=start, limit=limit, top=True, library=library
            )
        )

    def _list_web_items(self, library: ZoteroLibraryRef) -> list[dict[str, Any]]:
        if self.web_client is None:
            raise ZoteroCapabilityUnavailableError("Zotero Web API is unavailable")
        return _paginate(
            lambda start, limit: self.web_client.list_items(
                library, start=start, limit=limit, top=True
            )
        )

    def _remote_attachments(
        self,
        library: ZoteroLibraryRef,
        draft: BibliographicDraft,
        *,
        endpoint: str,
    ) -> list[TransferAttachmentSnapshot]:
        if draft.external_key is None:
            return []
        if endpoint == "local":
            if self.local_client is None:
                raise ZoteroCapabilityUnavailableError("Zotero local API is unavailable")
            children = self.local_client.list_children(
                draft.external_key, library=library
            )
        else:
            if self.web_client is None:
                raise ZoteroCapabilityUnavailableError("Zotero Web API is unavailable")
            children = _paginate(
                lambda start, limit: self.web_client.list_children(
                    library, draft.external_key or "", start=start, limit=limit
                )
            )
        return [snapshot for child in children if (snapshot := _remote_attachment(child))]

    def _local_attachments(self, item_id: str) -> list[TransferAttachmentSnapshot]:
        snapshots = []
        for attachment in self.domain.list_attachments(item_id):
            if attachment.format != AttachmentFormat.PDF:
                continue
            _, path = self.domain.locate_attachment(attachment.id)
            snapshots.append(
                TransferAttachmentSnapshot(
                    ref=attachment.id,
                    filename=attachment.filename,
                    media_type=attachment.media_type,
                    size=attachment.size,
                    checksum=_file_md5(path),
                    checksum_algorithm="md5",
                    local_attachment_id=attachment.id,
                )
            )
        return snapshots

    def _get_remote_item(
        self, library: ZoteroLibraryRef, item_key: str, *, endpoint: str
    ) -> BibliographicDraft:
        if endpoint == "local":
            if self.local_client is None:
                raise ZoteroCapabilityUnavailableError("Zotero local API is unavailable")
            raw = self.local_client.get_item(item_key, library=library)
        else:
            if self.web_client is None:
                raise ZoteroCapabilityUnavailableError("Zotero Web API is unavailable")
            raw = self.web_client.get_item(library, item_key)
        return _remote_draft(raw, endpoint)


def _local_draft(
    item: BibliographicItemView,
    *,
    binding: ZoteroBinding | None = None,
    provider: BibliographicDraft | None = None,
) -> BibliographicDraft:
    provider_draft = provider or _binding_provider_draft(binding)
    local = catalog_item_to_draft(item).model_copy(
        update={"external_key": item.id, "external_version": None}
    )
    return _with_provider_envelope(local, provider_draft)


def _binding_provider_draft(binding: ZoteroBinding | None) -> BibliographicDraft | None:
    if binding is None:
        return None
    value = binding.raw.get("remote_draft")
    if not isinstance(value, dict):
        return None
    try:
        return BibliographicDraft.model_validate(value)
    except ValueError:
        return None


def _with_provider_envelope(
    local: BibliographicDraft,
    provider: BibliographicDraft | None,
) -> BibliographicDraft:
    if provider is None:
        return local
    provider_fields = provider.model_dump(
        mode="python",
        include={
            "container_title_field",
            "rights",
            "collections",
            "relations",
            "extra",
            "unknown_fields",
            "raw",
        },
    )
    return local.model_copy(update=provider_fields, deep=True)


def _remote_draft(item: dict[str, Any], endpoint: str) -> BibliographicDraft:
    draft = zotero_item_to_draft(item)
    return draft.model_copy(update={"raw": {**draft.raw, "_hxaxd_endpoint": endpoint}})


def _draft_endpoint(draft: BibliographicDraft) -> str:
    endpoint = draft.raw.get("_hxaxd_endpoint")
    return endpoint if endpoint in {"local", "web"} else "web"


def _preview_endpoint(preview: TransferPreview) -> str:
    if not preview.items:
        return "local"
    return _draft_endpoint(preview.items[0].source)


def _identity_index(drafts: list[BibliographicDraft]) -> dict[tuple[str, str], list]:
    result: dict[tuple[str, str], list[BibliographicDraft]] = {}
    for draft in drafts:
        for identifier in draft.identifiers:
            key = (identifier.scheme.casefold(), identifier.normalized_value.casefold())
            if key[0] in _IDENTITY_SCHEMES:
                result.setdefault(key, []).append(draft)
    return result


def _identity_matches(
    source: BibliographicDraft,
    index: dict[tuple[str, str], list[BibliographicDraft]],
) -> list[BibliographicDraft]:
    matches: dict[str, BibliographicDraft] = {}
    for identifier in source.identifiers:
        key = (identifier.scheme.casefold(), identifier.normalized_value.casefold())
        if key[0] not in _IDENTITY_SCHEMES:
            continue
        for candidate in index.get(key, []):
            identity = candidate.external_key or candidate.title
            matches[identity] = candidate
    return list(matches.values())


def _baseline(binding: ZoteroBinding | None, *, direction: str) -> SyncBaseline | None:
    if binding is None or binding.local_hash is None or binding.remote_hash is None:
        return None
    if direction == "export":
        return SyncBaseline(
            source_hash=binding.local_hash,
            target_hash=binding.remote_hash,
            target_version=binding.external_version,
        )
    return SyncBaseline(
        source_hash=binding.remote_hash,
        target_hash=binding.local_hash,
        source_version=binding.external_version,
    )


def _remote_attachment(item: dict[str, Any]) -> TransferAttachmentSnapshot | None:
    data = item.get("data", item)
    if not isinstance(data, dict) or data.get("itemType") != "attachment":
        return None
    filename = _text(data.get("filename")) or _text(data.get("title"))
    media_type = _text(data.get("contentType")) or "application/octet-stream"
    if not filename or (media_type != "application/pdf" and not _PDF.search(filename)):
        return None
    key = _text(item.get("key")) or _text(data.get("key"))
    if not key:
        return None
    md5 = _text(data.get("md5")).casefold()
    if not re.fullmatch(r"[0-9a-f]{32}", md5):
        md5 = ""
    size = data.get("filesize")
    return TransferAttachmentSnapshot(
        ref=key,
        filename=filename,
        media_type=media_type,
        size=size if isinstance(size, int) and size >= 0 else None,
        checksum=md5 or None,
        checksum_algorithm="md5" if md5 else None,
        external_key=key,
        external_version=_integer(item.get("version")) or _integer(data.get("version")),
    )


def _resolved_source(
    source: BibliographicDraft, resolutions: Sequence[ConflictResolution]
) -> BibliographicDraft:
    manual = next(
        (resolution for resolution in resolutions if resolution.choice == ConflictChoice.MANUAL),
        None,
    )
    if manual is None:
        return source
    return BibliographicDraft.model_validate(
        {**source.model_dump(mode="json"), **(manual.manual_changes or {})}
    )


def _paginate(fetch, *, page_size: int = 100, maximum: int = 5_000) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    while True:
        page = fetch(len(result), page_size)
        result.extend(page)
        if len(result) > maximum:
            raise ZoteroCapabilityUnavailableError(
                f"Zotero transfer scope exceeds the {maximum}-item safety limit"
            )
        if len(page) < page_size:
            return result


def _file_md5(path: Path) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_attachment(path: Path, expected: TransferAttachmentSnapshot) -> None:
    if expected.size is not None and path.stat().st_size != expected.size:
        raise ZoteroHttpError("Zotero PDF size changed after preview")
    if (
        expected.checksum_algorithm == "md5"
        and expected.checksum
        and _file_md5(path) != expected.checksum
    ):
        raise ZoteroHttpError("Zotero PDF checksum changed after preview")


def _zotero_select_url(library: ZoteroLibraryRef, item_key: str) -> str:
    if library.kind.value == "groups":
        return f"zotero://select/groups/{library.id}/items/{item_key}"
    return f"zotero://select/library/items/{item_key}"


def _safe_filename(filename: str) -> str:
    return re.sub(r"[^A-Za-z0-9._ -]", "_", Path(filename).name) or "attachment.pdf"


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _integer(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None

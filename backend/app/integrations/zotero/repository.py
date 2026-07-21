from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from threading import RLock
from typing import Protocol
from uuid import uuid4

from app.platform.db import DatabaseKind, V3Database, inspect_database

from .models import (
    ConflictResolution,
    TransferPreview,
    TransferReceipt,
    ZoteroBinding,
    ZoteroLibraryRef,
)


class ZoteroBindingConflictError(RuntimeError):
    pass


class ZoteroTransferRepository(Protocol):
    def save_preview(self, preview: TransferPreview) -> None: ...

    def get_preview(self, preview_id: str) -> TransferPreview | None: ...

    def save_resolution(self, preview_id: str, resolution: ConflictResolution) -> None: ...

    def list_resolutions(self, preview_id: str) -> list[ConflictResolution]: ...

    def claim_execution(self, preview_id: str, started_at: datetime) -> bool: ...

    def save_receipt(self, receipt: TransferReceipt) -> None: ...

    def get_receipt(self, preview_id: str) -> TransferReceipt | None: ...

    def get_binding_by_entity(
        self,
        library: ZoteroLibraryRef,
        entity_type: str,
        entity_id: str,
    ) -> ZoteroBinding | None: ...

    def get_binding_by_external(
        self,
        library: ZoteroLibraryRef,
        entity_type: str,
        external_key: str,
    ) -> ZoteroBinding | None: ...

    def list_attachment_bindings(
        self, library: ZoteroLibraryRef, parent_item_id: str
    ) -> list[ZoteroBinding]: ...

    def save_binding(self, binding: ZoteroBinding) -> None: ...


class InMemoryZoteroTransferRepository:
    """Thread-safe reference implementation with the same semantics as SQLite."""

    def __init__(self) -> None:
        self._previews: dict[str, TransferPreview] = {}
        self._resolutions: dict[str, dict[str, ConflictResolution]] = {}
        self._receipts: dict[str, TransferReceipt] = {}
        self._applying: set[str] = set()
        self._bindings: dict[str, ZoteroBinding] = {}
        self._lock = RLock()

    def save_preview(self, preview: TransferPreview) -> None:
        with self._lock:
            self._previews[preview.id] = preview.model_copy(deep=True)

    def get_preview(self, preview_id: str) -> TransferPreview | None:
        with self._lock:
            preview = self._previews.get(preview_id)
            return preview.model_copy(deep=True) if preview else None

    def save_resolution(self, preview_id: str, resolution: ConflictResolution) -> None:
        with self._lock:
            self._resolutions.setdefault(preview_id, {})[resolution.conflict_id] = (
                resolution.model_copy(deep=True)
            )

    def list_resolutions(self, preview_id: str) -> list[ConflictResolution]:
        with self._lock:
            return [
                resolution.model_copy(deep=True)
                for resolution in self._resolutions.get(preview_id, {}).values()
            ]

    def claim_execution(self, preview_id: str, started_at: datetime) -> bool:
        del started_at
        with self._lock:
            if preview_id in self._applying or preview_id in self._receipts:
                return False
            self._applying.add(preview_id)
            return True

    def save_receipt(self, receipt: TransferReceipt) -> None:
        with self._lock:
            existing = self._receipts.get(receipt.preview_id)
            if existing is not None and existing != receipt:
                raise ZoteroBindingConflictError("transfer already has a different receipt")
            self._receipts[receipt.preview_id] = receipt.model_copy(deep=True)
            self._applying.discard(receipt.preview_id)

    def get_receipt(self, preview_id: str) -> TransferReceipt | None:
        with self._lock:
            receipt = self._receipts.get(preview_id)
            return receipt.model_copy(deep=True) if receipt else None

    def get_binding_by_entity(
        self,
        library: ZoteroLibraryRef,
        entity_type: str,
        entity_id: str,
    ) -> ZoteroBinding | None:
        with self._lock:
            return self._copy_binding(
                next(
                    (
                        binding
                        for binding in self._bindings.values()
                        if binding.library == library
                        and binding.entity_type == entity_type
                        and binding.entity_id == entity_id
                    ),
                    None,
                )
            )

    def get_binding_by_external(
        self,
        library: ZoteroLibraryRef,
        entity_type: str,
        external_key: str,
    ) -> ZoteroBinding | None:
        with self._lock:
            return self._copy_binding(
                next(
                    (
                        binding
                        for binding in self._bindings.values()
                        if binding.library == library
                        and binding.entity_type == entity_type
                        and binding.external_key == external_key
                    ),
                    None,
                )
            )

    def list_attachment_bindings(
        self, library: ZoteroLibraryRef, parent_item_id: str
    ) -> list[ZoteroBinding]:
        with self._lock:
            return [
                binding.model_copy(deep=True)
                for binding in self._bindings.values()
                if binding.library == library
                and binding.entity_type == "attachment"
                and binding.parent_item_id == parent_item_id
            ]

    def save_binding(self, binding: ZoteroBinding) -> None:
        with self._lock:
            entity = self.get_binding_by_entity(
                binding.library, binding.entity_type, binding.entity_id
            )
            external = self.get_binding_by_external(
                binding.library, binding.entity_type, binding.external_key
            )
            if entity is not None and entity.id != binding.id:
                self._bindings.pop(entity.id, None)
            if (
                external is not None
                and external.id != binding.id
                and external.entity_id != binding.entity_id
            ):
                raise ZoteroBindingConflictError(
                    "Zotero key is already bound to a different local entity"
                )
            self._bindings[binding.id] = binding.model_copy(deep=True)

    @staticmethod
    def _copy_binding(binding: ZoteroBinding | None) -> ZoteroBinding | None:
        return binding.model_copy(deep=True) if binding is not None else None


class SqliteZoteroTransferRepository:
    """Durable Zotero transfer state backed by the single v3 baseline."""

    def __init__(
        self,
        database: V3Database,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.database = database
        self._clock = clock or (lambda: datetime.now(UTC))
        self._schema_lock = RLock()
        self._initialized = False
        if inspect_database(database.path).kind is DatabaseKind.V4:
            self.initialize()

    def initialize(self) -> None:
        with self._schema_lock:
            if self._initialized:
                return
            if inspect_database(self.database.path).kind is not DatabaseKind.V4:
                raise RuntimeError("v3 database must be initialized before Zotero state")
            self._validate_schema()
            self._initialized = True

    def _validate_schema(self) -> None:
        required = {
            "zotero_transfer_previews",
            "zotero_transfer_resolutions",
            "zotero_transfer_receipts",
        }
        with self.database.read() as connection:
            present = {
                str(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
        missing = required - present
        if missing:
            names = ", ".join(sorted(missing))
            raise RuntimeError(f"v3 baseline is missing Zotero tables: {names}")

    def save_preview(self, preview: TransferPreview) -> None:
        self.initialize()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO zotero_transfer_previews(
                    id, preview_hash, state, preview_json, created_at, expires_at
                ) VALUES(?, ?, 'preview_ready', ?, ?, ?)
                """,
                (
                    preview.id,
                    preview.preview_hash,
                    _json(preview),
                    _timestamp(preview.created_at),
                    _timestamp(preview.expires_at),
                ),
            )

    def get_preview(self, preview_id: str) -> TransferPreview | None:
        self.initialize()
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT preview_json FROM zotero_transfer_previews WHERE id = ?",
                (preview_id,),
            ).fetchone()
        return TransferPreview.model_validate_json(row[0]) if row is not None else None

    def save_resolution(self, preview_id: str, resolution: ConflictResolution) -> None:
        self.initialize()
        resolved_at = resolution.resolved_at or self._clock()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO zotero_transfer_resolutions(
                    preview_id, conflict_id, resolution_json, resolved_at
                ) VALUES(?, ?, ?, ?)
                ON CONFLICT(preview_id, conflict_id) DO UPDATE SET
                    resolution_json = excluded.resolution_json,
                    resolved_at = excluded.resolved_at
                """,
                (
                    preview_id,
                    resolution.conflict_id,
                    _json(resolution),
                    _timestamp(resolved_at),
                ),
            )

    def list_resolutions(self, preview_id: str) -> list[ConflictResolution]:
        self.initialize()
        with self.database.read() as connection:
            rows = connection.execute(
                """
                SELECT resolution_json FROM zotero_transfer_resolutions
                WHERE preview_id = ? ORDER BY conflict_id
                """,
                (preview_id,),
            ).fetchall()
        return [ConflictResolution.model_validate_json(row[0]) for row in rows]

    def claim_execution(self, preview_id: str, started_at: datetime) -> bool:
        self.initialize()
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE zotero_transfer_previews
                SET state = 'applying', execution_started_at = ?
                WHERE id = ? AND state = 'preview_ready'
                """,
                (_timestamp(started_at), preview_id),
            )
        return cursor.rowcount == 1

    def save_receipt(self, receipt: TransferReceipt) -> None:
        self.initialize()
        with self.database.transaction() as connection:
            existing = connection.execute(
                "SELECT receipt_json FROM zotero_transfer_receipts WHERE preview_id = ?",
                (receipt.preview_id,),
            ).fetchone()
            if existing is not None:
                if TransferReceipt.model_validate_json(existing[0]) != receipt:
                    raise ZoteroBindingConflictError(
                        "transfer already has a different receipt"
                    )
                return
            connection.execute(
                """
                INSERT INTO zotero_transfer_receipts(
                    preview_id, id, preview_hash, receipt_json, finished_at
                ) VALUES(?, ?, ?, ?, ?)
                """,
                (
                    receipt.preview_id,
                    receipt.id,
                    receipt.preview_hash,
                    _json(receipt),
                    _timestamp(receipt.finished_at),
                ),
            )
            connection.execute(
                "UPDATE zotero_transfer_previews SET state = 'finished' WHERE id = ?",
                (receipt.preview_id,),
            )

    def get_receipt(self, preview_id: str) -> TransferReceipt | None:
        self.initialize()
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT receipt_json FROM zotero_transfer_receipts WHERE preview_id = ?",
                (preview_id,),
            ).fetchone()
        return TransferReceipt.model_validate_json(row[0]) if row is not None else None

    def get_binding_by_entity(
        self,
        library: ZoteroLibraryRef,
        entity_type: str,
        entity_id: str,
    ) -> ZoteroBinding | None:
        self.initialize()
        with self.database.read() as connection:
            row = connection.execute(
                """
                SELECT * FROM external_bindings
                WHERE provider = 'zotero' AND library_id = ?
                  AND entity_type = ? AND entity_id = ?
                """,
                (_library_id(library), entity_type, entity_id),
            ).fetchone()
        return _binding(row, library) if row is not None else None

    def get_binding_by_external(
        self,
        library: ZoteroLibraryRef,
        entity_type: str,
        external_key: str,
    ) -> ZoteroBinding | None:
        self.initialize()
        with self.database.read() as connection:
            row = connection.execute(
                """
                SELECT * FROM external_bindings
                WHERE provider = 'zotero' AND library_id = ?
                  AND entity_type = ? AND external_key = ?
                """,
                (_library_id(library), entity_type, external_key),
            ).fetchone()
        return _binding(row, library) if row is not None else None

    def list_attachment_bindings(
        self, library: ZoteroLibraryRef, parent_item_id: str
    ) -> list[ZoteroBinding]:
        self.initialize()
        with self.database.read() as connection:
            rows = connection.execute(
                """
                SELECT * FROM external_bindings
                WHERE provider = 'zotero' AND library_id = ? AND entity_type = 'attachment'
                ORDER BY entity_id
                """,
                (_library_id(library),),
            ).fetchall()
        bindings = [_binding(row, library) for row in rows]
        return [binding for binding in bindings if binding.parent_item_id == parent_item_id]

    def save_binding(self, binding: ZoteroBinding) -> None:
        self.initialize()
        now = _timestamp(self._clock())
        raw = {
            **binding.raw,
            "library_kind": binding.library.kind.value,
            "project_id": binding.project_id,
            "parent_item_id": binding.parent_item_id,
            "local_hash": binding.local_hash,
            "remote_hash": binding.remote_hash,
        }
        with self.database.transaction() as connection:
            external = connection.execute(
                """
                SELECT id, entity_id FROM external_bindings
                WHERE provider = 'zotero' AND library_id = ? AND external_key = ?
                """,
                (_library_id(binding.library), binding.external_key),
            ).fetchone()
            if (
                external is not None
                and external["id"] != binding.id
                and external["entity_id"] != binding.entity_id
            ):
                raise ZoteroBindingConflictError(
                    "Zotero key is already bound to a different local entity"
                )
            if external is not None and external["id"] == binding.id:
                connection.execute(
                    """
                    UPDATE external_bindings SET
                        entity_type = ?, entity_id = ?, external_key = ?,
                        external_version = ?, sync_hash = ?, raw_json = ?,
                        last_synced_at = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        binding.entity_type,
                        binding.entity_id,
                        binding.external_key,
                        binding.external_version,
                        binding.local_hash,
                        json.dumps(
                            raw,
                            ensure_ascii=False,
                            sort_keys=True,
                            separators=(",", ":"),
                        ),
                        now,
                        now,
                        binding.id,
                    ),
                )
                return
            connection.execute(
                """
                INSERT INTO external_bindings(
                    id, provider, library_id, entity_type, entity_id, external_key,
                    external_version, sync_hash, raw_json, last_synced_at,
                    created_at, updated_at
                ) VALUES(?, 'zotero', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(provider, library_id, entity_type, entity_id) DO UPDATE SET
                    external_key = excluded.external_key,
                    external_version = excluded.external_version,
                    sync_hash = excluded.sync_hash,
                    raw_json = excluded.raw_json,
                    last_synced_at = excluded.last_synced_at,
                    updated_at = excluded.updated_at
                """,
                (
                    binding.id or uuid4().hex,
                    _library_id(binding.library),
                    binding.entity_type,
                    binding.entity_id,
                    binding.external_key,
                    binding.external_version,
                    binding.local_hash,
                    json.dumps(raw, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                    now,
                    _timestamp(binding.created_at),
                    now,
                ),
            )


def _library_id(library: ZoteroLibraryRef) -> str:
    return f"{library.kind.value}:{library.id}"


def _binding(row: sqlite3.Row, library: ZoteroLibraryRef) -> ZoteroBinding:
    raw = json.loads(row["raw_json"])
    return ZoteroBinding(
        id=row["id"],
        library=library,
        entity_type=row["entity_type"],
        entity_id=row["entity_id"],
        external_key=row["external_key"],
        external_version=row["external_version"],
        local_hash=raw.get("local_hash") or row["sync_hash"],
        remote_hash=raw.get("remote_hash"),
        project_id=raw.get("project_id"),
        parent_item_id=raw.get("parent_item_id"),
        raw=raw,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _json(model) -> str:
    return model.model_dump_json()


def _timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")

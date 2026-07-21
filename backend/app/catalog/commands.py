from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from datetime import UTC, datetime

from app.platform.db import V3Database

from .domain import CatalogConflictError, CatalogNotFoundError, normalize_identifier
from .models import (
    BibliographicItemDraft,
    BibliographicItemPatch,
    BibliographicItemView,
    WorkView,
)
from .queries import CatalogQueries


def _id() -> str:
    return uuid.uuid4().hex


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class CatalogCommands:
    def __init__(self, database: V3Database):
        self.database = database
        self.queries = CatalogQueries(database)

    def create_work(
        self,
        draft: BibliographicItemDraft,
        *,
        source_record_id: str | None = None,
        actor_type: str = "user",
        actor_id: str | None = None,
        correlation_id: str | None = None,
    ) -> WorkView:
        with self.database.transaction() as connection:
            work_id, _ = self.create_work_in(
                connection,
                draft,
                source_record_id=source_record_id,
                actor_type=actor_type,
                actor_id=actor_id,
                correlation_id=correlation_id,
            )
        return self.queries.get_work(work_id)

    def create_work_in(
        self,
        connection: sqlite3.Connection,
        draft: BibliographicItemDraft,
        *,
        source_record_id: str | None = None,
        actor_type: str = "system",
        actor_id: str | None = None,
        correlation_id: str | None = None,
    ) -> tuple[str, str]:
        now = _now()
        work_id = _id()
        item_id = _id()
        normalized_identifiers = [
            normalize_identifier(identifier.scheme, identifier.value)
            for identifier in draft.identifiers
        ]
        all_identifier_keys = [
            (identifier.scheme, identifier.normalized_value)
            for identifier in normalized_identifiers
        ]
        if len(all_identifier_keys) != len(set(all_identifier_keys)):
            raise CatalogConflictError("candidate contains duplicate identifiers")
        identity_keys = {
            (identifier.scheme, identifier.normalized_value)
            for identifier in normalized_identifiers
            if identifier.is_identity
        }
        explicit_primaries = [
            index for index, identifier in enumerate(draft.identifiers) if identifier.is_primary
        ]
        if len(explicit_primaries) > 1:
            raise CatalogConflictError("candidate contains multiple primary identifiers")
        primary_index = explicit_primaries[0] if explicit_primaries else 0
        for scheme, normalized_value in identity_keys:
            existing = connection.execute(
                """
                SELECT item_id FROM item_identifiers
                WHERE scheme = ? AND normalized_value = ? AND is_identity = 1
                """,
                (scheme, normalized_value),
            ).fetchone()
            if existing is not None:
                raise CatalogConflictError(
                    f"identifier {scheme}:{normalized_value} already belongs to an item"
                )
        connection.execute(
            "INSERT INTO works(id, created_at, updated_at) VALUES(?, ?, ?)",
            (work_id, now, now),
        )
        item_values = draft.model_dump(
            exclude={"creators", "identifiers", "links", "tags"}, mode="json"
        )
        connection.execute(
            """
            INSERT INTO bibliographic_items(
                id, work_id, item_type, title, short_title, translated_title,
                abstract, language, issued_year, issued_month, issued_day,
                issued_literal, container_title, publisher, place, volume, issue,
                pages, edition, series, publication_state, creator_list_complete,
                is_preferred_for_work, created_at, updated_at
            ) VALUES(
                :id, :work_id, :item_type, :title, :short_title, :translated_title,
                :abstract, :language, :issued_year, :issued_month, :issued_day,
                :issued_literal, :container_title, :publisher, :place, :volume, :issue,
                :pages, :edition, :series, :publication_state, :creator_list_complete,
                1, :created_at, :updated_at
            )
            """,
            {
                **item_values,
                "id": item_id,
                "work_id": work_id,
                "creator_list_complete": int(draft.creator_list_complete),
                "created_at": now,
                "updated_at": now,
            },
        )
        for position, creator in enumerate(draft.creators):
            connection.execute(
                """
                INSERT INTO item_creators(
                    id, item_id, position, role, creator_type, given_name,
                    family_name, literal_name, suffix, orcid, raw_name, source_record_id
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _id(),
                    item_id,
                    position,
                    creator.role,
                    creator.creator_type,
                    creator.given_name,
                    creator.family_name,
                    creator.literal_name,
                    creator.suffix,
                    creator.orcid,
                    creator.raw_name,
                    source_record_id,
                ),
            )
        for position, normalized in enumerate(normalized_identifiers):
            connection.execute(
                """
                INSERT INTO item_identifiers(
                    id, item_id, scheme, value, normalized_value, version,
                    is_primary, is_identity, source_record_id
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _id(),
                    item_id,
                    normalized.scheme,
                    normalized.value,
                    normalized.normalized_value,
                    normalized.version,
                    int(position == primary_index),
                    int(normalized.is_identity),
                    source_record_id,
                ),
            )
        seen_links: set[tuple[str, str]] = set()
        for link in draft.links:
            key = (link.relation_type, link.url)
            if key in seen_links:
                continue
            seen_links.add(key)
            connection.execute(
                """
                INSERT INTO item_links(
                    id, item_id, relation_type, url, title, source_record_id
                ) VALUES(?, ?, ?, ?, ?, ?)
                """,
                (_id(), item_id, link.relation_type, link.url, link.title, source_record_id),
            )
        for tag in {(tag.name, tag.kind) for tag in draft.tags}:
            connection.execute(
                """
                INSERT INTO item_tags(item_id, tag, kind, source_record_id)
                VALUES(?, ?, ?, ?)
                """,
                (item_id, tag[0], tag[1], source_record_id),
            )
        if source_record_id is not None:
            for field_path, value in item_values.items():
                if value is None:
                    continue
                serialized = json.dumps(value, ensure_ascii=False, sort_keys=True)
                connection.execute(
                    """
                    INSERT INTO item_field_sources(
                        item_id, field_path, source_record_id, value_sha256, selected_at
                    ) VALUES(?, ?, ?, ?, ?)
                    """,
                    (
                        item_id,
                        field_path,
                        source_record_id,
                        hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
                        now,
                    ),
                )
        self._record_item_revision(
            connection,
            item_id=item_id,
            revision=1,
            actor_type=actor_type,
            actor_id=actor_id,
            changes={"snapshot": draft.model_dump(mode="json")},
            created_at=now,
        )
        connection.execute(
            """
            INSERT INTO audit_events(
                id, occurred_at, actor_type, actor_id, action,
                entity_type, entity_id, correlation_id, after_json
            ) VALUES(?, ?, ?, ?, 'catalog.work_created', 'work', ?, ?, ?)
            """,
            (
                _id(),
                now,
                actor_type,
                actor_id,
                work_id,
                correlation_id,
                json.dumps({"item_id": item_id, "title": draft.title}, ensure_ascii=False),
            ),
        )
        return work_id, item_id

    def apply_metadata_patch(
        self,
        item_id: str,
        base_revision: int,
        patch: BibliographicItemPatch,
        *,
        actor_type: str = "user",
        actor_id: str | None = None,
        correlation_id: str | None = None,
        change_set_id: str | None = None,
        revision_id: str | None = None,
        evidence: list[dict] | None = None,
    ) -> BibliographicItemView:
        now = _now()
        changes = patch.model_dump(exclude_unset=True, mode="json")
        with self.database.transaction() as connection:
            if revision_id is not None:
                applied = connection.execute(
                    "SELECT item_id FROM item_revisions WHERE id = ?",
                    (revision_id,),
                ).fetchone()
                if applied is not None:
                    if applied["item_id"] != item_id:
                        raise CatalogConflictError("revision id belongs to another item")
                    existing = connection.execute(
                        "SELECT * FROM bibliographic_items WHERE id = ?", (item_id,)
                    ).fetchone()
                    return CatalogQueries._hydrate_items(connection, [existing])[0]
            current = connection.execute(
                "SELECT * FROM bibliographic_items WHERE id = ?", (item_id,)
            ).fetchone()
            if current is None:
                raise CatalogNotFoundError("bibliographic item does not exist")
            if int(current["revision"]) != base_revision:
                raise CatalogConflictError(
                    f"metadata revision is stale: expected {base_revision}, "
                    f"found {current['revision']}"
                )

            structured = {"creators", "identifiers", "links", "tags"}
            scalar_changes = {key: value for key, value in changes.items() if key not in structured}
            if scalar_changes:
                assignments = ", ".join(f"{field} = ?" for field in scalar_changes)
                connection.execute(
                    f"UPDATE bibliographic_items SET {assignments} WHERE id = ?",  # noqa: S608
                    (*scalar_changes.values(), item_id),
                )
            if "creators" in changes:
                connection.execute("DELETE FROM item_creators WHERE item_id = ?", (item_id,))
                for position, creator in enumerate(patch.creators):
                    connection.execute(
                        """
                        INSERT INTO item_creators(
                            id, item_id, position, role, creator_type, given_name,
                            family_name, literal_name, suffix, orcid, raw_name
                        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            _id(), item_id, position, creator.role, creator.creator_type,
                            creator.given_name, creator.family_name, creator.literal_name,
                            creator.suffix, creator.orcid, creator.raw_name,
                        ),
                    )
            if "identifiers" in changes:
                normalized = [
                    normalize_identifier(identifier.scheme, identifier.value)
                    for identifier in patch.identifiers
                ]
                keys = [(item.scheme, item.normalized_value) for item in normalized]
                if len(keys) != len(set(keys)):
                    raise CatalogConflictError("metadata patch contains duplicate identifiers")
                explicit_primary = [
                    index
                    for index, identifier in enumerate(patch.identifiers)
                    if identifier.is_primary
                ]
                if len(explicit_primary) > 1:
                    raise CatalogConflictError(
                        "metadata patch contains multiple primary identifiers"
                    )
                for identifier in normalized:
                    if not identifier.is_identity:
                        continue
                    existing = connection.execute(
                        """
                        SELECT item_id FROM item_identifiers
                        WHERE scheme = ? AND normalized_value = ?
                          AND is_identity = 1 AND item_id <> ?
                        """,
                        (identifier.scheme, identifier.normalized_value, item_id),
                    ).fetchone()
                    if existing is not None:
                        raise CatalogConflictError(
                            f"identifier {identifier.scheme}:{identifier.normalized_value} "
                            "already belongs to another item"
                        )
                connection.execute("DELETE FROM item_identifiers WHERE item_id = ?", (item_id,))
                primary_index = explicit_primary[0] if explicit_primary else 0
                for position, identifier in enumerate(normalized):
                    connection.execute(
                        """
                        INSERT INTO item_identifiers(
                            id, item_id, scheme, value, normalized_value, version,
                            is_primary, is_identity
                        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            _id(), item_id, identifier.scheme, identifier.value,
                            identifier.normalized_value, identifier.version,
                            int(position == primary_index), int(identifier.is_identity),
                        ),
                    )
            if "links" in changes:
                connection.execute("DELETE FROM item_links WHERE item_id = ?", (item_id,))
                seen_links: set[tuple[str, str]] = set()
                for link in patch.links:
                    key = (link.relation_type, link.url)
                    if key in seen_links:
                        continue
                    seen_links.add(key)
                    connection.execute(
                        """
                        INSERT INTO item_links(id, item_id, relation_type, url, title)
                        VALUES(?, ?, ?, ?, ?)
                        """,
                        (_id(), item_id, link.relation_type, link.url, link.title),
                    )
            if "tags" in changes:
                connection.execute("DELETE FROM item_tags WHERE item_id = ?", (item_id,))
                for name, kind in {(tag.name, tag.kind) for tag in patch.tags}:
                    connection.execute(
                        "INSERT INTO item_tags(item_id, tag, kind) VALUES(?, ?, ?)",
                        (item_id, name, kind),
                    )

            next_revision = base_revision + 1
            connection.execute(
                """
                UPDATE bibliographic_items
                SET revision = ?, updated_at = ? WHERE id = ?
                """,
                (next_revision, now, item_id),
            )
            connection.execute(
                "UPDATE works SET updated_at = ? WHERE id = ?", (now, current["work_id"])
            )
            self._record_item_revision(
                connection,
                item_id=item_id,
                revision=next_revision,
                actor_type=actor_type,
                actor_id=actor_id,
                changes=changes,
                evidence=evidence,
                change_set_id=change_set_id,
                revision_id=revision_id,
                created_at=now,
            )
            connection.execute(
                """
                INSERT INTO audit_events(
                    id, occurred_at, actor_type, actor_id, action,
                    entity_type, entity_id, correlation_id, before_json, after_json
                ) VALUES(
                    ?, ?, ?, ?, 'catalog.metadata_patched',
                    'bibliographic_item', ?, ?, ?, ?
                )
                """,
                (
                    _id(), now, actor_type, actor_id, item_id, correlation_id,
                    json.dumps(
                        {key: current[key] for key in scalar_changes},
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                    json.dumps(changes, ensure_ascii=False, sort_keys=True),
                ),
            )
        return self.queries.get_item(item_id)

    def append_item_version(
        self,
        work_id: str,
        draft: BibliographicItemDraft,
        *,
        source_record_id: str | None = None,
        actor_type: str = "system",
        actor_id: str | None = None,
        correlation_id: str | None = None,
    ) -> WorkView:
        """Append an immutable bibliographic version and make it preferred atomically."""

        now = _now()
        item_id = _id()
        normalized_identifiers = [
            normalize_identifier(identifier.scheme, identifier.value)
            for identifier in draft.identifiers
        ]
        keys = [
            (identifier.scheme, identifier.normalized_value)
            for identifier in normalized_identifiers
        ]
        if len(keys) != len(set(keys)):
            raise CatalogConflictError("candidate contains duplicate identifiers")
        explicit_primaries = [
            index for index, identifier in enumerate(draft.identifiers) if identifier.is_primary
        ]
        if len(explicit_primaries) > 1:
            raise CatalogConflictError("candidate contains multiple primary identifiers")
        primary_index = explicit_primaries[0] if explicit_primaries else 0
        item_values = draft.model_dump(
            exclude={"creators", "identifiers", "links", "tags"}, mode="json"
        )

        with self.database.transaction() as connection:
            work = connection.execute(
                "SELECT id FROM works WHERE id = ?", (work_id,)
            ).fetchone()
            if work is None:
                raise CatalogNotFoundError("work does not exist")
            previous = connection.execute(
                """
                SELECT id FROM bibliographic_items
                WHERE work_id = ? AND is_preferred_for_work = 1
                """,
                (work_id,),
            ).fetchone()
            reusable_identifiers: dict[tuple[str, str], str] = {}
            for normalized in normalized_identifiers:
                if not normalized.is_identity:
                    continue
                existing = connection.execute(
                    """
                    SELECT identifier.id, item.work_id
                    FROM item_identifiers identifier
                    JOIN bibliographic_items item ON item.id = identifier.item_id
                    WHERE identifier.scheme = ? AND identifier.normalized_value = ?
                      AND identifier.is_identity = 1
                    """,
                    (normalized.scheme, normalized.normalized_value),
                ).fetchone()
                if existing is None:
                    continue
                if existing["work_id"] != work_id:
                    raise CatalogConflictError(
                        f"identifier {normalized.scheme}:{normalized.normalized_value} "
                        "already belongs to another work"
                    )
                reusable_identifiers[
                    (normalized.scheme, normalized.normalized_value)
                ] = str(existing["id"])

            connection.execute(
                "UPDATE bibliographic_items SET is_preferred_for_work = 0 WHERE work_id = ?",
                (work_id,),
            )
            connection.execute(
                """
                INSERT INTO bibliographic_items(
                    id, work_id, item_type, title, short_title, translated_title,
                    abstract, language, issued_year, issued_month, issued_day,
                    issued_literal, container_title, publisher, place, volume, issue,
                    pages, edition, series, publication_state, creator_list_complete,
                    is_preferred_for_work, created_at, updated_at
                ) VALUES(
                    :id, :work_id, :item_type, :title, :short_title, :translated_title,
                    :abstract, :language, :issued_year, :issued_month, :issued_day,
                    :issued_literal, :container_title, :publisher, :place, :volume, :issue,
                    :pages, :edition, :series, :publication_state, :creator_list_complete,
                    1, :created_at, :updated_at
                )
                """,
                {
                    **item_values,
                    "id": item_id,
                    "work_id": work_id,
                    "creator_list_complete": int(draft.creator_list_complete),
                    "created_at": now,
                    "updated_at": now,
                },
            )
            for position, creator in enumerate(draft.creators):
                connection.execute(
                    """
                    INSERT INTO item_creators(
                        id, item_id, position, role, creator_type, given_name,
                        family_name, literal_name, suffix, orcid, raw_name, source_record_id
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        _id(),
                        item_id,
                        position,
                        creator.role,
                        creator.creator_type,
                        creator.given_name,
                        creator.family_name,
                        creator.literal_name,
                        creator.suffix,
                        creator.orcid,
                        creator.raw_name,
                        source_record_id,
                    ),
                )
            for position, normalized in enumerate(normalized_identifiers):
                key = (normalized.scheme, normalized.normalized_value)
                reusable_id = reusable_identifiers.get(key)
                if reusable_id is not None:
                    connection.execute(
                        """
                        UPDATE item_identifiers SET
                            item_id = ?, value = ?, version = ?, is_primary = ?,
                            source_record_id = ? WHERE id = ?
                        """,
                        (
                            item_id,
                            normalized.value,
                            normalized.version,
                            int(position == primary_index),
                            source_record_id,
                            reusable_id,
                        ),
                    )
                    continue
                connection.execute(
                    """
                    INSERT INTO item_identifiers(
                        id, item_id, scheme, value, normalized_value, version,
                        is_primary, is_identity, source_record_id
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        _id(),
                        item_id,
                        normalized.scheme,
                        normalized.value,
                        normalized.normalized_value,
                        normalized.version,
                        int(position == primary_index),
                        int(normalized.is_identity),
                        source_record_id,
                    ),
                )
            seen_links: set[tuple[str, str]] = set()
            for link in draft.links:
                key = (link.relation_type, link.url)
                if key in seen_links:
                    continue
                seen_links.add(key)
                connection.execute(
                    """
                    INSERT INTO item_links(
                        id, item_id, relation_type, url, title, source_record_id
                    ) VALUES(?, ?, ?, ?, ?, ?)
                    """,
                    (
                        _id(),
                        item_id,
                        link.relation_type,
                        link.url,
                        link.title,
                        source_record_id,
                    ),
                )
            for tag in {(tag.name, tag.kind) for tag in draft.tags}:
                connection.execute(
                    """
                    INSERT INTO item_tags(item_id, tag, kind, source_record_id)
                    VALUES(?, ?, ?, ?)
                    """,
                    (item_id, tag[0], tag[1], source_record_id),
                )
            if source_record_id is not None:
                for field_path, value in item_values.items():
                    if value is None:
                        continue
                    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True)
                    connection.execute(
                        """
                        INSERT INTO item_field_sources(
                            item_id, field_path, source_record_id, value_sha256, selected_at
                        ) VALUES(?, ?, ?, ?, ?)
                        """,
                        (
                            item_id,
                            field_path,
                            source_record_id,
                            hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
                            now,
                        ),
                    )
            self._record_item_revision(
                connection,
                item_id=item_id,
                revision=1,
                actor_type=actor_type,
                actor_id=actor_id,
                changes={"snapshot": draft.model_dump(mode="json")},
                created_at=now,
            )
            connection.execute("UPDATE works SET updated_at = ? WHERE id = ?", (now, work_id))
            connection.execute(
                """
                INSERT INTO audit_events(
                    id, occurred_at, actor_type, actor_id, action,
                    entity_type, entity_id, correlation_id, before_json, after_json
                ) VALUES(
                    ?, ?, ?, ?, 'catalog.item_version_appended',
                    'bibliographic_item', ?, ?, ?, ?
                )
                """,
                (
                    _id(),
                    now,
                    actor_type,
                    actor_id,
                    item_id,
                    correlation_id,
                    json.dumps(
                        {"preferred_item_id": previous["id"] if previous else None},
                        ensure_ascii=False,
                    ),
                    json.dumps(
                        {"preferred_item_id": item_id, "title": draft.title},
                        ensure_ascii=False,
                    ),
                ),
            )
        return self.queries.get_work(work_id)

    @staticmethod
    def _record_item_revision(
        connection: sqlite3.Connection,
        *,
        item_id: str,
        revision: int,
        actor_type: str,
        actor_id: str | None,
        changes: dict,
        created_at: str,
        evidence: list[dict] | None = None,
        change_set_id: str | None = None,
        revision_id: str | None = None,
    ) -> None:
        connection.execute(
            """
            INSERT INTO item_revisions(
                id, item_id, revision, actor_type, actor_id, change_set_id,
                changes_json, evidence_json, created_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                revision_id or _id(),
                item_id,
                revision,
                actor_type,
                actor_id,
                change_set_id,
                json.dumps(changes, ensure_ascii=False, sort_keys=True),
                json.dumps(evidence or [], ensure_ascii=False, sort_keys=True),
                created_at,
            ),
        )

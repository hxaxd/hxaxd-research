from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from datetime import UTC, datetime

from app.catalog.commands import CatalogCommands
from app.catalog.domain import CatalogConflictError, normalize_identifier
from app.catalog.models import BibliographicItemDraft
from app.platform.db import WorkspaceDatabase

from .domain import ScreeningConflictError, ScreeningNotFoundError
from .models import (
    CandidateCreate,
    CandidateDecision,
    CandidateDecisionResult,
    CandidatePromotionRequest,
    CandidateView,
    ProjectCreate,
    ProjectDeleteRequest,
    ProjectDeleteResult,
    ProjectInsightsPatch,
    ProjectView,
    ProjectWorkDecision,
    ProjectWorkView,
)
from .queries import ScreeningQueries


def _id() -> str:
    return uuid.uuid4().hex


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class ScreeningCommands:
    def __init__(self, database: WorkspaceDatabase):
        self.database = database
        self.queries = ScreeningQueries(database)
        self.catalog = CatalogCommands(database)

    def create_project(self, payload: ProjectCreate) -> ProjectView:
        now = _now()
        project_id = _id()
        try:
            with self.database.transaction() as connection:
                connection.execute(
                    """
                    INSERT INTO projects(id, name, description, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?)
                    """,
                    (project_id, payload.name, payload.description, now, now),
                )
                self._audit(
                    connection,
                    now=now,
                    actor_type="user",
                    actor_id=None,
                    action="screening.project_created",
                    entity_type="project",
                    entity_id=project_id,
                    after={"name": payload.name, "description": payload.description},
                )
        except sqlite3.IntegrityError as error:
            raise ScreeningConflictError("a project with this name already exists") from error
        return self.queries.get_project(project_id)

    def delete_project(
        self, project_id: str, payload: ProjectDeleteRequest
    ) -> ProjectDeleteResult:
        """Delete an explicitly confirmed project and selected empty orphan works."""

        now = _now()
        requested_work_ids = set(payload.orphan_work_ids)
        with self.database.transaction() as connection:
            project = connection.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            if project is None:
                raise ScreeningNotFoundError("project does not exist")
            current_updated_at = datetime.fromisoformat(
                str(project["updated_at"]).replace("Z", "+00:00")
            )
            if (
                project["name"] != payload.expected_name
                or current_updated_at != payload.expected_updated_at
            ):
                raise ScreeningConflictError("project confirmation no longer matches")
            if connection.execute(
                "SELECT 1 FROM agent_runs WHERE project_id = ? LIMIT 1", (project_id,)
            ).fetchone() is not None:
                raise ScreeningConflictError("project has agent run history")
            if connection.execute(
                "SELECT 1 FROM change_sets WHERE project_id = ? LIMIT 1", (project_id,)
            ).fetchone() is not None:
                raise ScreeningConflictError("project has change set history")
            if connection.execute(
                """
                SELECT 1 FROM candidates
                WHERE project_id = ? AND state IN ('staged', 'matched')
                LIMIT 1
                """,
                (project_id,),
            ).fetchone() is not None:
                raise ScreeningConflictError("project has unresolved candidates")

            project_work_ids = {
                str(row["work_id"])
                for row in connection.execute(
                    "SELECT work_id FROM project_works WHERE project_id = ?",
                    (project_id,),
                ).fetchall()
            }
            if requested_work_ids != project_work_ids:
                raise ScreeningConflictError(
                    "orphan work confirmation does not match the project"
                )
            for work_id in sorted(requested_work_ids):
                self._require_disposable_orphan_work(connection, project_id, work_id)

            source_record_ids = [
                str(row["source_record_id"])
                for row in connection.execute(
                    """
                    SELECT DISTINCT source_record_id FROM candidates
                    WHERE project_id = ? AND source_record_id IS NOT NULL
                    """,
                    (project_id,),
                ).fetchall()
            ]
            self._audit(
                connection,
                now=now,
                actor_type="user",
                actor_id=None,
                action="screening.project_deleted",
                entity_type="project",
                entity_id=project_id,
                before={
                    "name": project["name"],
                    "description": project["description"],
                    "updated_at": project["updated_at"],
                    "deleted_orphan_work_ids": sorted(requested_work_ids),
                },
            )
            connection.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            for work_id in sorted(requested_work_ids):
                connection.execute("DELETE FROM works WHERE id = ?", (work_id,))
            for source_record_id in source_record_ids:
                if not self._source_record_is_referenced(connection, source_record_id):
                    connection.execute(
                        "DELETE FROM source_records WHERE id = ?", (source_record_id,)
                    )
        return ProjectDeleteResult(
            project_id=project_id,
            deleted_orphan_work_ids=sorted(requested_work_ids),
        )

    def stage_candidate(
        self,
        project_id: str,
        payload: CandidateCreate,
        *,
        actor_type: str = "user",
        actor_id: str | None = None,
        correlation_id: str | None = None,
    ) -> CandidateView:
        now = _now()
        candidate_id = _id()
        proposed = payload.item.model_dump(mode="json")
        raw_payload = payload.raw_payload if payload.raw_payload is not None else proposed
        payload_json = _json(raw_payload)
        payload_sha256 = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
        try:
            normalized = [
                normalize_identifier(identifier.scheme, identifier.value)
                for identifier in payload.item.identifiers
            ]
        except CatalogConflictError as error:
            raise ScreeningConflictError(str(error)) from error
        with self.database.transaction() as connection:
            self._require_project(connection, project_id)
            if payload.discovery_session_id is not None:
                session = connection.execute(
                    """
                    SELECT 1 FROM discovery_sessions
                    WHERE id = ? AND project_id = ?
                    """,
                    (payload.discovery_session_id, project_id),
                ).fetchone()
                if session is None:
                    raise ScreeningNotFoundError("discovery session does not exist")
            source_record_id = self._save_source_record(
                connection,
                provider=payload.source_provider,
                external_key=payload.source_external_key,
                source_url=payload.source_url,
                schema_version=payload.source_schema_version,
                payload_json=payload_json,
                payload_sha256=payload_sha256,
                retrieved_at=now,
            )
            matches: set[str] = set()
            for identifier in normalized:
                if not identifier.is_identity:
                    continue
                row = connection.execute(
                    """
                    SELECT item.work_id
                    FROM item_identifiers identifier
                    JOIN bibliographic_items item ON item.id = identifier.item_id
                    WHERE identifier.scheme = ?
                      AND identifier.normalized_value = ?
                      AND identifier.is_identity = 1
                    """,
                    (identifier.scheme, identifier.normalized_value),
                ).fetchone()
                if row is not None:
                    matches.add(str(row["work_id"]))
            if len(matches) > 1:
                raise ScreeningConflictError(
                    "candidate identifiers resolve to different existing works"
                )
            matched_work_id = next(iter(matches), None)
            dedupe_key = payload.dedupe_key or self._dedupe_key(payload.item, normalized)
            connection.execute(
                """
                INSERT INTO candidates(
                    id, project_id, discovery_session_id, source_record_id, state,
                    proposed_item_json, dedupe_key, matched_work_id,
                    rank, rationale, created_at, resolved_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    candidate_id,
                    project_id,
                    payload.discovery_session_id,
                    source_record_id,
                    "matched" if matched_work_id else "staged",
                    _json(proposed),
                    dedupe_key,
                    matched_work_id,
                    payload.rank,
                    payload.rationale,
                    now,
                ),
            )
            self._audit(
                connection,
                now=now,
                actor_type=actor_type,
                actor_id=actor_id,
                action="screening.candidate_staged",
                entity_type="candidate",
                entity_id=candidate_id,
                correlation_id=correlation_id,
                after={"matched_work_id": matched_work_id, "title": payload.item.title},
            )
        return self.queries.get_candidate(project_id, candidate_id)

    def promote_candidate(
        self,
        project_id: str,
        candidate_id: str,
        payload: CandidatePromotionRequest,
        *,
        actor_id: str | None = None,
        correlation_id: str | None = None,
    ) -> ProjectWorkView:
        now = _now()
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM candidates WHERE id = ? AND project_id = ?",
                (candidate_id, project_id),
            ).fetchone()
            if row is None:
                raise ScreeningNotFoundError("candidate does not exist")
            if row["state"] == "dismissed":
                raise ScreeningConflictError("dismissed candidate cannot be promoted")
            if row["state"] == "promoted":
                work_id = str(row["matched_work_id"])
            else:
                work_id = payload.matched_work_id or row["matched_work_id"]
                if work_id is not None:
                    if (
                        connection.execute(
                            "SELECT 1 FROM works WHERE id = ?", (work_id,)
                        ).fetchone()
                        is None
                    ):
                        raise ScreeningNotFoundError("matched work does not exist")
                else:
                    draft = BibliographicItemDraft.model_validate(
                        json.loads(row["proposed_item_json"])
                    )
                    try:
                        work_id, _ = self.catalog.create_work_in(
                            connection,
                            draft,
                            source_record_id=row["source_record_id"],
                            actor_type="user",
                            actor_id=actor_id,
                            correlation_id=correlation_id,
                        )
                    except CatalogConflictError as error:
                        raise ScreeningConflictError(str(error)) from error
                membership = connection.execute(
                    """
                    SELECT id FROM project_works WHERE project_id = ? AND work_id = ?
                    """,
                    (project_id, work_id),
                ).fetchone()
                if membership is None:
                    connection.execute(
                        """
                        INSERT INTO project_works(
                            id, project_id, work_id, status, created_at, updated_at
                        ) VALUES(?, ?, ?, 'discovered', ?, ?)
                        """,
                        (_id(), project_id, work_id, now, now),
                    )
                connection.execute(
                    """
                    UPDATE candidates
                    SET state = 'promoted', matched_work_id = ?, resolved_at = ?
                    WHERE id = ?
                    """,
                    (work_id, now, candidate_id),
                )
                self._audit(
                    connection,
                    now=now,
                    actor_type="user",
                    actor_id=actor_id,
                    action="screening.candidate_promoted",
                    entity_type="candidate",
                    entity_id=candidate_id,
                    correlation_id=correlation_id,
                    after={"work_id": work_id},
                )
        return self.queries.get_project_work(project_id, work_id)

    def decide_candidates(
        self,
        project_id: str,
        decisions: list[CandidateDecision],
        *,
        actor_id: str | None = None,
    ) -> list[CandidateDecisionResult]:
        """Atomically turns reviewed candidates into durable include/exclude records."""

        now = _now()
        resolved: list[tuple[str, str]] = []
        if len({decision.candidate_id for decision in decisions}) != len(decisions):
            raise ScreeningConflictError("candidate decisions contain duplicate IDs")
        with self.database.transaction() as connection:
            self._require_project(connection, project_id)
            for decision in decisions:
                row = connection.execute(
                    "SELECT * FROM candidates WHERE id = ? AND project_id = ?",
                    (decision.candidate_id, project_id),
                ).fetchone()
                if row is None:
                    raise ScreeningNotFoundError("candidate does not exist")
                if row["state"] in {"promoted", "dismissed"}:
                    raise ScreeningConflictError("candidate has already been resolved")
                work_id = decision.matched_work_id or row["matched_work_id"]
                if work_id is not None:
                    if (
                        connection.execute(
                            "SELECT 1 FROM works WHERE id = ?", (work_id,)
                        ).fetchone()
                        is None
                    ):
                        raise ScreeningNotFoundError("matched work does not exist")
                else:
                    draft = BibliographicItemDraft.model_validate(
                        json.loads(row["proposed_item_json"])
                    )
                    try:
                        work_id, _ = self.catalog.create_work_in(
                            connection,
                            draft,
                            source_record_id=row["source_record_id"],
                            actor_type="user",
                            actor_id=actor_id,
                            correlation_id=decision.candidate_id,
                        )
                    except CatalogConflictError as error:
                        raise ScreeningConflictError(str(error)) from error
                membership = connection.execute(
                    "SELECT * FROM project_works WHERE project_id = ? AND work_id = ?",
                    (project_id, work_id),
                ).fetchone()
                status = "included" if decision.decision == "include" else "excluded"
                reason = (decision.reason or row["rationale"] or "").strip() or (
                    "用户确认相关" if status == "included" else "用户确认不收录"
                )
                if membership is None:
                    membership_id = _id()
                    connection.execute(
                        """
                        INSERT INTO project_works(
                            id, project_id, work_id, status, relevance,
                            decided_at, decided_by, created_at, updated_at
                        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            membership_id,
                            project_id,
                            work_id,
                            status,
                            reason,
                            now,
                            actor_id or "local-user",
                            now,
                            now,
                        ),
                    )
                else:
                    connection.execute(
                        """
                        UPDATE project_works SET status = ?, relevance = ?,
                            decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ?
                        """,
                        (
                            status,
                            reason,
                            now,
                            actor_id or "local-user",
                            now,
                            membership["id"],
                        ),
                    )
                connection.execute(
                    """
                    UPDATE candidates SET state = 'promoted', matched_work_id = ?, resolved_at = ?
                    WHERE id = ?
                    """,
                    (work_id, now, decision.candidate_id),
                )
                self._audit(
                    connection,
                    now=now,
                    actor_type="user",
                    actor_id=actor_id,
                    action=f"screening.candidate_{decision.decision}d",
                    entity_type="candidate",
                    entity_id=decision.candidate_id,
                    correlation_id=decision.candidate_id,
                    after={"work_id": work_id, "status": status, "reason": reason},
                )
                resolved.append((decision.candidate_id, work_id))
        return [
            CandidateDecisionResult(
                candidate=self.queries.get_candidate(project_id, candidate_id),
                project_item=self.queries.get_project_work(project_id, work_id),
            )
            for candidate_id, work_id in resolved
        ]

    def dismiss_candidate(
        self, project_id: str, candidate_id: str, *, actor_id: str | None = None
    ) -> CandidateView:
        now = _now()
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT state FROM candidates WHERE id = ? AND project_id = ?",
                (candidate_id, project_id),
            ).fetchone()
            if row is None:
                raise ScreeningNotFoundError("candidate does not exist")
            if row["state"] == "promoted":
                raise ScreeningConflictError("promoted candidate cannot be dismissed")
            connection.execute(
                "UPDATE candidates SET state='dismissed', resolved_at=? WHERE id=?",
                (now, candidate_id),
            )
            self._audit(
                connection,
                now=now,
                actor_type="user",
                actor_id=actor_id,
                action="screening.candidate_dismissed",
                entity_type="candidate",
                entity_id=candidate_id,
            )
        return self.queries.get_candidate(project_id, candidate_id)

    def apply_project_insights(
        self,
        project_id: str,
        work_id: str,
        base_updated_at: str,
        patch: ProjectInsightsPatch,
        *,
        actor_type: str = "user",
        actor_id: str | None = None,
        correlation_id: str | None = None,
    ) -> ProjectWorkView:
        now = _now()
        changes = patch.model_dump(exclude_unset=True, mode="json")
        with self.database.transaction() as connection:
            current = connection.execute(
                "SELECT * FROM project_works WHERE project_id = ? AND work_id = ?",
                (project_id, work_id),
            ).fetchone()
            if current is None:
                raise ScreeningNotFoundError("work is not in the project")
            if correlation_id is not None:
                applied = connection.execute(
                    """
                    SELECT 1 FROM audit_events
                    WHERE action = 'screening.project_insights_applied'
                      AND entity_id = ? AND correlation_id = ?
                    """,
                    (current["id"], correlation_id),
                ).fetchone()
                if applied is not None:
                    return ScreeningQueries._project_work(connection, current)
            if current["updated_at"] != base_updated_at:
                raise ScreeningConflictError(
                    "project insights are stale because the project work changed"
                )
            scalar_changes = {
                key: changes[key] for key in ("summary", "relevance") if key in changes
            }
            if scalar_changes:
                assignments = ", ".join(f"{key} = ?" for key in scalar_changes)
                connection.execute(
                    f"UPDATE project_works SET {assignments} WHERE id = ?",  # noqa: S608
                    (*scalar_changes.values(), current["id"]),
                )
            if "roles" in changes:
                connection.execute(
                    "DELETE FROM project_work_roles WHERE project_work_id = ?",
                    (current["id"],),
                )
                for role in dict.fromkeys(patch.roles):
                    connection.execute(
                        "INSERT INTO project_work_roles(project_work_id, role) VALUES(?, ?)",
                        (current["id"], role),
                    )
            for field, kind in (
                ("contributions", "contribution"),
                ("reading_focus", "reading_focus"),
            ):
                if field not in changes:
                    continue
                connection.execute(
                    "DELETE FROM project_work_notes WHERE project_work_id = ? AND kind = ?",
                    (current["id"], kind),
                )
                for position, text in enumerate(changes[field]):
                    connection.execute(
                        """
                        INSERT INTO project_work_notes(
                            id, project_work_id, kind, position, text
                        ) VALUES(?, ?, ?, ?, ?)
                        """,
                        (_id(), current["id"], kind, position, text),
                    )
            connection.execute(
                "UPDATE project_works SET updated_at = ? WHERE id = ?",
                (now, current["id"]),
            )
            self._audit(
                connection,
                now=now,
                actor_type=actor_type,
                actor_id=actor_id,
                action="screening.project_insights_applied",
                entity_type="project_work",
                entity_id=current["id"],
                correlation_id=correlation_id,
                before={
                    "summary": current["summary"],
                    "relevance": current["relevance"],
                },
                after=changes,
            )
        return self.queries.get_project_work(project_id, work_id)

    def decide_project_work(
        self,
        project_id: str,
        work_id: str,
        payload: ProjectWorkDecision,
        *,
        actor_type: str = "user",
        actor_id: str | None = None,
        correlation_id: str | None = None,
    ) -> ProjectWorkView:
        now = _now()
        with self.database.transaction() as connection:
            current = connection.execute(
                "SELECT * FROM project_works WHERE project_id = ? AND work_id = ?",
                (project_id, work_id),
            ).fetchone()
            if current is None:
                raise ScreeningNotFoundError("work is not in the project")
            changes = payload.model_dump(exclude_unset=True, mode="json")
            next_status = changes.get("status", current["status"])
            next_relevance = changes.get("relevance", current["relevance"])
            if next_status == "included" and not (next_relevance or "").strip():
                raise ScreeningConflictError("included work requires relevance")
            if (
                "status" in changes
                and changes["status"] != current["status"]
                and actor_type != "user"
            ):
                raise ScreeningConflictError(
                    "only an explicit user action may change a screening decision"
                )
            scalar_changes = {
                key: changes[key] for key in ("status", "summary", "relevance") if key in changes
            }
            if "status" in scalar_changes:
                scalar_changes["decided_at"] = (
                    now if scalar_changes["status"] != "discovered" else None
                )
                scalar_changes["decided_by"] = (
                    actor_id or "local-user" if scalar_changes["status"] != "discovered" else None
                )
            if scalar_changes:
                assignments = ", ".join(f"{key} = ?" for key in scalar_changes)
                connection.execute(
                    f"UPDATE project_works SET {assignments}, updated_at = ? WHERE id = ?",
                    (*scalar_changes.values(), now, current["id"]),
                )
            if "roles" in changes:
                connection.execute(
                    "DELETE FROM project_work_roles WHERE project_work_id = ?",
                    (current["id"],),
                )
                for role in dict.fromkeys(changes["roles"]):
                    connection.execute(
                        "INSERT INTO project_work_roles(project_work_id, role) VALUES(?, ?)",
                        (current["id"], role),
                    )
            for field, kind in (
                ("contributions", "contribution"),
                ("reading_focus", "reading_focus"),
            ):
                if field not in changes:
                    continue
                connection.execute(
                    "DELETE FROM project_work_notes WHERE project_work_id = ? AND kind = ?",
                    (current["id"], kind),
                )
                for position, text in enumerate(changes[field]):
                    connection.execute(
                        """
                        INSERT INTO project_work_notes(
                            id, project_work_id, kind, position, text
                        ) VALUES(?, ?, ?, ?, ?)
                        """,
                        (_id(), current["id"], kind, position, text),
                    )
            self._audit(
                connection,
                now=now,
                actor_type=actor_type,
                actor_id=actor_id,
                action="screening.decision_changed",
                entity_type="project_work",
                entity_id=current["id"],
                correlation_id=correlation_id,
                before={"status": current["status"], "relevance": current["relevance"]},
                after=changes,
            )
        return self.queries.get_project_work(project_id, work_id)

    @staticmethod
    def _require_disposable_orphan_work(
        connection: sqlite3.Connection, project_id: str, work_id: str
    ) -> None:
        if connection.execute(
            """
            SELECT 1 FROM project_works
            WHERE work_id = ? AND project_id != ? LIMIT 1
            """,
            (work_id, project_id),
        ).fetchone() is not None:
            raise ScreeningConflictError("work still belongs to another project")
        if connection.execute(
            """
            SELECT 1 FROM candidates
            WHERE matched_work_id = ? AND project_id != ? LIMIT 1
            """,
            (work_id, project_id),
        ).fetchone() is not None:
            raise ScreeningConflictError("work is referenced by another project candidate")
        item_ids = [
            str(row["id"])
            for row in connection.execute(
                "SELECT id FROM bibliographic_items WHERE work_id = ?", (work_id,)
            ).fetchall()
        ]
        if not item_ids:
            raise ScreeningConflictError("work has no bibliographic item")
        placeholders = ",".join("?" for _ in item_ids)
        protected_tables = (
            "attachments",
            "annotations",
            "reading_states",
            "agent_runs",
            "change_sets",
        )
        for table in protected_tables:
            if connection.execute(
                f"SELECT 1 FROM {table} WHERE item_id IN ({placeholders}) LIMIT 1",
                item_ids,
            ).fetchone() is not None:
                raise ScreeningConflictError(f"work has protected {table} data")
        if connection.execute(
            f"""
            SELECT 1 FROM item_relations
            WHERE source_item_id IN ({placeholders})
               OR target_item_id IN ({placeholders})
            LIMIT 1
            """,
            [*item_ids, *item_ids],
        ).fetchone() is not None:
            raise ScreeningConflictError("work has item relations")
        subject_ids = [project_id, work_id, *item_ids]
        subject_placeholders = ",".join("?" for _ in subject_ids)
        if connection.execute(
            f"SELECT 1 FROM jobs WHERE subject_id IN ({subject_placeholders}) LIMIT 1",
            subject_ids,
        ).fetchone() is not None:
            raise ScreeningConflictError("work has job history")

    @staticmethod
    def _source_record_is_referenced(
        connection: sqlite3.Connection, source_record_id: str
    ) -> bool:
        return connection.execute(
            """
            SELECT 1 FROM candidates WHERE source_record_id = ?
            UNION ALL SELECT 1 FROM item_creators WHERE source_record_id = ?
            UNION ALL SELECT 1 FROM item_identifiers WHERE source_record_id = ?
            UNION ALL SELECT 1 FROM item_links WHERE source_record_id = ?
            UNION ALL SELECT 1 FROM item_tags WHERE source_record_id = ?
            UNION ALL SELECT 1 FROM item_field_sources WHERE source_record_id = ?
            LIMIT 1
            """,
            (source_record_id,) * 6,
        ).fetchone() is not None

    @staticmethod
    def _require_project(connection: sqlite3.Connection, project_id: str) -> None:
        if (
            connection.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone()
            is None
        ):
            raise ScreeningNotFoundError("project does not exist")

    @staticmethod
    def _save_source_record(
        connection: sqlite3.Connection,
        *,
        provider: str,
        external_key: str | None,
        source_url: str | None,
        schema_version: str | None,
        payload_json: str,
        payload_sha256: str,
        retrieved_at: str,
    ) -> str:
        existing = connection.execute(
            """
            SELECT id FROM source_records
            WHERE provider = ? AND external_key IS ? AND payload_sha256 = ?
            """,
            (provider, external_key, payload_sha256),
        ).fetchone()
        if existing is not None:
            return str(existing["id"])
        source_record_id = _id()
        connection.execute(
            """
            INSERT INTO source_records(
                id, provider, external_key, source_url, retrieved_at,
                payload_json, payload_sha256, schema_version
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_record_id,
                provider,
                external_key,
                source_url,
                retrieved_at,
                payload_json,
                payload_sha256,
                schema_version,
            ),
        )
        return source_record_id

    @staticmethod
    def _dedupe_key(item: BibliographicItemDraft, normalized) -> str:
        identity = next((value for value in normalized if value.is_identity), None)
        if identity is not None:
            return f"{identity.scheme}:{identity.normalized_value}"
        first_creator = item.creators[0].raw_name if item.creators else ""
        payload = f"{item.title.casefold()}\n{first_creator.casefold()}\n{item.issued_year or ''}"
        return f"metadata:{hashlib.sha256(payload.encode('utf-8')).hexdigest()}"

    @staticmethod
    def _audit(
        connection: sqlite3.Connection,
        *,
        now: str,
        actor_type: str,
        actor_id: str | None,
        action: str,
        entity_type: str,
        entity_id: str,
        correlation_id: str | None = None,
        before=None,
        after=None,
    ) -> None:
        connection.execute(
            """
            INSERT INTO audit_events(
                id, occurred_at, actor_type, actor_id, action,
                entity_type, entity_id, correlation_id, before_json, after_json
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _id(),
                now,
                actor_type,
                actor_id,
                action,
                entity_type,
                entity_id,
                correlation_id,
                _json(before) if before is not None else None,
                _json(after) if after is not None else None,
            ),
        )

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.platform.activation import (
    FaultInjector,
    activate_v2_database,
    default_activation_journal,
)
from app.platform.db import DatabaseKind, V3Database, inspect_database

IMPORT_NAMESPACE = uuid.UUID("d84a7589-2022-48a6-ad77-dfc6605931e0")


class V2ImportError(RuntimeError):
    pass


@dataclass(frozen=True)
class ImportCounts:
    projects: int
    works: int
    items: int
    project_works: int
    attachments: int
    jobs: int


@dataclass(frozen=True)
class V2MigrationReport:
    source_database: Path
    active_database: Path
    backup_database: Path | None
    counts: ImportCounts
    files_verified: int


def _stable_id(kind: str, value: str) -> str:
    return uuid.uuid5(IMPORT_NAMESPACE, f"{kind}:{value}").hex


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_sha256(value: Any) -> str:
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _load_list(value: str | None, field: str) -> list[Any]:
    try:
        parsed = json.loads(value or "[]")
    except json.JSONDecodeError as error:
        raise V2ImportError(f"legacy field {field} is not valid JSON") from error
    if not isinstance(parsed, list):
        raise V2ImportError(f"legacy field {field} is not a list")
    return parsed


def _load_dict(value: str | None, field: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError as error:
        raise V2ImportError(f"legacy field {field} is not valid JSON") from error
    if not isinstance(parsed, dict):
        raise V2ImportError(f"legacy field {field} is not an object")
    return parsed


def _read_only(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def _source_table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        is not None
    )


def import_v2_to_v3(
    source_database: Path,
    target_database: Path,
    *,
    data_dir: Path | None = None,
    verify_files: bool = True,
) -> V2MigrationReport:
    """Build the current database beside a v2 database without modifying the source."""

    source_database = source_database.resolve()
    target_database = target_database.resolve()
    if inspect_database(source_database).kind is not DatabaseKind.LEGACY_V2:
        raise V2ImportError("source database is not a v2 learning workspace")
    if target_database.exists():
        raise V2ImportError("target database already exists")
    resolved_data_dir = (data_dir or source_database.parent).resolve()

    database = V3Database(target_database)
    database.initialize()
    source = _read_only(source_database)
    try:
        active_jobs = int(
            source.execute(
                "SELECT COUNT(*) FROM jobs WHERE status IN ('queued', 'running')"
            ).fetchone()[0]
        )
        if active_jobs:
            raise V2ImportError("v2 database contains active jobs; stop or resolve them first")
        with database.transaction() as target:
            counts = _copy_v2(source, target)
        files_verified = _validate_import(
            source,
            database,
            resolved_data_dir,
            verify_files=verify_files,
        )
    except Exception:
        target_database.unlink(missing_ok=True)
        raise
    finally:
        source.close()

    return V2MigrationReport(
        source_database=source_database,
        active_database=target_database,
        backup_database=None,
        counts=counts,
        files_verified=files_verified,
    )


def migrate_v2_database(
    database_path: Path,
    *,
    data_dir: Path | None = None,
    verify_files: bool = True,
    activation_journal: Path | None = None,
    fault_injector: FaultInjector | None = None,
) -> V2MigrationReport:
    """Import v2 into a shadow database and atomically activate the validated current file.

    The caller must stop the application before invoking this function. The v2 main,
    WAL, and shared-memory files are retained under a timestamped backup name.
    """

    database_path = database_path.resolve()
    if inspect_database(database_path).kind is not DatabaseKind.LEGACY_V2:
        raise V2ImportError("active database is not a v2 learning workspace")
    shadow = database_path.with_name(f".{database_path.name}.v4-migrating-{uuid.uuid4().hex}")
    report = import_v2_to_v3(
        database_path,
        shadow,
        data_dir=data_dir,
        verify_files=verify_files,
    )
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    backup = database_path.with_name(f"{database_path.name}.v2-{timestamp}.bak")
    if backup.exists():
        shadow.unlink(missing_ok=True)
        raise V2ImportError(f"backup database already exists: {backup}")

    activate_v2_database(
        database_path,
        shadow,
        backup,
        journal_path=(
            activation_journal
            if activation_journal is not None
            else default_activation_journal(database_path.parent)
        ),
        fault_injector=fault_injector,
    )

    return replace(report, active_database=database_path, backup_database=backup)


def _copy_v2(source: sqlite3.Connection, target: sqlite3.Connection) -> ImportCounts:
    now = _utc_now()
    projects = source.execute("SELECT * FROM projects ORDER BY created_at, id").fetchall()
    papers = source.execute("SELECT * FROM papers ORDER BY created_at, id").fetchall()
    memberships = source.execute("SELECT * FROM project_papers ORDER BY created_at, id").fetchall()
    resources = source.execute("SELECT * FROM resources ORDER BY created_at, id").fetchall()
    jobs = source.execute("SELECT * FROM jobs ORDER BY created_at, id").fetchall()
    identifiers = source.execute(
        "SELECT * FROM paper_identifiers ORDER BY paper_id, is_primary DESC, scheme, id"
    ).fetchall()
    legacy_rows = (
        source.execute("SELECT * FROM paper_legacy ORDER BY project_paper_id").fetchall()
        if _source_table_exists(source, "paper_legacy")
        else []
    )

    membership_by_paper: dict[str, list[dict[str, Any]]] = defaultdict(list)
    legacy_by_membership = {str(row["project_paper_id"]): dict(row) for row in legacy_rows}
    for row in memberships:
        record = dict(row)
        legacy = legacy_by_membership.get(str(row["id"]))
        if legacy is not None:
            record["legacy"] = legacy
        membership_by_paper[str(row["paper_id"])].append(record)
    identifiers_by_paper: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in identifiers:
        identifiers_by_paper[str(row["paper_id"])].append(dict(row))

    for project in projects:
        target.execute(
            """
            INSERT INTO projects(id, name, description, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?)
            """,
            (
                project["id"],
                project["name"],
                project["description"],
                project["created_at"],
                project["updated_at"],
            ),
        )

    paper_to_work: dict[str, str] = {}
    source_record_by_paper: dict[str, str] = {}
    for paper in papers:
        paper_id = str(paper["id"])
        work_id = _stable_id("work", paper_id)
        paper_to_work[paper_id] = work_id
        source_record_id = _stable_id("source-record", paper_id)
        source_record_by_paper[paper_id] = source_record_id
        links = _load_list(paper["links_json"], "papers.links_json")
        raw_payload = {
            "paper": dict(paper),
            "identifiers": identifiers_by_paper[paper_id],
            "links": links,
            "project_memberships": membership_by_paper[paper_id],
        }
        source_url = next(
            (str(link.get("url")) for link in links if isinstance(link, dict) and link.get("url")),
            None,
        )
        target.execute(
            """
            INSERT INTO source_records(
                id, provider, external_key, source_url, retrieved_at,
                payload_json, payload_sha256, schema_version
            ) VALUES(?, 'legacy-v2', ?, ?, ?, ?, ?, '2')
            """,
            (
                source_record_id,
                f"paper:{paper_id}",
                source_url,
                now,
                _json(raw_payload),
                _json_sha256(raw_payload),
            ),
        )
        target.execute(
            "INSERT INTO works(id, created_at, updated_at) VALUES(?, ?, ?)",
            (work_id, paper["created_at"], paper["updated_at"]),
        )
        paper_identifiers = identifiers_by_paper[paper_id]
        is_preprint = paper["publication_state"] == "preprint" or any(
            str(item["scheme"]).lower() == "arxiv" for item in paper_identifiers
        )
        target.execute(
            """
            INSERT INTO bibliographic_items(
                id, work_id, item_type, title, translated_title, abstract,
                issued_year, container_title, publication_state,
                creator_list_complete, is_preferred_for_work, created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                paper_id,
                work_id,
                "preprint" if is_preprint else "document",
                paper["title"],
                paper["title_zh"],
                paper["abstract"],
                paper["publication_year"],
                paper["venue"],
                paper["publication_state"],
                paper["authors_complete"],
                paper["created_at"],
                paper["updated_at"],
            ),
        )

        authors = _load_list(paper["authors_json"], "papers.authors_json")
        for position, author in enumerate(authors):
            if not isinstance(author, str) or not author.strip():
                raise V2ImportError(f"paper {paper_id} contains an invalid legacy author")
            target.execute(
                """
                INSERT INTO item_creators(
                    id, item_id, position, role, creator_type,
                    literal_name, raw_name, source_record_id
                ) VALUES(?, ?, ?, 'author', 'literal', ?, ?, ?)
                """,
                (
                    _stable_id("creator", f"{paper_id}:{position}"),
                    paper_id,
                    position,
                    author,
                    author,
                    source_record_id,
                ),
            )

        for identifier in paper_identifiers:
            scheme = str(identifier["scheme"]).lower()
            target.execute(
                """
                INSERT INTO item_identifiers(
                    id, item_id, scheme, value, normalized_value, version,
                    is_primary, is_identity, source_record_id
                ) VALUES(?, ?, ?, ?, ?, NULL, ?, ?, ?)
                """,
                (
                    identifier["id"],
                    paper_id,
                    scheme,
                    identifier["value"],
                    identifier["normalized_value"],
                    identifier["is_primary"],
                    int(scheme not in {"url", "legacy"}),
                    source_record_id,
                ),
            )

        seen_links: set[tuple[str, str]] = set()
        for position, link in enumerate(links):
            if not isinstance(link, dict) or not link.get("url"):
                raise V2ImportError(f"paper {paper_id} contains an invalid legacy link")
            relation_type = str(link.get("type") or "related")
            url = str(link["url"])
            if (relation_type, url) in seen_links:
                continue
            seen_links.add((relation_type, url))
            target.execute(
                """
                INSERT INTO item_links(
                    id, item_id, relation_type, url, source_record_id
                ) VALUES(?, ?, ?, ?, ?)
                """,
                (
                    _stable_id("link", f"{paper_id}:{position}:{relation_type}:{url}"),
                    paper_id,
                    relation_type,
                    url,
                    source_record_id,
                ),
            )

        field_values = {
            "title": paper["title"],
            "translated_title": paper["title_zh"],
            "abstract": paper["abstract"],
            "issued_year": paper["publication_year"],
            "container_title": paper["venue"],
            "publication_state": paper["publication_state"],
            "creator_list_complete": bool(paper["authors_complete"]),
        }
        for field_path, value in field_values.items():
            if value is None:
                continue
            target.execute(
                """
                INSERT INTO item_field_sources(
                    item_id, field_path, source_record_id, value_sha256, selected_at
                ) VALUES(?, ?, ?, ?, ?)
                """,
                (paper_id, field_path, source_record_id, _json_sha256(value), now),
            )

    for membership in memberships:
        paper_id = str(membership["paper_id"])
        status = str(membership["status"])
        target.execute(
            """
            INSERT INTO project_works(
                id, project_id, work_id, status, summary, relevance,
                decided_at, decided_by, created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                membership["id"],
                membership["project_id"],
                paper_to_work[paper_id],
                status,
                membership["summary"],
                membership["relevance"],
                membership["updated_at"] if status != "discovered" else None,
                "legacy-v2" if status != "discovered" else None,
                membership["created_at"],
                membership["updated_at"],
            ),
        )
        roles = _load_list(membership["roles_json"], "project_papers.roles_json")
        for role in roles:
            target.execute(
                "INSERT INTO project_work_roles(project_work_id, role) VALUES(?, ?)",
                (membership["id"], str(role)),
            )
        for kind, column in (
            ("contribution", "contributions_json"),
            ("reading_focus", "reading_focus_json"),
        ):
            notes = _load_list(membership[column], f"project_papers.{column}")
            for position, text in enumerate(notes):
                target.execute(
                    """
                    INSERT INTO project_work_notes(
                        id, project_work_id, kind, position, text
                    ) VALUES(?, ?, ?, ?, ?)
                    """,
                    (
                        _stable_id("project-note", f"{membership['id']}:{kind}:{position}"),
                        membership["id"],
                        kind,
                        position,
                        str(text),
                    ),
                )

    blob_by_sha: dict[str, tuple[str, int]] = {}
    primary_object_created: set[str] = set()
    for resource in resources:
        sha256 = str(resource["sha256"])
        size = int(resource["size"])
        existing_blob = blob_by_sha.get(sha256)
        if existing_blob is not None and existing_blob[1] != size:
            raise V2ImportError(f"resources with SHA-256 {sha256} disagree on size")
        blob_id = existing_blob[0] if existing_blob else _stable_id("blob", sha256)
        if existing_blob is None:
            blob_by_sha[sha256] = (blob_id, size)
            target.execute(
                """
                INSERT INTO blobs(id, sha256, size, media_type, created_at, verified_at)
                VALUES(?, ?, ?, ?, ?, NULL)
                """,
                (
                    blob_id,
                    sha256,
                    size,
                    resource["media_type"],
                    resource["created_at"],
                ),
            )
        is_primary = blob_id not in primary_object_created
        primary_object_created.add(blob_id)
        target.execute(
            """
            INSERT INTO blob_objects(
                id, blob_id, storage_backend, storage_key,
                is_primary, state, created_at
            ) VALUES(?, ?, 'local', ?, ?, 'available', ?)
            """,
            (
                _stable_id("blob-object", str(resource["id"])),
                blob_id,
                resource["relative_path"],
                int(is_primary),
                resource["created_at"],
            ),
        )
        format_ = str(resource["format"])
        target.execute(
            """
            INSERT INTO attachments(
                id, item_id, blob_id, attachment_type, format, language_mode,
                origin, filename, source_url, created_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                resource["id"],
                resource["paper_id"],
                blob_id,
                "source_archive" if format_ == "tex" else "fulltext",
                format_,
                resource["representation"],
                resource["origin"],
                resource["filename"],
                resource["source_url"],
                resource["created_at"],
            ),
        )
        if resource["preferred"]:
            target.execute(
                """
                INSERT INTO attachment_preferences(
                    item_id, purpose, attachment_id, updated_at
                ) VALUES(?, ?, ?, ?)
                """,
                (
                    resource["paper_id"],
                    f"{format_}:{resource['representation']}",
                    resource["id"],
                    resource["created_at"],
                ),
            )

    outputs_by_job: dict[str, list[str]] = defaultdict(list)
    resource_by_id = {str(resource["id"]): resource for resource in resources}
    for resource in resources:
        if resource["job_id"]:
            outputs_by_job[str(resource["job_id"])].append(str(resource["id"]))
    for job in jobs:
        job_id = str(job["id"])
        input_attachment = job["input_resource_id"]
        outputs = outputs_by_job[job_id]
        input_payload = {
            "input_attachment_id": input_attachment,
            "options": _load_dict(job["options_json"], "jobs.options_json"),
            "legacy_progress": job["progress"],
            "legacy_message": job["message"],
            "legacy_tool": job["tool"],
            "legacy_tool_version": job["tool_version"],
            "legacy_log_excerpt": job["log_excerpt"],
        }
        result_payload = {"output_attachment_ids": outputs}
        error_payload = None
        if job["error_summary"] or job["log_excerpt"]:
            error_payload = _json(
                {
                    "summary": job["error_summary"],
                    "log_excerpt": job["log_excerpt"],
                }
            )
        target.execute(
            """
            INSERT INTO jobs(
                id, kind, subject_type, subject_id, status,
                requested_by_type, input_json, result_json, error_code,
                error_message, max_attempts, heartbeat_at, created_at,
                updated_at, available_at, started_at, finished_at
            ) VALUES(
                ?, ?, 'item', ?, ?, 'legacy-v2', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?
            )
            """,
            (
                job_id,
                job["operation"],
                job["paper_id"],
                job["status"],
                _json(input_payload),
                _json(result_payload) if outputs else None,
                "legacy_job_failed" if job["error_summary"] else None,
                job["error_summary"],
                job["started_at"] if job["status"] == "running" else None,
                job["created_at"],
                job["finished_at"] or job["started_at"] or job["created_at"],
                job["created_at"],
                job["started_at"],
                job["finished_at"],
            ),
        )
        if job["started_at"] is not None:
            attempt_status = str(job["status"])
            if attempt_status == "queued":
                attempt_status = "failed"
            target.execute(
                """
                INSERT INTO job_attempts(
                    id, job_id, attempt_number, worker_id, status, executable,
                    error_message, started_at, heartbeat_at, finished_at,
                    tool_name, tool_version, stdout_tail, error_json
                ) VALUES(?, ?, 1, 'legacy-v2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _stable_id("job-attempt", job_id),
                    job_id,
                    attempt_status,
                    job["tool"],
                    job["error_summary"],
                    job["started_at"],
                    job["finished_at"] or job["started_at"],
                    job["finished_at"],
                    job["tool"],
                    job["tool_version"],
                    job["log_excerpt"],
                    error_payload,
                ),
            )
        if input_attachment:
            target.execute(
                """
                INSERT INTO job_attachments(
                    id, job_id, attempt_id, role, attachment_id,
                    media_type, metadata_json, created_at
                ) VALUES(?, ?, ?, 'input', ?, ?, '{}', ?)
                """,
                (
                    _stable_id("job-attachment", f"{job_id}:input:{input_attachment}"),
                    job_id,
                    _stable_id("job-attempt", job_id) if job["started_at"] else None,
                    input_attachment,
                    resource_by_id[str(input_attachment)]["media_type"],
                    job["created_at"],
                ),
            )
        for attachment_id in outputs:
            target.execute(
                """
                INSERT INTO job_attachments(
                    id, job_id, attempt_id, role, attachment_id,
                    media_type, metadata_json, created_at
                ) VALUES(?, ?, ?, 'output', ?, ?, '{}', ?)
                """,
                (
                    _stable_id("job-attachment", f"{job_id}:output:{attachment_id}"),
                    job_id,
                    _stable_id("job-attempt", job_id) if job["started_at"] else None,
                    attachment_id,
                    resource_by_id[attachment_id]["media_type"],
                    job["created_at"],
                ),
            )

    for resource in resources:
        if resource["parent_resource_id"]:
            target.execute(
                """
                INSERT INTO attachment_relations(
                    parent_attachment_id, child_attachment_id,
                    relation_type, job_id, created_at
                ) VALUES(?, ?, 'derived_from', ?, ?)
                """,
                (
                    resource["parent_resource_id"],
                    resource["id"],
                    resource["job_id"],
                    resource["created_at"],
                ),
            )

    target.execute(
        """
        INSERT INTO audit_events(
            id, occurred_at, actor_type, actor_id, action,
            entity_type, entity_id, metadata_json
        ) VALUES(?, ?, 'system', 'v2-importer', 'legacy.imported',
                 'workspace', 'local', ?)
        """,
        (
            _stable_id("audit", f"v2-import:{now}"),
            now,
            _json(
                {
                    "projects": len(projects),
                    "papers": len(papers),
                    "project_works": len(memberships),
                    "resources": len(resources),
                    "jobs": len(jobs),
                }
            ),
        ),
    )
    return ImportCounts(
        projects=len(projects),
        works=len(papers),
        items=len(papers),
        project_works=len(memberships),
        attachments=len(resources),
        jobs=len(jobs),
    )


def _validate_import(
    source: sqlite3.Connection,
    database: V3Database,
    data_dir: Path,
    *,
    verify_files: bool,
) -> int:
    expected = {
        "projects": source.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
        "items": source.execute("SELECT COUNT(*) FROM papers").fetchone()[0],
        "project_works": source.execute("SELECT COUNT(*) FROM project_papers").fetchone()[0],
        "attachments": source.execute("SELECT COUNT(*) FROM resources").fetchone()[0],
        "jobs": source.execute("SELECT COUNT(*) FROM jobs").fetchone()[0],
        "identifiers": source.execute("SELECT COUNT(*) FROM paper_identifiers").fetchone()[0],
    }
    with database.read() as target:
        actual = {
            "projects": target.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
            "items": target.execute("SELECT COUNT(*) FROM bibliographic_items").fetchone()[0],
            "project_works": target.execute("SELECT COUNT(*) FROM project_works").fetchone()[0],
            "attachments": target.execute("SELECT COUNT(*) FROM attachments").fetchone()[0],
            "jobs": target.execute("SELECT COUNT(*) FROM jobs").fetchone()[0],
            "identifiers": target.execute("SELECT COUNT(*) FROM item_identifiers").fetchone()[0],
        }
        if actual != expected:
            raise V2ImportError(f"import count mismatch: expected {expected}, got {actual}")

    # UUID5 identifiers cannot be composed in SQL. Validate each mapping explicitly.
    imported_resources: dict[str, tuple[str, str, int]] = {}
    with database.read() as target:
        expected_legacy_rows = (
            int(source.execute("SELECT COUNT(*) FROM paper_legacy").fetchone()[0])
            if _source_table_exists(source, "paper_legacy")
            else 0
        )
        imported_legacy_rows = 0
        for row in target.execute(
            "SELECT payload_json FROM source_records WHERE provider = 'legacy-v2'"
        ):
            payload = json.loads(row["payload_json"])
            imported_legacy_rows += sum(
                "legacy" in membership
                for membership in payload.get("project_memberships", [])
                if isinstance(membership, dict)
            )
        if imported_legacy_rows != expected_legacy_rows:
            raise V2ImportError("legacy-only paper fields were not preserved")
        for resource in source.execute(
            "SELECT id, relative_path, sha256, size FROM resources ORDER BY id"
        ):
            row = target.execute(
                """
                SELECT a.id, b.sha256, b.size, o.storage_key
                FROM attachments a
                JOIN blobs b ON b.id = a.blob_id
                JOIN blob_objects o ON o.id = ?
                WHERE a.id = ?
                """,
                (_stable_id("blob-object", str(resource["id"])), resource["id"]),
            ).fetchone()
            if row is None:
                raise V2ImportError(f"resource {resource['id']} was not imported")
            observed = (row["storage_key"], row["sha256"], int(row["size"]))
            wanted = (resource["relative_path"], resource["sha256"], int(resource["size"]))
            if observed != wanted:
                raise V2ImportError(f"resource {resource['id']} changed during import")
            imported_resources[str(resource["id"])] = wanted

        for paper in source.execute("SELECT id, authors_json FROM papers ORDER BY id"):
            expected_authors = len(_load_list(paper["authors_json"], "papers.authors_json"))
            rows = target.execute(
                """
                SELECT creator_type, given_name, family_name, literal_name, raw_name
                FROM item_creators WHERE item_id = ? ORDER BY position
                """,
                (paper["id"],),
            ).fetchall()
            if len(rows) != expected_authors:
                raise V2ImportError(f"paper {paper['id']} author count changed during import")
            if any(
                row["creator_type"] != "literal"
                or row["given_name"] is not None
                or row["family_name"] is not None
                or row["literal_name"] != row["raw_name"]
                for row in rows
            ):
                raise V2ImportError(f"paper {paper['id']} legacy author was interpreted")

    files_verified = 0
    if verify_files:
        for resource_id, (
            relative_path,
            expected_sha256,
            expected_size,
        ) in imported_resources.items():
            path = (data_dir / relative_path).resolve()
            if data_dir not in path.parents or not path.is_file():
                raise V2ImportError(f"resource file is missing or unsafe: {resource_id}")
            if path.stat().st_size != expected_size:
                raise V2ImportError(f"resource file size changed: {resource_id}")
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected_sha256:
                raise V2ImportError(f"resource file hash changed: {resource_id}")
            files_verified += 1

    database.verify()
    return files_verified

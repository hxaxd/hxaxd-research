from __future__ import annotations

import json
import re
import sqlite3
import uuid
from urllib.parse import urlparse


def _id() -> str:
    return uuid.uuid4().hex


def _identity(stable_key: str, stable_url: str) -> tuple[str, str, str]:
    raw = stable_key.strip()
    lowered = raw.lower()
    arxiv_match = re.search(
        r"(?:arxiv[:/]|10\.48550/arxiv\.)([a-z-]+(?:\.[a-z-]+)?/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?",
        lowered,
    )
    if arxiv_match:
        value = arxiv_match.group(1)
        return f"arxiv:{value}", "arxiv", value
    doi_match = re.search(r"(?:doi:|doi\.org/)?(10\.\d{4,9}/\S+)", lowered)
    if doi_match:
        value = doi_match.group(1).rstrip(".,;)")
        return f"doi:{value}", "doi", value
    parsed = urlparse(stable_url)
    normalized_url = stable_url.strip().rstrip("/").lower()
    if parsed.hostname and normalized_url:
        return f"url:{normalized_url}", "url", normalized_url
    return f"legacy:{lowered}", "legacy", raw


def _publication_state(value: str) -> str:
    lowered = value.lower()
    if any(token in lowered for token in ("arxiv", "preprint", "预印本")):
        return "preprint"
    if any(token in lowered for token in ("accepted", "录用", "接收")):
        return "accepted"
    if value.strip():
        return "published"
    return "unknown"


def _links(row: sqlite3.Row) -> str:
    values = []
    for link_type, column in (
        ("paper", "stable_url"),
        ("code", "code_url"),
        ("website", "website_url"),
    ):
        if row[column]:
            values.append({"type": link_type, "url": row[column]})
    return json.dumps(values, ensure_ascii=False)


def upgrade(connection: sqlite3.Connection) -> None:
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
        BEGIN IMMEDIATE;
        ALTER TABLE papers RENAME TO legacy_papers;
        ALTER TABLE artifacts RENAME TO legacy_artifacts;
        ALTER TABLE jobs RENAME TO legacy_jobs;

        CREATE TABLE papers (
            id TEXT PRIMARY KEY,
            identity_key TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            title_zh TEXT,
            authors_json TEXT NOT NULL,
            authors_complete INTEGER NOT NULL DEFAULT 1 CHECK(authors_complete IN (0, 1)),
            abstract TEXT,
            publication_year INTEGER,
            venue TEXT,
            publication_state TEXT NOT NULL DEFAULT 'unknown'
                CHECK(publication_state IN ('preprint', 'accepted', 'published', 'unknown')),
            links_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE paper_identifiers (
            id TEXT PRIMARY KEY,
            paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
            scheme TEXT NOT NULL,
            value TEXT NOT NULL,
            normalized_value TEXT NOT NULL,
            is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
            source TEXT,
            UNIQUE(scheme, normalized_value)
        );

        CREATE TABLE project_papers (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
            status TEXT NOT NULL
                CHECK(status IN ('discovered', 'included', 'excluded', 'archived')),
            roles_json TEXT NOT NULL DEFAULT '[]',
            summary TEXT,
            contributions_json TEXT NOT NULL DEFAULT '[]',
            relevance TEXT,
            reading_focus_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(project_id, paper_id)
        );

        CREATE TABLE paper_legacy (
            project_paper_id TEXT PRIMARY KEY REFERENCES project_papers(id) ON DELETE CASCADE,
            original_stable_key TEXT,
            organization TEXT,
            relations_text TEXT,
            authors_incomplete INTEGER NOT NULL DEFAULT 0 CHECK(authors_incomplete IN (0, 1))
        );

        CREATE TABLE resources (
            id TEXT PRIMARY KEY,
            paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
            format TEXT NOT NULL CHECK(format IN ('pdf', 'tex')),
            representation TEXT NOT NULL
                CHECK(representation IN ('original', 'translated', 'bilingual')),
            origin TEXT NOT NULL
                CHECK(origin IN ('publisher', 'preprint', 'author', 'user', 'generated', 'legacy')),
            source_url TEXT,
            filename TEXT NOT NULL,
            media_type TEXT NOT NULL,
            relative_path TEXT NOT NULL UNIQUE,
            sha256 TEXT NOT NULL,
            size INTEGER NOT NULL CHECK(size > 0),
            preferred INTEGER NOT NULL DEFAULT 0 CHECK(preferred IN (0, 1)),
            parent_resource_id TEXT REFERENCES resources(id),
            job_id TEXT REFERENCES jobs(id),
            created_at TEXT NOT NULL
        );

        CREATE TABLE jobs (
            id TEXT PRIMARY KEY,
            paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
            operation TEXT NOT NULL CHECK(operation IN ('compile', 'translate')),
            input_resource_id TEXT REFERENCES resources(id),
            status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
            progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
            options_json TEXT NOT NULL DEFAULT '{}',
            tool TEXT,
            tool_version TEXT,
            message TEXT NOT NULL DEFAULT '',
            log_excerpt TEXT,
            error_summary TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT
        );

        CREATE INDEX idx_project_papers_project ON project_papers(project_id);
        CREATE INDEX idx_project_papers_paper ON project_papers(paper_id);
        CREATE INDEX idx_resources_paper ON resources(paper_id);
        CREATE INDEX idx_jobs_paper ON jobs(paper_id);
        CREATE UNIQUE INDEX idx_resources_one_preferred
            ON resources(paper_id, format, representation) WHERE preferred = 1;
        CREATE UNIQUE INDEX idx_jobs_one_active_operation
            ON jobs(paper_id, operation) WHERE status IN ('queued', 'running');
        """
    )

    old_rows = connection.execute("SELECT * FROM legacy_papers ORDER BY created_at, id").fetchall()
    paper_for_identity: dict[str, str] = {}
    old_to_new: dict[str, str] = {}
    project_memberships: set[tuple[str, str]] = set()

    for row in old_rows:
        identity_key, scheme, identifier = _identity(row["stable_key"], row["stable_url"])
        paper_id = paper_for_identity.get(identity_key)
        authors = json.loads(row["authors_json"])
        authors_complete = not any("et al." in author.lower() for author in authors)
        if paper_id is None:
            paper_id = row["id"]
            paper_for_identity[identity_key] = paper_id
            connection.execute(
                """
                INSERT INTO papers(
                    id, identity_key, title, title_zh, authors_json, authors_complete,
                    abstract, publication_year, venue, publication_state, links_json,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
                """,
                (
                    paper_id,
                    identity_key,
                    row["title_en"],
                    row["title_zh"] or None,
                    row["authors_json"],
                    int(authors_complete),
                    row["publication_year"],
                    row["publication_status"] or None,
                    _publication_state(row["publication_status"]),
                    _links(row),
                    row["created_at"],
                    row["updated_at"],
                ),
            )
            connection.execute(
                """
                INSERT INTO paper_identifiers(
                    id, paper_id, scheme, value, normalized_value, is_primary, source
                ) VALUES (?, ?, ?, ?, ?, 1, 'legacy-migration')
                """,
                (_id(), paper_id, scheme, identifier, identifier.lower()),
            )
        old_to_new[row["id"]] = paper_id
        membership_key = (row["project_id"], paper_id)
        if membership_key in project_memberships:
            continue
        project_memberships.add(membership_key)
        project_paper_id = row["id"]
        connection.execute(
            """
            INSERT INTO project_papers(
                id, project_id, paper_id, status, roles_json, summary,
                contributions_json, relevance, reading_focus_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_paper_id,
                row["project_id"],
                paper_id,
                row["status"],
                json.dumps([row["paper_type"]], ensure_ascii=False),
                row["main_method"] or None,
                json.dumps(
                    [row["contribution"]] if row["contribution"] else [], ensure_ascii=False
                ),
                row["selection_reason"] or None,
                json.dumps(
                    [row["reading_focus"]] if row["reading_focus"] else [], ensure_ascii=False
                ),
                row["created_at"],
                row["updated_at"],
            ),
        )
        connection.execute(
            """
            INSERT INTO paper_legacy(
                project_paper_id, original_stable_key, organization,
                relations_text, authors_incomplete
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                project_paper_id,
                row["stable_key"],
                row["organization"],
                row["relations_text"],
                int(not authors_complete),
            ),
        )

    preferred: set[tuple[str, str]] = set()
    kind_map = {"original": "original", "chinese": "translated", "bilingual": "bilingual"}
    for row in connection.execute("SELECT * FROM legacy_artifacts ORDER BY created_at, id"):
        paper_id = old_to_new[row["paper_id"]]
        representation = kind_map[row["kind"]]
        key = (paper_id, representation)
        is_preferred = key not in preferred
        preferred.add(key)
        connection.execute(
            """
            INSERT INTO resources(
                id, paper_id, format, representation, origin, source_url, filename,
                media_type, relative_path, sha256, size, preferred,
                parent_resource_id, job_id, created_at
            ) VALUES (
                ?, ?, 'pdf', ?, 'legacy', NULL, ?, 'application/pdf',
                ?, ?, ?, ?, NULL, NULL, ?
            )
            """,
            (
                row["id"],
                paper_id,
                representation,
                row["relative_path"].rsplit("/", 1)[-1],
                row["relative_path"],
                row["sha256"],
                row["size"],
                int(is_preferred),
                row["created_at"],
            ),
        )

    for row in connection.execute("SELECT * FROM legacy_jobs ORDER BY created_at, id"):
        connection.execute(
            """
            INSERT INTO jobs(
                id, paper_id, operation, input_resource_id, status, progress,
                options_json, tool, tool_version, message, log_excerpt, error_summary,
                created_at, started_at, finished_at
            ) VALUES (?, ?, 'translate', NULL, ?, ?, '{}', 'pdf2zh', NULL, ?, NULL, ?, ?, ?, ?)
            """,
            (
                row["id"],
                old_to_new[row["paper_id"]],
                row["status"],
                row["progress"],
                row["message"],
                row["error_summary"],
                row["created_at"],
                row["started_at"],
                row["finished_at"],
            ),
        )

    connection.execute("DROP TABLE legacy_artifacts")
    connection.execute("DROP TABLE legacy_jobs")
    connection.execute("DROP TABLE legacy_papers")

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import closing

import pytest

from app.legacy.v2_importer import migrate_v2_database
from app.platform.activation import recover_pending_activation
from app.platform.db import DatabaseKind, V3Database, inspect_database
from tests.sample_data import PDF


class _SimulatedProcessCrash(BaseException):
    pass


def _create_v2_workspace(path, data_dir):
    # Keep the retired v2 contract local to this importer test. Production code has
    # exactly one schema baseline and must not retain an executable v2 migration stack.
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.executescript(
            """
            PRAGMA foreign_keys=ON;
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE papers (
                id TEXT PRIMARY KEY,
                identity_key TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                title_zh TEXT,
                authors_json TEXT NOT NULL,
                authors_complete INTEGER NOT NULL,
                abstract TEXT,
                publication_year INTEGER,
                venue TEXT,
                publication_state TEXT NOT NULL,
                links_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE paper_identifiers (
                id TEXT PRIMARY KEY,
                paper_id TEXT NOT NULL REFERENCES papers(id),
                scheme TEXT NOT NULL,
                value TEXT NOT NULL,
                normalized_value TEXT NOT NULL,
                is_primary INTEGER NOT NULL,
                source TEXT
            );
            CREATE TABLE project_papers (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id),
                paper_id TEXT NOT NULL REFERENCES papers(id),
                status TEXT NOT NULL,
                roles_json TEXT NOT NULL,
                summary TEXT,
                contributions_json TEXT NOT NULL,
                relevance TEXT,
                reading_focus_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE paper_legacy (
                project_paper_id TEXT PRIMARY KEY REFERENCES project_papers(id),
                original_stable_key TEXT,
                organization TEXT,
                relations_text TEXT,
                authors_incomplete INTEGER NOT NULL
            );
            CREATE TABLE resources (
                id TEXT PRIMARY KEY,
                paper_id TEXT NOT NULL REFERENCES papers(id),
                format TEXT NOT NULL,
                representation TEXT NOT NULL,
                origin TEXT NOT NULL,
                source_url TEXT,
                filename TEXT NOT NULL,
                media_type TEXT NOT NULL,
                relative_path TEXT NOT NULL UNIQUE,
                sha256 TEXT NOT NULL,
                size INTEGER NOT NULL,
                preferred INTEGER NOT NULL,
                parent_resource_id TEXT REFERENCES resources(id),
                job_id TEXT REFERENCES jobs(id),
                created_at TEXT NOT NULL
            );
            CREATE TABLE jobs (
                id TEXT PRIMARY KEY,
                paper_id TEXT NOT NULL REFERENCES papers(id),
                operation TEXT NOT NULL,
                input_resource_id TEXT REFERENCES resources(id),
                status TEXT NOT NULL,
                progress INTEGER NOT NULL,
                options_json TEXT NOT NULL,
                tool TEXT,
                tool_version TEXT,
                message TEXT NOT NULL,
                log_excerpt TEXT,
                error_summary TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT
            );
            """
        )
    relative_original = "artifacts/paper-1/resource-original/paper.pdf"
    relative_translated = "artifacts/paper-1/resource-translated/paper-zh.pdf"
    for relative_path in (relative_original, relative_translated):
        target = data_dir / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(PDF)
    digest = hashlib.sha256(PDF).hexdigest()
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO projects VALUES('project-1', 'Legacy', '', ?, ?)",
            ("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
        )
        connection.execute(
            """
            INSERT INTO papers(
                id, identity_key, title, title_zh, authors_json, authors_complete,
                abstract, publication_year, venue, publication_state, links_json,
                created_at, updated_at
            ) VALUES(
                'paper-1', 'arxiv:2601.01234', 'Legacy Paper', '旧论文',
                '["Ada Example et al."]', 0, NULL, 2026, 'arXiv', 'preprint',
                '[{"type":"paper","url":"https://arxiv.org/abs/2601.01234"}]',
                '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO paper_identifiers(
                id, paper_id, scheme, value, normalized_value, is_primary, source
            ) VALUES(
                'identifier-1', 'paper-1', 'arxiv', '2601.01234v2',
                '2601.01234', 1, 'legacy-migration'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO project_papers(
                id, project_id, paper_id, status, roles_json, summary,
                contributions_json, relevance, reading_focus_json,
                created_at, updated_at
            ) VALUES(
                'membership-1', 'project-1', 'paper-1', 'included', '["方法"]',
                'summary', '["contribution"]', 'relevant', '["focus"]',
                '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO paper_legacy(
                project_paper_id, original_stable_key, organization,
                relations_text, authors_incomplete
            ) VALUES(
                'membership-1', 'arxiv:2601.01234', 'Legacy Org',
                'legacy relation text', 1
            )
            """
        )
        connection.execute(
            """
            INSERT INTO resources(
                id, paper_id, format, representation, origin, filename,
                media_type, relative_path, sha256, size, preferred, created_at
            ) VALUES(
                'resource-original', 'paper-1', 'pdf', 'original', 'legacy',
                'paper.pdf', 'application/pdf', ?, ?, ?, 1,
                '2026-01-01T00:00:00Z'
            )
            """,
            (relative_original, digest, len(PDF)),
        )
        connection.execute(
            """
            INSERT INTO jobs(
                id, paper_id, operation, input_resource_id, status, progress,
                options_json, tool, tool_version, message, log_excerpt,
                created_at, started_at, finished_at
            ) VALUES(
                'job-1', 'paper-1', 'translate', 'resource-original', 'succeeded', 100,
                '{}', 'pdf2zh', '2.9.0', 'done', 'legacy log',
                '2026-01-02T00:00:00Z', '2026-01-02T00:01:00Z',
                '2026-01-02T00:02:00Z'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO resources(
                id, paper_id, format, representation, origin, filename,
                media_type, relative_path, sha256, size, preferred,
                parent_resource_id, job_id, created_at
            ) VALUES(
                'resource-translated', 'paper-1', 'pdf', 'translated', 'generated',
                'paper-zh.pdf', 'application/pdf', ?, ?, ?, 1,
                'resource-original', 'job-1', '2026-01-02T00:02:00Z'
            )
            """,
            (relative_translated, digest, len(PDF)),
        )


def test_v2_is_imported_through_a_validated_shadow_database(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    path = data_dir / "research.sqlite3"
    _create_v2_workspace(path, data_dir)

    report = migrate_v2_database(path, data_dir=data_dir)

    assert report.counts.projects == 1
    assert report.counts.works == 1
    assert report.counts.attachments == 2
    assert report.files_verified == 2
    assert report.backup_database is not None
    assert inspect_database(path).kind is DatabaseKind.V4
    assert inspect_database(report.backup_database).kind is DatabaseKind.LEGACY_V2

    database = V3Database(path)
    database.verify()
    with database.read() as connection:
        item = connection.execute("SELECT * FROM bibliographic_items WHERE id='paper-1'").fetchone()
        creator = connection.execute(
            "SELECT * FROM item_creators WHERE item_id='paper-1'"
        ).fetchone()
        attachments = connection.execute(
            """
            SELECT a.id, b.sha256, b.size, o.storage_key
            FROM attachments a
            JOIN blobs b ON b.id = a.blob_id
            JOIN blob_objects o ON o.blob_id = b.id
            ORDER BY a.id, o.storage_key
            """
        ).fetchall()
        source = connection.execute(
            "SELECT payload_json FROM source_records WHERE provider='legacy-v2'"
        ).fetchone()
        roles = connection.execute("SELECT role FROM job_attachments ORDER BY role").fetchall()
    assert item["title"] == "Legacy Paper"
    assert creator["creator_type"] == "literal"
    assert creator["literal_name"] == "Ada Example et al."
    assert creator["raw_name"] == "Ada Example et al."
    assert creator["given_name"] is None
    assert creator["family_name"] is None
    assert {row["id"] for row in attachments} == {
        "resource-original",
        "resource-translated",
    }
    assert all(row["sha256"] == hashlib.sha256(PDF).hexdigest() for row in attachments)
    raw = json.loads(source["payload_json"])
    assert raw["project_memberships"][0]["legacy"]["organization"] == "Legacy Org"
    assert [row["role"] for row in roles] == ["input", "output"]


def test_v2_activation_is_replayed_after_process_crash_in_rename_window(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    database_path = data_dir / "research.sqlite3"
    journal_path = tmp_path / ".runtime" / "workspace-activation.json"
    _create_v2_workspace(database_path, data_dir)

    def crash(point: str) -> None:
        if point == "v2.after_source_moved":
            raise _SimulatedProcessCrash

    with pytest.raises(_SimulatedProcessCrash):
        migrate_v2_database(
            database_path,
            data_dir=data_dir,
            activation_journal=journal_path,
            fault_injector=crash,
        )

    assert not database_path.exists()
    assert journal_path.is_file()

    recovered = recover_pending_activation(
        journal_path,
        data_dir=data_dir,
        database_path=database_path,
    )

    assert recovered == "v2_migration:committed"
    assert inspect_database(database_path).kind is DatabaseKind.V4
    assert not journal_path.exists()
    backups = list(data_dir.glob("research.sqlite3.v2-*.bak"))
    assert len(backups) == 1
    assert inspect_database(backups[0]).kind is DatabaseKind.LEGACY_V2

ALTER TABLE bibliographic_items
    ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);

CREATE TABLE item_revisions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    change_set_id TEXT REFERENCES change_sets(id) ON DELETE SET NULL,
    changes_json TEXT NOT NULL CHECK(json_valid(changes_json)),
    evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
    created_at TEXT NOT NULL,
    UNIQUE(item_id, revision)
) STRICT;

CREATE TABLE change_sets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN (
        'metadata_patch', 'resource_acquisition',
        'project_insights', 'zotero_conflict_resolution'
    )),
    status TEXT NOT NULL CHECK(status IN (
        'draft', 'submitted', 'partially_applied', 'applied',
        'rejected', 'stale', 'failed'
    )),
    agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    item_id TEXT REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    source_version TEXT,
    content_hash TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    submitted_at TEXT,
    reviewed_at TEXT,
    reviewed_by TEXT,
    applied_at TEXT,
    UNIQUE(agent_run_id, content_hash)
) STRICT;

CREATE INDEX idx_change_sets_status_created ON change_sets(status, created_at);
CREATE INDEX idx_change_sets_project_status ON change_sets(project_id, status);
CREATE INDEX idx_change_sets_item_status ON change_sets(item_id, status);

CREATE TABLE change_items (
    id TEXT PRIMARY KEY,
    change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    operation TEXT NOT NULL CHECK(operation IN (
        'metadata.patch', 'resource.acquire',
        'project.insight.patch', 'zotero.conflict.resolve'
    )),
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    base_revision TEXT,
    status TEXT NOT NULL CHECK(status IN (
        'proposed', 'approved', 'rejected', 'applied', 'stale', 'failed'
    )),
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
    rationale TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    applied_at TEXT,
    UNIQUE(change_set_id, position)
) STRICT;

CREATE INDEX idx_change_items_set_status ON change_items(change_set_id, status, position);

CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    source_attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    source_sha256 TEXT NOT NULL,
    extractor TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    structure_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('extracting', 'ready', 'failed', 'superseded')),
    language TEXT,
    page_count INTEGER CHECK(page_count IS NULL OR page_count > 0),
    block_count INTEGER NOT NULL DEFAULT 0 CHECK(block_count >= 0),
    structure_hash TEXT,
    created_by_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(source_attachment_id, source_sha256, extractor, extractor_version)
) STRICT;

CREATE INDEX idx_documents_item_status ON documents(item_id, status, created_at);

CREATE TABLE document_blocks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES document_blocks(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    kind TEXT NOT NULL CHECK(kind IN (
        'title', 'heading', 'paragraph', 'list', 'formula',
        'table', 'figure', 'footnote', 'reference', 'other'
    )),
    semantic_role TEXT CHECK(semantic_role IS NULL OR semantic_role IN (
        'background', 'question', 'method', 'evidence',
        'result', 'limitation', 'conclusion', 'other'
    )),
    source_text TEXT NOT NULL DEFAULT '',
    source_sha256 TEXT NOT NULL,
    page_start INTEGER CHECK(page_start IS NULL OR page_start > 0),
    page_end INTEGER CHECK(page_end IS NULL OR page_end > 0),
    anchor_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(anchor_json)),
    section_path_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(section_path_json)),
    created_at TEXT NOT NULL,
    UNIQUE(document_id, ordinal),
    CHECK(page_end IS NULL OR page_start IS NULL OR page_end >= page_start)
) STRICT;

CREATE INDEX idx_document_blocks_document ON document_blocks(document_id, ordinal);
CREATE INDEX idx_document_blocks_parent ON document_blocks(parent_id, ordinal);

CREATE TABLE block_translations (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES document_blocks(id) ON DELETE CASCADE,
    target_language TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    validation_status TEXT NOT NULL CHECK(validation_status IN ('verified', 'invalid')),
    created_by_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE(block_id, target_language, source_sha256, provider, model, prompt_version)
) STRICT;

CREATE INDEX idx_block_translations_block_language
    ON block_translations(block_id, target_language, created_at);

CREATE TABLE document_glossary_entries (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    target_language TEXT NOT NULL,
    source_term TEXT NOT NULL,
    translated_term TEXT NOT NULL,
    note TEXT,
    batch_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(document_id, target_language, source_term)
) STRICT;

CREATE TABLE annotations (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
    block_id TEXT REFERENCES document_blocks(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK(kind IN (
        'highlight', 'excerpt', 'question', 'claim',
        'method', 'result', 'limitation', 'bibliographic_note'
    )),
    body TEXT NOT NULL DEFAULT '',
    quoted_text TEXT,
    source_sha256 TEXT,
    page_number INTEGER CHECK(page_number IS NULL OR page_number > 0),
    anchor_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(anchor_json)),
    anchor_status TEXT NOT NULL DEFAULT 'valid'
        CHECK(anchor_status IN ('valid', 'stale', 'unresolved')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_annotations_project_item ON annotations(project_id, item_id, created_at);
CREATE INDEX idx_annotations_block ON annotations(block_id, created_at);

CREATE TABLE annotation_tags (
    annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY(annotation_id, tag)
) WITHOUT ROWID, STRICT;

CREATE TABLE reading_states (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
    block_id TEXT REFERENCES document_blocks(id) ON DELETE SET NULL,
    page_number INTEGER CHECK(page_number IS NULL OR page_number > 0),
    progress REAL NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 1),
    bookmarks_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(bookmarks_json)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id, item_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE user_preferences (
    id TEXT PRIMARY KEY CHECK(id = 'singleton'),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    preferences_json TEXT NOT NULL CHECK(json_valid(preferences_json)),
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE device_pairings (
    id TEXT PRIMARY KEY,
    code_digest TEXT NOT NULL UNIQUE,
    label TEXT,
    expires_at TEXT NOT NULL,
    claimed_at TEXT,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE device_sessions (
    id TEXT PRIMARY KEY,
    token_digest TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
) STRICT;

CREATE INDEX idx_device_sessions_active ON device_sessions(revoked_at, expires_at);

INSERT INTO item_revisions(
    id, item_id, revision, actor_type, actor_id, change_set_id,
    changes_json, evidence_json, created_at
)
SELECT
    id || ':revision:1',
    id,
    1,
    'system',
    'v3-migrator',
    NULL,
    json_object(
        'snapshot', json_object(
            'item_type', item_type,
            'title', title,
            'short_title', short_title,
            'translated_title', translated_title,
            'abstract', abstract,
            'language', language,
            'issued_year', issued_year,
            'issued_month', issued_month,
            'issued_day', issued_day,
            'container_title', container_title,
            'publisher', publisher,
            'place', place,
            'volume', volume,
            'issue', issue,
            'pages', pages,
            'edition', edition,
            'series', series,
            'publication_state', publication_state
        )
    ),
    '[]',
    updated_at
FROM bibliographic_items;

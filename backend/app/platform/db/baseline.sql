PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_records (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    external_key TEXT,
    source_url TEXT,
    retrieved_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    payload_sha256 TEXT NOT NULL,
    schema_version TEXT,
    UNIQUE(provider, external_key, payload_sha256)
) STRICT;

CREATE TABLE works (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE bibliographic_items (
    id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL,
    title TEXT NOT NULL,
    short_title TEXT,
    translated_title TEXT,
    abstract TEXT,
    language TEXT,
    issued_year INTEGER CHECK(issued_year IS NULL OR issued_year BETWEEN 1000 AND 3000),
    issued_month INTEGER CHECK(issued_month IS NULL OR issued_month BETWEEN 1 AND 12),
    issued_day INTEGER CHECK(issued_day IS NULL OR issued_day BETWEEN 1 AND 31),
    issued_literal TEXT,
    container_title TEXT,
    publisher TEXT,
    place TEXT,
    volume TEXT,
    issue TEXT,
    pages TEXT,
    edition TEXT,
    series TEXT,
    publication_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK(publication_state IN (
            'preprint', 'submitted', 'accepted', 'published', 'retracted', 'unknown'
        )),
    creator_list_complete INTEGER NOT NULL DEFAULT 1
        CHECK(creator_list_complete IN (0, 1)),
    is_preferred_for_work INTEGER NOT NULL DEFAULT 0
        CHECK(is_preferred_for_work IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_items_one_preferred_per_work
    ON bibliographic_items(work_id) WHERE is_preferred_for_work = 1;
CREATE INDEX idx_items_work ON bibliographic_items(work_id);
CREATE INDEX idx_items_issued_year ON bibliographic_items(issued_year);
CREATE INDEX idx_items_title ON bibliographic_items(title COLLATE NOCASE);

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

CREATE TABLE item_creators (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    role TEXT NOT NULL DEFAULT 'author',
    creator_type TEXT NOT NULL
        CHECK(creator_type IN ('person', 'organization', 'literal')),
    given_name TEXT,
    family_name TEXT,
    literal_name TEXT,
    suffix TEXT,
    orcid TEXT,
    raw_name TEXT NOT NULL,
    source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
    CHECK(
        literal_name IS NOT NULL OR given_name IS NOT NULL OR family_name IS NOT NULL
    ),
    UNIQUE(item_id, role, position)
) STRICT;

CREATE INDEX idx_item_creators_item ON item_creators(item_id, role, position);
CREATE INDEX idx_item_creators_family ON item_creators(family_name COLLATE NOCASE);

CREATE TABLE item_identifiers (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    scheme TEXT NOT NULL,
    value TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    version TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
    is_identity INTEGER NOT NULL DEFAULT 1 CHECK(is_identity IN (0, 1)),
    source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
    UNIQUE(item_id, scheme, normalized_value)
) STRICT;

CREATE UNIQUE INDEX idx_item_identifiers_identity
    ON item_identifiers(scheme, normalized_value) WHERE is_identity = 1;
CREATE INDEX idx_item_identifiers_item ON item_identifiers(item_id);

CREATE TABLE item_links (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    accessed_at TEXT,
    source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
    UNIQUE(item_id, relation_type, url)
) STRICT;

CREATE INDEX idx_item_links_item ON item_links(item_id);

CREATE TABLE item_tags (
    item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'keyword',
    source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
    PRIMARY KEY(item_id, tag, kind)
) WITHOUT ROWID, STRICT;

CREATE TABLE item_field_sources (
    item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    field_path TEXT NOT NULL,
    source_record_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
    value_sha256 TEXT NOT NULL,
    selected_at TEXT NOT NULL,
    PRIMARY KEY(item_id, field_path)
) WITHOUT ROWID, STRICT;

CREATE TABLE item_relations (
    source_item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    target_item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL CHECK(relation_type IN (
        'published_as', 'preprint_of', 'translation_of', 'correction_of',
        'supplement_to', 'duplicate_of', 'related'
    )),
    created_at TEXT NOT NULL,
    CHECK(source_item_id != target_item_id),
    PRIMARY KEY(source_item_id, target_item_id, relation_type)
) WITHOUT ROWID, STRICT;

CREATE TABLE project_works (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN (
        'discovered', 'included', 'excluded', 'archived'
    )),
    summary TEXT,
    relevance TEXT,
    decided_at TEXT,
    decided_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, work_id)
) STRICT;

CREATE INDEX idx_project_works_project_status ON project_works(project_id, status);
CREATE INDEX idx_project_works_work ON project_works(work_id);

CREATE TABLE project_work_roles (
    project_work_id TEXT NOT NULL REFERENCES project_works(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    PRIMARY KEY(project_work_id, role)
) WITHOUT ROWID, STRICT;

CREATE TABLE project_work_notes (
    id TEXT PRIMARY KEY,
    project_work_id TEXT NOT NULL REFERENCES project_works(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('contribution', 'reading_focus')),
    position INTEGER NOT NULL CHECK(position >= 0),
    text TEXT NOT NULL,
    UNIQUE(project_work_id, kind, position)
) STRICT;

CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    item_id TEXT REFERENCES bibliographic_items(id) ON DELETE SET NULL,
    target_type TEXT,
    target_id TEXT,
    task_kind TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'created', 'starting', 'running', 'waiting_approval',
        'cancellation_requested', 'canceled', 'completed', 'failed'
    )),
    prompt TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    context_hash TEXT NOT NULL,
    cwd TEXT NOT NULL,
    tool_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tool_scopes_json)),
    runtime TEXT NOT NULL,
    runtime_version TEXT,
    model TEXT,
    reasoning_effort TEXT CHECK(reasoning_effort IS NULL OR reasoning_effort IN (
        'low', 'medium', 'high', 'xhigh'
    )),
    provider_thread_id TEXT,
    provider_turn_id TEXT,
    final_message TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    cancel_requested_at TEXT
) STRICT;

CREATE INDEX idx_agent_runs_status ON agent_runs(status, created_at);
CREATE INDEX idx_agent_runs_project_status ON agent_runs(project_id, status);

CREATE TABLE agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'public',
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_agent_events_stream ON agent_events(run_id, id);

CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    provider_request_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'expired')),
    approvable INTEGER NOT NULL CHECK(approvable IN (0, 1)),
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    decision TEXT CHECK(decision IN ('approve', 'deny', 'cancel')),
    created_at TEXT NOT NULL,
    decided_at TEXT,
    UNIQUE(run_id, provider_request_id)
) STRICT;

CREATE INDEX idx_approvals_run_status ON approvals(run_id, status);

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
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    rationale TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    applied_at TEXT,
    UNIQUE(change_set_id, position)
) STRICT;

CREATE INDEX idx_change_items_set_status ON change_items(change_set_id, status, position);

CREATE TABLE discovery_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'cancelled')),
    query_json TEXT NOT NULL CHECK(json_valid(query_json)),
    created_at TEXT NOT NULL,
    finished_at TEXT
) STRICT;

CREATE TABLE candidates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    discovery_session_id TEXT REFERENCES discovery_sessions(id) ON DELETE SET NULL,
    source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
    state TEXT NOT NULL CHECK(state IN ('staged', 'matched', 'promoted', 'dismissed')),
    proposed_item_json TEXT NOT NULL CHECK(json_valid(proposed_item_json)),
    dedupe_key TEXT,
    matched_work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
    rank REAL,
    rationale TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
) STRICT;

CREATE INDEX idx_candidates_project_state ON candidates(project_id, state, created_at);
CREATE INDEX idx_candidates_dedupe ON candidates(project_id, dedupe_key);

CREATE TABLE blobs (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL CHECK(size > 0),
    media_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    verified_at TEXT
) STRICT;

CREATE TABLE blob_objects (
    id TEXT PRIMARY KEY,
    blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
    storage_backend TEXT NOT NULL DEFAULT 'local',
    storage_key TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
    state TEXT NOT NULL DEFAULT 'available'
        CHECK(state IN ('staged', 'available', 'missing', 'quarantined')),
    created_at TEXT NOT NULL,
    UNIQUE(storage_backend, storage_key)
) STRICT;

CREATE UNIQUE INDEX idx_blob_objects_one_primary
    ON blob_objects(blob_id) WHERE is_primary = 1;

CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    blob_id TEXT NOT NULL REFERENCES blobs(id),
    created_by_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    operation_role TEXT,
    attachment_type TEXT NOT NULL,
    format TEXT NOT NULL,
    language_mode TEXT NOT NULL CHECK(language_mode IN ('original', 'translated', 'bilingual')),
    origin TEXT NOT NULL,
    filename TEXT NOT NULL,
    source_url TEXT,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_attachments_item ON attachments(item_id, format, language_mode);
CREATE INDEX idx_attachments_blob ON attachments(blob_id);
CREATE UNIQUE INDEX idx_attachments_job_role
    ON attachments(created_by_job_id, operation_role)
    WHERE created_by_job_id IS NOT NULL AND operation_role IS NOT NULL;

CREATE TABLE attachment_preferences (
    item_id TEXT NOT NULL REFERENCES bibliographic_items(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(item_id, purpose)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER attachment_preferences_insert_item_guard
BEFORE INSERT ON attachment_preferences
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM attachments
        WHERE id = NEW.attachment_id AND item_id = NEW.item_id
    ) THEN RAISE(ABORT, 'attachment preference item mismatch') END;
END;

CREATE TRIGGER attachment_preferences_update_item_guard
BEFORE UPDATE ON attachment_preferences
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM attachments
        WHERE id = NEW.attachment_id AND item_id = NEW.item_id
    ) THEN RAISE(ABORT, 'attachment preference item mismatch') END;
END;

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject_type TEXT,
    subject_id TEXT,
    status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'cancellation_requested', 'canceled', 'succeeded', 'failed'
    )),
    requested_by_type TEXT NOT NULL DEFAULT 'system',
    requested_by_id TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    input_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(input_json)),
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    error_code TEXT,
    error_message TEXT,
    idempotency_key TEXT,
    concurrency_key TEXT,
    max_attempts INTEGER NOT NULL DEFAULT 1 CHECK(max_attempts BETWEEN 1 AND 20),
    lease_owner TEXT,
    lease_expires_at TEXT,
    heartbeat_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    available_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    cancel_requested_at TEXT
) STRICT;

CREATE UNIQUE INDEX idx_jobs_idempotency
    ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_jobs_active_concurrency
    ON jobs(concurrency_key)
    WHERE concurrency_key IS NOT NULL
      AND status IN ('queued', 'running', 'cancellation_requested');
CREATE INDEX idx_jobs_queue ON jobs(status, priority DESC, available_at, created_at);
CREATE INDEX idx_jobs_subject ON jobs(subject_type, subject_id);

CREATE TABLE job_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
    worker_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'running', 'succeeded', 'failed', 'canceled', 'interrupted'
    )),
    process_id INTEGER,
    executable TEXT,
    exit_code INTEGER,
    error_message TEXT,
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    finished_at TEXT,
    -- Additional immutable execution evidence retained by the process adapter.
    tool_name TEXT,
    tool_version TEXT,
    command_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(command_json)),
    environment_keys_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(environment_keys_json)),
    working_directory TEXT,
    stdout_tail TEXT,
    stderr_tail TEXT,
    error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
    UNIQUE(job_id, attempt_number)
) STRICT;

CREATE TABLE job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES job_attempts(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE job_attachments (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES job_attempts(id) ON DELETE SET NULL,
    role TEXT NOT NULL,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    media_type TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    UNIQUE(job_id, role, attachment_id)
) STRICT;

CREATE INDEX idx_job_events_stream ON job_events(job_id, id);

CREATE TABLE attachment_relations (
    parent_attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    child_attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    CHECK(parent_attachment_id != child_attachment_id),
    PRIMARY KEY(parent_attachment_id, child_attachment_id, relation_type)
) WITHOUT ROWID, STRICT;

CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    correlation_id TEXT,
    before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
    after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json)),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json))
) STRICT;

CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id, occurred_at);
CREATE INDEX idx_audit_correlation ON audit_events(correlation_id);

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

CREATE TABLE translation_batch_checkpoints (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    batch_ordinal INTEGER NOT NULL CHECK(batch_ordinal >= 0),
    input_sha256 TEXT NOT NULL,
    output_json TEXT NOT NULL CHECK(json_valid(output_json)),
    provider_request_id TEXT,
    usage_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(usage_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(job_id, batch_ordinal)
) WITHOUT ROWID, STRICT;

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

CREATE TABLE external_bindings (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    library_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    external_key TEXT NOT NULL,
    external_version INTEGER,
    sync_hash TEXT,
    raw_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(raw_json)),
    last_synced_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider, library_id, external_key),
    UNIQUE(provider, library_id, entity_type, entity_id)
) STRICT;

CREATE TABLE sync_runs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    library_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('import', 'export', 'bidirectional')),
    status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'cancelled')),
    dry_run INTEGER NOT NULL DEFAULT 0 CHECK(dry_run IN (0, 1)),
    stats_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(stats_json)),
    error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
    created_at TEXT NOT NULL,
    finished_at TEXT
) STRICT;

CREATE TABLE sync_conflicts (
    id TEXT PRIMARY KEY,
    sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
    binding_id TEXT REFERENCES external_bindings(id) ON DELETE SET NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    field_path TEXT NOT NULL,
    local_json TEXT NOT NULL CHECK(json_valid(local_json)),
    remote_json TEXT NOT NULL CHECK(json_valid(remote_json)),
    status TEXT NOT NULL CHECK(status IN ('open', 'resolved_local', 'resolved_remote', 'merged')),
    resolution_json TEXT CHECK(resolution_json IS NULL OR json_valid(resolution_json)),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT
) STRICT;

CREATE TABLE zotero_transfer_previews (
    id TEXT PRIMARY KEY,
    preview_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('preview_ready', 'applying', 'finished')),
    preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    execution_started_at TEXT
) STRICT;

CREATE TABLE zotero_transfer_resolutions (
    preview_id TEXT NOT NULL REFERENCES zotero_transfer_previews(id) ON DELETE CASCADE,
    conflict_id TEXT NOT NULL,
    resolution_json TEXT NOT NULL CHECK(json_valid(resolution_json)),
    resolved_at TEXT NOT NULL,
    PRIMARY KEY(preview_id, conflict_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE zotero_transfer_receipts (
    preview_id TEXT PRIMARY KEY REFERENCES zotero_transfer_previews(id) ON DELETE CASCADE,
    id TEXT NOT NULL UNIQUE,
    preview_hash TEXT NOT NULL,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    finished_at TEXT NOT NULL
) STRICT;

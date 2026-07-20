PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    stable_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('discovered', 'included', 'excluded', 'archived')),
    title_en TEXT NOT NULL,
    title_zh TEXT NOT NULL,
    authors_json TEXT NOT NULL,
    organization TEXT,
    publication_year INTEGER NOT NULL,
    publication_status TEXT NOT NULL,
    paper_type TEXT NOT NULL,
    main_method TEXT NOT NULL,
    contribution TEXT NOT NULL,
    selection_reason TEXT NOT NULL,
    reading_focus TEXT NOT NULL,
    relations_text TEXT NOT NULL,
    stable_url TEXT NOT NULL,
    code_url TEXT,
    website_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, stable_key)
);

CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('original', 'chinese', 'bilingual')),
    relative_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(paper_id, kind)
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    error_summary TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_papers_project_id ON papers(project_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_paper_id ON artifacts(paper_id);
CREATE INDEX IF NOT EXISTS idx_jobs_paper_id ON jobs(paper_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_translation
ON jobs(paper_id)
WHERE job_type = 'translate' AND status IN ('queued', 'running');

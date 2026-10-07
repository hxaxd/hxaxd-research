import 'server-only';
import type Database from 'better-sqlite3';
export function initializeAppDatabase(db: Database.Database) {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS papers (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, pi_session_file TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation_runs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted','running','completed','cancelled','failed','interrupted')),
      started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS papers_workspace ON papers(workspace_id);
    CREATE INDEX IF NOT EXISTS conversations_workspace ON conversations(workspace_id);
    CREATE INDEX IF NOT EXISTS runs_conversation ON conversation_runs(conversation_id, started_at);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON conversation_runs(conversation_id) WHERE status IN ('accepted','running');
  `);
}

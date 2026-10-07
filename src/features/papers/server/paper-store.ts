import 'server-only';
import type Database from 'better-sqlite3';
import type { Paper } from '../paper-schema';
import { getWorkspace } from '@/features/workspaces/server/workspace-store';
import { ApiError } from '@/shared/http/api-error';
const fields = 'id, workspace_id AS workspaceId, name, created_at AS createdAt, updated_at AS updatedAt';
export function listPapers(db: Database.Database, workspaceId: string): Paper[] {
  getWorkspace(db, workspaceId);
  return db.prepare(`SELECT ${fields} FROM papers WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId) as Paper[];
}
export function getPaper(db: Database.Database, workspaceId: string, id: string): Paper {
  const row = db.prepare(`SELECT ${fields} FROM papers WHERE workspace_id = ? AND id = ?`).get(workspaceId, id) as Paper | undefined;
  if (!row) throw new ApiError(404, 'not_found', '论文不存在');
  return row;
}
export function renamePaper(db: Database.Database, workspaceId: string, id: string, name: string) {
  getPaper(db, workspaceId, id);
  db.prepare('UPDATE papers SET name = ?, updated_at = ? WHERE id = ?').run(name, new Date().toISOString(), id);
  return getPaper(db, workspaceId, id);
}

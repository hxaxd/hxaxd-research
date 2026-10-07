import 'server-only';
import type Database from 'better-sqlite3';
import type { Workspace } from '../workspace-schema';
import { ApiError } from '@/shared/http/api-error';
const fields = 'id, name, created_at AS createdAt, updated_at AS updatedAt';
export function listWorkspaces(db: Database.Database): Workspace[] { return db.prepare(`SELECT ${fields} FROM workspaces ORDER BY created_at DESC, id`).all() as Workspace[]; }
export function getWorkspace(db: Database.Database, id: string): Workspace {
  const row = db.prepare(`SELECT ${fields} FROM workspaces WHERE id = ?`).get(id) as Workspace | undefined;
  if (!row) throw new ApiError(404, 'not_found', '工作区不存在');
  return row;
}
export function renameWorkspace(db: Database.Database, id: string, name: string): Workspace {
  getWorkspace(db, id);
  db.prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?').run(name, new Date().toISOString(), id);
  return getWorkspace(db, id);
}

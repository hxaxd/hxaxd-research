import 'server-only';
import type Database from 'better-sqlite3';
import type { Conversation } from '../conversation-schema';
import { getWorkspace } from '@/features/workspaces/server/workspace-store';
import { ApiError } from '@/shared/http/api-error';
const fields = 'id, workspace_id AS workspaceId, name, created_at AS createdAt, updated_at AS updatedAt';
export function listConversations(db: Database.Database, workspaceId: string): Conversation[] {
  getWorkspace(db, workspaceId);
  return db.prepare(`SELECT ${fields} FROM conversations WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId) as Conversation[];
}
export function getConversation(db: Database.Database, workspaceId: string, id: string): Conversation {
  const row = db.prepare(`SELECT ${fields} FROM conversations WHERE workspace_id = ? AND id = ?`).get(workspaceId, id) as Conversation | undefined;
  if (!row) throw new ApiError(404, 'not_found', '对话不存在');
  return row;
}
export function renameConversation(db: Database.Database, workspaceId: string, id: string, name: string) {
  getConversation(db, workspaceId, id);
  db.prepare('UPDATE conversations SET name = ?, updated_at = ? WHERE id = ?').run(name, new Date().toISOString(), id);
  return getConversation(db, workspaceId, id);
}
export function getSessionFile(db: Database.Database, id: string): string | null {
  return (db.prepare('SELECT pi_session_file AS file FROM conversations WHERE id = ?').get(id) as { file: string | null }).file;
}
export function saveSessionFile(db: Database.Database, id: string, file: string) { db.prepare('UPDATE conversations SET pi_session_file = ? WHERE id = ?').run(file, id); }

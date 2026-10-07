import 'server-only';
import type Database from 'better-sqlite3';
import { getWorkspace } from '@/features/workspaces/server/workspace-store';
import { getConversation } from './conversation-store';
import { ApiError } from '@/shared/http/api-error';
export function createConversation(db: Database.Database, workspaceId: string, input: { id: string; name: string }) {
  getWorkspace(db, workspaceId);
  const existing = db.prepare('SELECT workspace_id, name FROM conversations WHERE id = ?').get(input.id) as { workspace_id: string; name: string } | undefined;
  if (existing) {
    if (existing.workspace_id !== workspaceId || existing.name !== input.name) throw new ApiError(409, 'conflict', '相同创建 ID 已用于其他对话');
    return getConversation(db, workspaceId, input.id);
  }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO conversations VALUES (?, ?, ?, NULL, ?, ?)').run(input.id, workspaceId, input.name, now, now);
  return getConversation(db, workspaceId, input.id);
}

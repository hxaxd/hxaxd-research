import 'server-only';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { getWorkspace } from '@/features/workspaces/server/workspace-store';
import { getPaper } from './paper-store';
import { ApiError } from '@/shared/http/api-error';
export function createPaper(db: Database.Database, workspaceDir: string, workspaceId: string, input: { id: string; name: string }) {
  getWorkspace(db, workspaceId);
  const existing = db.prepare('SELECT workspace_id, name FROM papers WHERE id = ?').get(input.id) as { workspace_id: string; name: string } | undefined;
  if (existing) {
    if (existing.workspace_id !== workspaceId || existing.name !== input.name) throw new ApiError(409, 'conflict', '相同创建 ID 已用于其他论文');
    return getPaper(db, workspaceId, input.id);
  }
  const directory = path.join(workspaceDir, workspaceId, 'papers', input.id);
  if (existsSync(directory)) throw new ApiError(409, 'conflict', '论文目录已存在但尚未登记，请先检查资料');
  mkdirSync(directory, { recursive: true });
  try {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO papers VALUES (?, ?, ?, ?, ?)').run(input.id, workspaceId, input.name, now, now);
  } catch (error) { rmdirSync(directory); throw error; }
  return getPaper(db, workspaceId, input.id);
}

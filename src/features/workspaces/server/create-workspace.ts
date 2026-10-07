import 'server-only';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { getWorkspace } from './workspace-store';
import { ApiError } from '@/shared/http/api-error';
export function createWorkspace(db: Database.Database, workspaceDir: string, input: { id: string; name: string }) {
  const existing = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(input.id) as { name: string } | undefined;
  if (existing) {
    if (existing.name !== input.name) throw new ApiError(409, 'conflict', '相同创建 ID 已用于其他名称');
    return getWorkspace(db, input.id);
  }
  const directory = path.join(workspaceDir, input.id);
  if (existsSync(directory)) throw new ApiError(409, 'conflict', '该目录已存在但尚未登记，请先检查资料');
  mkdirSync(directory, { recursive: true });
  try {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run(input.id, input.name, now, now);
  } catch (error) {
    rmdirSync(directory);
    throw error;
  }
  return getWorkspace(db, input.id);
}

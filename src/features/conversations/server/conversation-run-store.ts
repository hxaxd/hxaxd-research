import 'server-only';
import type Database from 'better-sqlite3';
import type { ConversationRun } from '../conversation-schema';
import { ApiError } from '@/shared/http/api-error';
const fields = 'id, conversation_id AS conversationId, status, started_at AS startedAt, finished_at AS finishedAt, error_code AS errorCode';
export function getRun(db: Database.Database, id: string): ConversationRun | null { return db.prepare(`SELECT ${fields} FROM conversation_runs WHERE id = ?`).get(id) as ConversationRun | undefined ?? null; }
export function latestRun(db: Database.Database, conversationId: string): ConversationRun | null { return db.prepare(`SELECT ${fields} FROM conversation_runs WHERE conversation_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(conversationId) as ConversationRun | undefined ?? null; }
export function acceptRun(db: Database.Database, conversationId: string, id: string, hash: string): { run: ConversationRun; isNew: boolean } {
  return db.transaction(() => {
    const existing = db.prepare('SELECT conversation_id, request_hash FROM conversation_runs WHERE id = ?').get(id) as { conversation_id: string; request_hash: string } | undefined;
    if (existing) {
      if (existing.conversation_id !== conversationId || existing.request_hash !== hash) throw new ApiError(409, 'conflict', '相同请求 ID 已用于其他内容');
      return { run: getRun(db, id)!, isNew: false };
    }
    if (db.prepare("SELECT 1 FROM conversation_runs WHERE conversation_id = ? AND status IN ('accepted','running')").get(conversationId)) throw new ApiError(409, 'busy', '当前对话正在回答，请等待或停止');
    db.prepare("INSERT INTO conversation_runs VALUES (?, ?, ?, 'accepted', ?, NULL, NULL)").run(id, conversationId, hash, new Date().toISOString());
    return { run: getRun(db, id)!, isNew: true };
  })();
}
export function startRun(db: Database.Database, id: string) { db.prepare("UPDATE conversation_runs SET status = 'running' WHERE id = ? AND status = 'accepted'").run(id); }
export function finishRun(db: Database.Database, id: string, status: 'completed' | 'cancelled' | 'failed', errorCode: string | null = null) {
  db.prepare("UPDATE conversation_runs SET status = ?, finished_at = ?, error_code = ? WHERE id = ? AND status IN ('accepted','running')").run(status, new Date().toISOString(), errorCode, id);
}
export function recoverInterruptedRuns(db: Database.Database) { db.prepare("UPDATE conversation_runs SET status = 'interrupted', finished_at = ?, error_code = 'process_interrupted' WHERE status IN ('accepted','running')").run(new Date().toISOString()); }

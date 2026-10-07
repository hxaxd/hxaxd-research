import 'server-only';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PiSessionRegistry } from '@/server/pi-session-registry';
import type { SendMessage } from '../conversation-schema';
import { getConversation } from './conversation-store';
import { acceptRun, finishRun, getRun } from './conversation-run-store';
import { buildMaterialContext } from './build-material-context';
import { ApiError } from '@/shared/http/api-error';
export async function sendConversationMessage(db: Database.Database, sessions: PiSessionRegistry, workspaceDir: string, workspaceId: string, conversationId: string, input: SendMessage) {
  getConversation(db, workspaceId, conversationId);
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  if (getRun(db, input.id)) return acceptRun(db, conversationId, input.id, hash).run;
  if (!(await sessions.models()).some(model => model.id === input.model)) throw new ApiError(503, 'model_unavailable', '模型未配置，请配置凭据后重启应用');
  const context = await buildMaterialContext(workspaceDir, workspaceId, input.text, input.materials);
  const accepted = acceptRun(db, conversationId, input.id, hash);
  if (accepted.isNew) {
    try { sessions.start(workspaceId, conversationId, accepted.run, input.model, context.prompt, context.versions); }
    catch (error) { finishRun(db, input.id, 'failed', 'session_failed'); throw error; }
  }
  return accepted.run;
}

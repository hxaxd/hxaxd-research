import 'server-only';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { ApiError } from '@/shared/http/api-error';
import type Database from 'better-sqlite3';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AppConfig } from '@/server/read-app-config';
import { getSessionFile, saveSessionFile } from './conversation-store';
import { mapPiMessage } from './map-pi-event';
import type { ChatMessage } from '../conversation-schema';
export function readConversationHistory(db: Database.Database, config: AppConfig, workspaceId: string, conversationId: string): ChatMessage[] {
  const directory = path.join(config.piDir, 'sessions', conversationId);
  const file = getSessionFile(db, conversationId);
  if (file && !existsSync(file)) throw new ApiError(500, 'history_missing', '对话历史文件不存在，请检查本地资料');
  const manager = file ? SessionManager.open(file, directory, path.join(config.workspaceDir, workspaceId)) : SessionManager.continueRecent(path.join(config.workspaceDir, workspaceId), directory);
  const messages = manager.getBranch().flatMap(entry => {
    if (entry.type !== 'message') return [];
    const message = mapPiMessage(entry.id, entry.message);
    return message ? [message] : [];
  });
  if (messages.length && manager.getSessionFile()) saveSessionFile(db, conversationId, manager.getSessionFile()!);
  return messages;
}

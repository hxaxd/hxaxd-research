import 'server-only';

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent';

import { getWorkspace } from '@/features/workspaces/server/workspaces';
import { ApiError } from '@/shared/http/api-error';

import type { Conversation } from '../schema';

function sessionDirectory(root: string, workspaceId: string) {
  return path.join(root, workspaceId, '.pi', 'sessions');
}

function conversation(info: SessionInfo, workspaceId: string): Conversation {
  return {
    id: info.id,
    workspaceId,
    name: info.name || '新对话',
    createdAt: info.created.toISOString(),
    updatedAt: info.modified.toISOString(),
  };
}

export async function listConversations(root: string, workspaceId: string) {
  getWorkspace(root, workspaceId);
  const sessions = await SessionManager.listAll(sessionDirectory(root, workspaceId));
  return sessions.map((info) => conversation(info, workspaceId));
}

export function openConversation(root: string, workspaceId: string, id: string) {
  getWorkspace(root, workspaceId);
  const cwd = path.join(root, workspaceId);
  const directory = sessionDirectory(root, workspaceId);
  const file = path.join(directory, `${id}.jsonl`);
  if (!existsSync(file)) throw new ApiError(404, 'not_found', '对话不存在');
  return SessionManager.open(file, directory, cwd);
}

export function getConversation(root: string, workspaceId: string, id: string): Conversation {
  const manager = openConversation(root, workspaceId, id);
  const timestamp = manager.getHeader()!.timestamp;
  const entries = manager.getEntries();
  return {
    id,
    workspaceId,
    name: manager.getSessionName() || '新对话',
    createdAt: timestamp,
    updatedAt: entries.at(-1)?.timestamp ?? timestamp,
  };
}

export function createConversation(
  root: string,
  workspaceId: string,
  input: { id: string; name: string },
) {
  getWorkspace(root, workspaceId);
  const directory = sessionDirectory(root, workspaceId);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${input.id}.jsonl`);
  if (existsSync(file)) throw new ApiError(409, 'conflict', '对话 ID 已存在');
  const manager = SessionManager.create(path.join(root, workspaceId), directory, { id: input.id });
  manager.appendSessionInfo(input.name);
  // Pi defers setup-only sessions; the workbench also keeps explicitly created empty conversations.
  writeFileSync(
    file,
    [manager.getHeader(), ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
    { flag: 'wx' },
  );
  return getConversation(root, workspaceId, input.id);
}

export function renameConversation(
  root: string,
  workspaceId: string,
  id: string,
  name: string,
  manager = openConversation(root, workspaceId, id),
) {
  manager.appendSessionInfo(name);
  return getConversation(root, workspaceId, id);
}

import 'server-only';

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { readWorkspace, saveWorkspace } from '@/features/workspaces/server/workspaces';
import { ApiError } from '@/shared/http/api-error';

export function listPapers(root: string, workspaceId: string) {
  return readWorkspace(root, workspaceId).papers.map((paper) => ({ ...paper, workspaceId }));
}

export function createPaper(
  root: string,
  workspaceId: string,
  input: { id: string; name: string },
) {
  const workspace = readWorkspace(root, workspaceId);
  if (workspace.papers.some((paper) => paper.id === input.id))
    throw new ApiError(409, 'conflict', '论文 ID 已存在');
  const now = new Date().toISOString();
  const paper = { ...input, path: `papers/${input.id}`, createdAt: now, updatedAt: now };
  mkdirSync(path.join(root, workspaceId, paper.path), { recursive: true });
  workspace.papers.push(paper);
  workspace.updatedAt = now;
  saveWorkspace(root, workspace);
  return { ...paper, workspaceId };
}

export function renamePaper(root: string, workspaceId: string, id: string, name: string) {
  const workspace = readWorkspace(root, workspaceId);
  const paper = workspace.papers.find((paper) => paper.id === id);
  if (!paper) throw new ApiError(404, 'not_found', '论文不存在');
  paper.name = name;
  paper.updatedAt = workspace.updatedAt = new Date().toISOString();
  saveWorkspace(root, workspace);
  return { ...paper, workspaceId };
}

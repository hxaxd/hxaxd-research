import 'server-only';

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ApiError } from '@/shared/http/api-error';

import { workspaceSchema, type Workspace } from '../schema';

export function getWorkspace(root: string, id: string): Workspace {
  const file = path.join(root, id, 'workspace.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ApiError(404, 'not_found', '工作区配置不存在');
    throw error;
  }
  try {
    const workspace = workspaceSchema.parse(JSON.parse(text));
    if (workspace.id !== id) throw new Error('工作区 ID 与目录名称不一致');
    return workspace;
  } catch (error) {
    throw new ApiError(
      422,
      'workspace_config_invalid',
      `${id}/workspace.json 无效：${(error as Error).message}`,
    );
  }
}

function saveWorkspace(root: string, workspace: Workspace) {
  writeFileSync(
    path.join(root, workspace.id, 'workspace.json'),
    `${JSON.stringify(workspace, null, 2)}\n`,
  );
}

export function getWorkspaceContext(root: string, id: string) {
  const workspace = getWorkspace(root, id);
  return {
    workspace: { id: workspace.id, name: workspace.name, root: '.' },
    paths: {
      metadata: 'workspace.json',
      description:
        '材料直接以文件系统为准，工作区可包含任意文件与子目录。原生工具接受绝对路径或相对默认工作目录的路径，实际权限由运行账号决定。',
    },
  };
}

export function listWorkspaces(root: string) {
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, 'workspace.json')),
    )
    .map((entry) => getWorkspace(root, entry.name))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createWorkspace(root: string, input: { id: string; name: string }) {
  const directory = path.join(root, input.id);
  if (existsSync(directory)) throw new ApiError(409, 'conflict', '工作区目录已存在');
  mkdirSync(directory);
  const now = new Date().toISOString();
  const workspace = { ...input, createdAt: now, updatedAt: now };
  saveWorkspace(root, workspace);
  return workspace;
}

export function renameWorkspace(root: string, id: string, name: string) {
  const workspace = { ...getWorkspace(root, id), name, updatedAt: new Date().toISOString() };
  saveWorkspace(root, workspace);
  return { id, name, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt };
}

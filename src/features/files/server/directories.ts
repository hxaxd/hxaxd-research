import 'server-only';

import { mkdir, readdir, stat } from 'node:fs/promises';

import { ApiError } from '@/shared/http/api-error';

import type { FileEntry } from '../schema';
import { resolveWorkspacePath, validateRelativePath } from './paths';

export async function listWorkspaceFiles(
  workspaceDir: string,
  workspaceId: string,
  relative = '',
): Promise<FileEntry[]> {
  const directory = await resolveWorkspacePath(workspaceDir, workspaceId, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const result: FileEntry[] = [];
  for (const entry of entries) {
    const filePath = relative ? `${relative}/${entry.name}` : entry.name;
    try {
      const resolved = await resolveWorkspacePath(workspaceDir, workspaceId, filePath);
      const info = await stat(resolved);
      if (info.isFile() || info.isDirectory())
        result.push({
          path: filePath,
          name: entry.name,
          kind: info.isDirectory() ? 'directory' : 'file',
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
    } catch (error) {
      if (
        (error as { code?: string }).code === 'invalid_path' ||
        (error as { code?: string }).code === 'file_missing'
      )
        continue;
      throw error;
    }
  }
  return result.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
      : a.kind === 'directory'
        ? -1
        : 1,
  );
}

export async function createWorkspaceDirectory(workspaceDir: string, workspaceId: string, relative: string) {
  const safe = validateRelativePath(relative, false);
  const target = await resolveWorkspacePath(workspaceDir, workspaceId, safe, true);
  try {
    await mkdir(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new ApiError(409, 'conflict', '同名文件或目录已存在');
    if (code === 'ENOENT') throw new ApiError(404, 'directory_missing', '上级目录不存在');
    throw error;
  }
  return { path: safe };
}

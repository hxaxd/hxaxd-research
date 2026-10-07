import 'server-only';
import { readdir, stat } from 'node:fs/promises';
import type { FileEntry } from '../file-schema';
import { resolveWorkspacePath } from './resolve-workspace-path';
export async function listWorkspaceFiles(workspaceDir: string, workspaceId: string, relative = ''): Promise<FileEntry[]> {
  const directory = await resolveWorkspacePath(workspaceDir, workspaceId, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const result: FileEntry[] = [];
  for (const entry of entries) {
    const filePath = relative ? `${relative}/${entry.name}` : entry.name;
    try {
      const resolved = await resolveWorkspacePath(workspaceDir, workspaceId, filePath);
      const info = await stat(resolved);
      if (info.isFile() || info.isDirectory()) result.push({ path: filePath, name: entry.name, kind: info.isDirectory() ? 'directory' : 'file', size: info.size, modifiedAt: info.mtime.toISOString() });
    } catch (error) {
      if ((error as { code?: string }).code === 'invalid_path' || (error as { code?: string }).code === 'file_missing') continue;
      throw error;
    }
  }
  return result.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.kind === 'directory' ? -1 : 1));
}

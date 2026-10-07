import 'server-only';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolveWorkspacePath } from './resolve-workspace-path';
import { ApiError } from '@/shared/http/api-error';
export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function readWorkspaceText(workspaceDir: string, workspaceId: string, relative: string, offset = 0, limit = 30000) {
  const file = await resolveWorkspacePath(workspaceDir, workspaceId, relative);
  const info = await stat(file);
  if (!info.isFile()) throw new ApiError(400, 'invalid_file', '请选择一个文本文件');
  if (info.size > 16 * 1024 * 1024) throw new ApiError(413, 'too_large', '文本超过 16 MiB，请下载后打开');
  const bytes = await readFile(file);
  if (bytes.includes(0)) throw new ApiError(400, 'binary_file', '该文件不是可预览的文本，请下载后打开');
  const slice = bytes.subarray(offset, offset + limit);
  return { path: relative, text: slice.toString('utf8'), hash: createHash('sha256').update(bytes).digest('hex'), offset, truncated: offset + slice.length < bytes.length, size: bytes.length };
}

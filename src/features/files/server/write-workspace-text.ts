import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath } from './resolve-workspace-path';
import { hashFile } from './read-workspace-file';
import { ApiError } from '@/shared/http/api-error';

const pending = new Map<string, Promise<unknown>>();
export async function serializeFileWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  pending.set(key, next);
  try { return await next; } finally { if (pending.get(key) === next) pending.delete(key); }
}
export async function writeWorkspaceText(workspaceDir: string, workspaceId: string, relative: string, content: string, expectedHash?: string, signal?: AbortSignal) {
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new ApiError(413, 'too_large', '文本写入不能超过 2 MiB');
  return serializeFileWrite(`${workspaceDir}/${workspaceId}`, async () => {
    signal?.throwIfAborted();
    const target = await resolveWorkspacePath(workspaceDir, workspaceId, relative, true);
    let current: string | null = null;
    try { current = await hashFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current !== null && current !== expectedHash) throw new ApiError(409, 'material_changed', '文件已变化，请重新读取后修改');
    if (current === null && expectedHash) throw new ApiError(409, 'material_changed', '原文件已不存在');
    await mkdir(path.dirname(target), { recursive: true });
    await resolveWorkspacePath(workspaceDir, workspaceId, relative, true);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      signal?.throwIfAborted();
      if (current !== null && await hashFile(target) !== current) throw new ApiError(409, 'material_changed', '文件在写入期间被外部修改');
      if (current === null) {
        try { await readFile(target); throw new ApiError(409, 'material_changed', '目标文件在写入期间已创建'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
    return { path: relative, hash: await hashFile(target) };
  });
}
export async function editWorkspaceText(workspaceDir: string, workspaceId: string, relative: string, oldText: string, newText: string, expectedHash: string, signal?: AbortSignal) {
  const target = await resolveWorkspacePath(workspaceDir, workspaceId, relative);
  const text = await readFile(target, 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== expectedHash) throw new ApiError(409, 'material_changed', '文件已变化，请重新读取后修改');
  if (!oldText || text.split(oldText).length !== 2) throw new ApiError(409, 'ambiguous_edit', '待替换文本必须在文件中恰好出现一次');
  return writeWorkspaceText(workspaceDir, workspaceId, relative, text.replace(oldText, newText), expectedHash, signal);
}

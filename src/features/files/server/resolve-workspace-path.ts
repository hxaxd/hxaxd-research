import 'server-only';
import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import { ApiError } from '@/shared/http/api-error';

export function validateRelativePath(value: string, allowEmpty = true): string {
  const normalized = value.replaceAll('\\', '/');
  if ((!normalized && !allowEmpty) || normalized.startsWith('/') || normalized.length > 2048) throw new ApiError(400, 'invalid_path', '请使用工作区内的相对路径');
  for (const part of normalized ? normalized.split('/') : []) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new ApiError(400, 'invalid_path', '文件路径含有无效名称');
  }
  return normalized;
}
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function resolveWorkspaceRoot(workspaceDir: string, workspaceId: string): Promise<string> {
  try {
    const base = await realpath(workspaceDir);
    const root = await realpath(path.join(workspaceDir, workspaceId));
    if (!isWithin(base, root) || base === root) throw new ApiError(403, 'invalid_path', '工作区目录不能指向外部位置');
    return root;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'directory_missing', '工作区目录不存在，请检查本地资料');
    throw error;
  }
}
export async function resolveWorkspacePath(workspaceDir: string, workspaceId: string, relative: string, allowMissing = false): Promise<string> {
  const safe = validateRelativePath(relative);
  const root = await resolveWorkspaceRoot(workspaceDir, workspaceId);
  let target = root;
  for (const part of safe ? safe.split('/') : []) {
    target = path.join(/* turbopackIgnore: true */ target, part);
    let exists = false;
    try {
      await lstat(target);
      exists = true;
      const resolved = await realpath(/* turbopackIgnore: true */ target);
      if (!isWithin(root, resolved)) throw new ApiError(403, 'invalid_path', '不能访问工作区之外的文件');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing && !exists) continue;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'file_missing', '文件或目录不存在，请刷新材料列表');
      throw error;
    }
  }
  return target;
}

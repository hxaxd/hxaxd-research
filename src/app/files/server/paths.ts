import 'server-only';
import { text as t } from '@/app/i18n/server.mjs';

import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { ApiError } from '@/shared/http/api-error';

export function validateRelativePath(value: string, allowEmpty = true): string {
  const normalized = value.replaceAll('\\', '/');
  if ((!normalized && !allowEmpty) || normalized.startsWith('/') || normalized.length > 2048)
    throw new ApiError(400, 'invalid_path', t('errors.relativePath'));
  for (const part of normalized ? normalized.split('/') : []) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[<>:"|?*\x00-\x1f]/.test(part) ||
      /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
      throw new ApiError(400, 'invalid_path', t('errors.pathName'));
  }
  return normalized;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function resolveWorkspaceRoot(
  workspaceDir: string,
  workspaceId: string,
): Promise<string> {
  try {
    const base = await realpath(workspaceDir);
    const root = await realpath(path.join(workspaceDir, workspaceId));
    if (!isWithin(base, root) || base === root)
      throw new ApiError(403, 'invalid_path', t('errors.workspaceExternal'));
    return root;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ApiError(404, 'directory_missing', t('errors.workspaceDirectory'));
    throw error;
  }
}

export async function resolveWorkspacePath(
  workspaceDir: string,
  workspaceId: string,
  relative: string,
  allowMissing = false,
): Promise<string> {
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
      if (!isWithin(root, resolved))
        throw new ApiError(403, 'invalid_path', t('errors.pathExternal'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing && !exists) continue;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ApiError(404, 'file_missing', t('errors.pathMissing'));
      throw error;
    }
  }
  return target;
}

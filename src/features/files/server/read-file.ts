import 'server-only';

import { readFile, stat } from 'node:fs/promises';

import type { AppConfig } from '@/server/config.mjs';
import { ApiError } from '@/shared/http/api-error';

import { resolveWorkspacePath } from './paths';

export async function readWorkspaceText(
  config: AppConfig,
  workspaceId: string,
  relative: string,
  offset = 0,
  limit = 30000,
) {
  const file = await resolveWorkspacePath(config.workspaceDir, workspaceId, relative);
  const info = await stat(file);
  if (!info.isFile()) throw new ApiError(400, 'invalid_file', '请选择一个文本文件');
  if (info.size > config.files.textBytes)
    throw new ApiError(413, 'too_large', '文本超过预览大小限制，请下载后打开');
  const bytes = await readFile(file);
  if (bytes.includes(0))
    throw new ApiError(400, 'binary_file', '该文件不是可预览的文本，请下载后打开');
  const slice = bytes.subarray(offset, offset + limit);
  return {
    path: relative,
    text: slice.toString('utf8'),
    offset,
    truncated: offset + slice.length < bytes.length,
    size: bytes.length,
  };
}

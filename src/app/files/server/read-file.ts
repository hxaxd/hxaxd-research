import 'server-only';
import { text as t } from '@/app/i18n/server.mjs';

import { readFile, stat } from 'node:fs/promises';

import type { AppConfig } from '@/app/config.mjs';
import { ApiError } from '@/shared/http/api-error';

import { resolveWorkspacePath } from './paths';

export async function readWorkspaceText(
  config: AppConfig,
  workspaceId: string,
  relative: string,
) {
  const file = await resolveWorkspacePath(config.workspaceDir, workspaceId, relative);
  const info = await stat(file);
  if (!info.isFile()) throw new ApiError(400, 'invalid_file', t('errors.textRequired'));
  if (info.size > config.files.textBytes)
    throw new ApiError(413, 'too_large', t('errors.textSize'));
  const bytes = await readFile(file);
  if (bytes.includes(0))
    throw new ApiError(400, 'binary_file', t('errors.binaryFile'));
  const slice = bytes.subarray(0, config.files.previewBytes);
  return {
    path: relative,
    text: slice.toString('utf8'),
    offset: 0,
    truncated: slice.length < bytes.length,
    size: bytes.length,
  };
}

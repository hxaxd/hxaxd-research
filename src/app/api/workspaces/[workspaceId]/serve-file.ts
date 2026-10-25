import 'server-only';

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { AppConfig } from '@/app/config.mjs';
import { ApiError } from '@/shared/http/api-error';

import { resolveWorkspacePath } from '@/app/files/server/paths';
import { readWorkspaceText } from '@/app/files/server/read-file';

const mime: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function requestedRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

export async function serveWorkspaceFile(request: Request, config: AppConfig, workspaceId: string, previewPath?: string) {
  const url = new URL(request.url);
  const relative = previewPath ?? url.searchParams.get('path') ?? '';
  if (!previewPath && url.searchParams.get('format') === 'text')
    return Response.json(await readWorkspaceText(config, workspaceId, relative, 0, config.files.previewBytes));
  const target = await resolveWorkspacePath(config.workspaceDir, workspaceId, relative);
  const info = await stat(target);
  if (!info.isFile()) throw new ApiError(400, 'invalid_file', '请选择一个文件');
  const type = mime[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const headers = new Headers({
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${url.searchParams.has('download') || type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
  });
  const range = request.headers.get('range');
  const bounds = range ? requestedRange(range, info.size) : { start: 0, end: info.size - 1 };
  if (!bounds) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
  const { start, end } = bounds;
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
  headers.set('Content-Length', String(Math.max(0, end - start + 1)));
  if (info.size === 0) return new Response(null, { headers });
  const stream = createReadStream(target, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers,
  });
}

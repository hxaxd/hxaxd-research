import 'server-only';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { resolveWorkspacePath } from './resolve-workspace-path';
import { readWorkspaceText } from './read-workspace-file';
import { ApiError } from '@/shared/http/api-error';
const mime: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export async function serveWorkspaceFile(request: Request, root: string, workspaceId: string) {
  const url = new URL(request.url);
  const relative = url.searchParams.get('path') ?? '';
  if (url.searchParams.get('format') === 'text') return Response.json(await readWorkspaceText(root, workspaceId, relative, 0, 100000));
  const target = await resolveWorkspacePath(root, workspaceId, relative);
  const info = await stat(target);
  if (!info.isFile()) throw new ApiError(400, 'invalid_file', '请选择一个文件');
  const type = mime[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const headers = new Headers({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Disposition': `${url.searchParams.has('download') || type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(target))}` });
  const range = request.headers.get('range');
  let start = 0, end = info.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]) || info.size === 0) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
    if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
    else start = Math.max(0, info.size - Number(match[2]));
    if (start > end || start >= info.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
    headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
  }
  headers.set('Content-Length', String(Math.max(0, end - start + 1)));
  if (info.size === 0) return new Response(null, { headers });
  const stream = createReadStream(target, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
}

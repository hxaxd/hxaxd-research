import 'server-only';

import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import busboy from 'busboy';
import type { z } from 'zod';

import type { AppConfig } from '@/server/config';
import { ApiError } from '@/shared/http/api-error';

import { importMetadataSchema, type ImportResult } from '../schema';
import { resolveWorkspacePath, validateRelativePath } from './paths';

async function importDestination(root: string, workspaceId: string, target: string, name: string, single: boolean) {
  const parsed = path.parse(name);
  for (let suffix = 0; ; suffix++) {
    const availableName = suffix === 0 ? name : single
      ? `${parsed.name} (${suffix})${parsed.ext}` : `${name} (${suffix})`;
    const relative = target ? `${target}/${availableName}` : availableName;
    const absolute = await resolveWorkspacePath(root, workspaceId, relative, true);
    try {
      await stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { relative, absolute };
      throw error;
    }
  }
}

export async function importWorkspaceFiles(
  config: AppConfig,
  workspaceId: string,
  request: Request,
): Promise<ImportResult> {
  if (!request.body) throw new ApiError(400, 'invalid_input', '请选择需要导入的文件');
  let metadata: z.infer<typeof importMetadataSchema> | undefined;
  let totalBytes = 0;
  const files: string[] = [];
  const tasks: Promise<void>[] = [];
  const seen = new Set<string>();
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
      preservePath: true,
      defParamCharset: 'utf8',
      limits: { fileSize: 256 * 1024 * 1024, files: 1000, fields: 1, fieldSize: 4096, parts: 1001 },
    });
  } catch {
    throw new ApiError(400, 'invalid_input', '请使用有效的 multipart/form-data 上传文件');
  }
  const source = Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>);
  const stage = await mkdtemp(path.join(config.stagingDir, 'import-'));
  const aborted = () => source.destroy(new ApiError(499, 'cancelled', '导入已取消'));
  request.signal.addEventListener('abort', aborted, { once: true });
  try {
    request.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      source.on('error', (error) => {
        parser.destroy(error);
        reject(error);
      });
      parser.on('error', (error) => {
        source.unpipe(parser);
        source.resume();
        reject(error);
      });
      parser.on('close', resolve);
      parser.on('fieldsLimit', () =>
        parser.destroy(new ApiError(400, 'invalid_input', '导入参数过多')),
      );
      parser.on('filesLimit', () =>
        parser.destroy(new ApiError(413, 'too_large', '每批最多 1000 个文件')),
      );
      parser.on('partsLimit', () => parser.destroy(new ApiError(413, 'too_large', '导入内容过多')));
      parser.on('field', (name, value, info) => {
        try {
          if (name !== 'metadata' || info.valueTruncated || metadata)
            throw new ApiError(400, 'invalid_input', '导入参数无效');
          metadata = importMetadataSchema.parse(JSON.parse(value));
          validateRelativePath(metadata.target);
          if (metadata.folderName && validateRelativePath(metadata.folderName, false).includes('/'))
            throw new ApiError(400, 'invalid_input', '材料目录名称不能包含路径');
        } catch (error) {
          parser.destroy(error as Error);
        }
      });
      parser.on('file', (_name, stream, info) => {
        stream.on('error', (error) => {
          if (!parser.destroyed) parser.destroy(error);
        });
        const task = (async () => {
          if (!metadata) throw new ApiError(400, 'invalid_input', '请先提供导入参数');
          const relative = validateRelativePath(info.filename, false);
          const key = relative.toLocaleLowerCase('en-US');
          if (seen.has(key)) throw new ApiError(409, 'conflict', '导入包含重复文件路径');
          seen.add(key);
          const target = path.join(stage, relative);
          await mkdir(path.dirname(target), { recursive: true });
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              totalBytes += chunk.length;
              callback(
                totalBytes > 1024 * 1024 * 1024
                  ? new ApiError(413, 'too_large', '每批导入不能超过 1 GiB')
                  : null,
                chunk,
              );
            },
          });
          await pipeline(stream, meter, createWriteStream(target, { flags: 'wx' }), {
            signal: request.signal,
          });
          if (stream.truncated) throw new ApiError(413, 'too_large', '单个文件不能超过 256 MiB');
          files.push(relative);
        })();
        tasks.push(task);
        void task.catch((error) => {
          stream.resume();
          parser.destroy(error as Error);
        });
      });
      source.pipe(parser);
    });
    await Promise.all(tasks);
    request.signal.throwIfAborted();
    if (!metadata || !files.length) throw new ApiError(400, 'invalid_input', '没有收到文件');
    const single = files.length === 1 && !metadata.folderName && !files[0].includes('/');
    const topName = single ? files[0] : metadata.folderName || '材料';
    const destination = await importDestination(config.workspaceDir, workspaceId, metadata.target, topName, single);
    await cp(single ? path.join(stage, files[0]) : stage, destination.absolute, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    return { path: destination.relative, files: files.length, bytes: totalBytes };
  } finally {
    request.signal.removeEventListener('abort', aborted);
    await Promise.allSettled(tasks);
    await rm(stage, { recursive: true, force: true });
  }
}

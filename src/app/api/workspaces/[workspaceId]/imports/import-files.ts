import 'server-only';
import { text as t } from '@/app/i18n/server.mjs';

import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import busboy from 'busboy';
import type { z } from 'zod';

import type { AppConfig } from '@/app/config.mjs';
import { ApiError } from '@/shared/http/api-error';

import { importMetadataSchema, type ImportResult } from '@/app/files/schema';
import { resolveWorkspacePath, validateRelativePath } from '@/app/files/server/paths';

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
  if (!request.body) throw new ApiError(400, 'invalid_input', t('errors.importFilesMissing'));
  let metadata: z.infer<typeof importMetadataSchema> | undefined;
  let totalBytes = 0;
  const files: string[] = [];
  const limits = config.files;
  const tasks: Promise<void>[] = [];
  const seen = new Set<string>();
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
      preservePath: true,
      defParamCharset: 'utf8',
      limits: { fileSize: limits.uploadFileBytes, files: limits.uploadFiles, fields: 1, fieldSize: 4096, parts: limits.uploadFiles + 1 },
    });
  } catch {
    throw new ApiError(400, 'invalid_input', t('errors.uploadFormat'));
  }
  const source = Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>);
  const stage = await mkdtemp(path.join(config.stagingDir, 'import-'));
  const aborted = () => source.destroy(new ApiError(499, 'cancelled', t('files.importCancelled')));
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
        parser.destroy(new ApiError(400, 'invalid_input', t('errors.importFields'))),
      );
      parser.on('filesLimit', () =>
        parser.destroy(new ApiError(413, 'too_large', t('errors.importFileCount', {value0: limits.uploadFiles}))),
      );
      parser.on('partsLimit', () => parser.destroy(new ApiError(413, 'too_large', t('errors.importParts'))));
      parser.on('field', (name, value, info) => {
        try {
          if (name !== 'metadata' || info.valueTruncated || metadata)
            throw new ApiError(400, 'invalid_input', t('errors.importInput'));
          metadata = importMetadataSchema.parse(JSON.parse(value));
          validateRelativePath(metadata.target);
          if (metadata.folderName && validateRelativePath(metadata.folderName, false).includes('/'))
            throw new ApiError(400, 'invalid_input', t('errors.folderName'));
        } catch (error) {
          parser.destroy(error as Error);
        }
      });
      parser.on('file', (_name, stream, info) => {
        stream.on('error', (error) => {
          if (!parser.destroyed) parser.destroy(error);
        });
        const task = (async () => {
          if (!metadata) throw new ApiError(400, 'invalid_input', t('errors.importMetadata'));
          const relative = validateRelativePath(info.filename, false);
          const key = relative.toLocaleLowerCase('en-US');
          if (seen.has(key)) throw new ApiError(409, 'conflict', t('errors.duplicatePath'));
          seen.add(key);
          const target = path.join(stage, relative);
          await mkdir(path.dirname(target), { recursive: true });
          const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              totalBytes += chunk.length;
              callback(
                totalBytes > limits.uploadTotalBytes
                  ? new ApiError(413, 'too_large', t('errors.importSize'))
                  : null,
                chunk,
              );
            },
          });
          await pipeline(stream, meter, createWriteStream(target, { flags: 'wx' }), {
            signal: request.signal,
          });
          if (stream.truncated) throw new ApiError(413, 'too_large', t('errors.fileSize'));
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
    if (!metadata || !files.length) throw new ApiError(400, 'invalid_input', t('errors.filesMissing'));
    const single = files.length === 1 && !metadata.folderName && !files[0].includes('/');
    const topName = single ? files[0] : metadata.folderName || t('files.materials');
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

import 'server-only';
import busboy from 'busboy';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { z } from 'zod';
import type { AppConfig } from '@/server/read-app-config';
import { ApiError } from '@/shared/http/api-error';
import type { ImportResult } from '../file-schema';
import { hashFile } from './read-workspace-file';
import { isWithin, resolveWorkspacePath, validateRelativePath } from './resolve-workspace-path';
import { serializeFileWrite } from './write-workspace-text';

const metadataSchema = z.object({ requestId: z.uuid(), target: z.string().max(2048).default(''), folderName: z.string().max(160).optional() });
const receiptSchema = metadataSchema.extend({ workspaceId: z.uuid(), finalPath: z.string(), manifest: z.array(z.object({ path: z.string(), hash: z.string(), bytes: z.number() })), state: z.enum(['ready', 'committed', 'failed']), result: z.object({ requestId: z.uuid(), path: z.string(), files: z.number(), bytes: z.number(), duplicate: z.boolean() }) });
export type ImportReceipt = z.infer<typeof receiptSchema>;
export async function saveImportReceipt(config: AppConfig, receipt: ImportReceipt) {
  const file = path.join(config.importsDir, `${receipt.requestId}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(receipt), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
export async function readImportReceipt(config: AppConfig, id: string): Promise<ImportReceipt | null> {
  try { return receiptSchema.parse(JSON.parse(await readFile(path.join(config.importsDir, `${id}.json`), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function removeImportStaging(config: AppConfig, id: string) {
  const target = path.resolve(config.stagingDir, z.uuid().parse(id));
  if (!isWithin(path.resolve(config.stagingDir), target) || target === path.resolve(config.stagingDir)) throw new Error('Invalid staging cleanup target');
  await rm(target, { recursive: true, force: true });
}
export async function verifyImportFiles(directory: string, manifest: ImportReceipt['manifest'], single: boolean): Promise<boolean> {
  try {
    if (single) return await hashFile(directory) === manifest[0].hash;
    const files: string[] = [];
    async function collect(current: string, relative = '') {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) return false;
        if (entry.isDirectory()) { if (!await collect(path.join(current, entry.name), name)) return false; }
        else if (entry.isFile()) files.push(name);
        else return false;
      }
      return true;
    }
    if (!await collect(directory) || files.length !== manifest.length) return false;
    for (const file of manifest) if (!files.includes(file.path) || await hashFile(path.join(directory, file.path)) !== file.hash) return false;
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function sameImport(a: ImportReceipt, b: ImportReceipt) {
  return a.workspaceId === b.workspaceId && a.target === b.target && a.folderName === b.folderName && JSON.stringify(a.manifest) === JSON.stringify(b.manifest);
}
export async function importWorkspaceFiles(config: AppConfig, workspaceId: string, request: Request): Promise<ImportResult> {
  if (!request.body) throw new ApiError(400, 'invalid_input', '请选择需要导入的文件');
  let metadata: z.infer<typeof metadataSchema> | undefined;
  let staging: string | undefined;
  let ownsStaging = false;
  let stagingReady: Promise<void> | undefined;
  let totalBytes = 0;
  const tasks: Promise<void>[] = [];
  const manifest: ImportReceipt['manifest'] = [];
  const seen = new Set<string>();
  const source = Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>);
  const parser = busboy({ headers: { 'content-type': request.headers.get('content-type') ?? '' }, preservePath: true, defParamCharset: 'utf8', limits: { fileSize: 256 * 1024 * 1024, files: 1000, fields: 1, fieldSize: 4096, parts: 1001 } });
  const aborted = () => source.destroy(new ApiError(499, 'cancelled', '导入已取消'));
  request.signal.addEventListener('abort', aborted, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      source.on('error', error => { parser.destroy(error); reject(error); });
      parser.on('error', error => { source.unpipe(parser); source.resume(); reject(error); });
      parser.on('close', resolve);
      parser.on('fieldsLimit', () => parser.destroy(new ApiError(400, 'invalid_input', '导入参数重复')));
      parser.on('filesLimit', () => parser.destroy(new ApiError(413, 'too_large', '每次最多导入 1000 个文件')));
      parser.on('partsLimit', () => parser.destroy(new ApiError(413, 'too_large', '导入文件过多')));
      parser.on('field', (name, value, info) => {
        try {
          if (name !== 'metadata' || metadata || info.valueTruncated) throw new ApiError(400, 'invalid_input', '导入参数无效');
          metadata = metadataSchema.parse(JSON.parse(value));
          metadata.target = validateRelativePath(metadata.target);
          if (metadata.folderName && validateRelativePath(metadata.folderName, false).includes('/')) throw new ApiError(400, 'invalid_input', '材料目录名称不能包含路径');
          staging = path.join(config.stagingDir, metadata.requestId);
        } catch (error) { parser.destroy(error as Error); }
      });
      parser.on('file', (_name, stream, info) => {
        stream.on('error', error => { if (!parser.destroyed) parser.destroy(error); });
        const task = (async () => {
          if (!metadata || !staging) throw new ApiError(400, 'invalid_input', '请先提供导入参数');
          const relative = validateRelativePath(info.filename, false);
          const key = relative.toLocaleLowerCase('en-US');
          if (seen.has(key)) throw new ApiError(409, 'conflict', '导入包含重复文件路径');
          seen.add(key);
          stagingReady ??= mkdir(staging).then(() => { ownsStaging = true; });
          await stagingReady;
          const target = path.join(staging, relative);
          await mkdir(path.dirname(target), { recursive: true });
          const hash = createHash('sha256');
          let bytes = 0;
          const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length; totalBytes += chunk.length;
            if (totalBytes > 1024 * 1024 * 1024) { callback(new ApiError(413, 'too_large', '每批导入不能超过 1 GiB')); return; }
            hash.update(chunk); callback(null, chunk);
          } });
          await pipeline(stream, meter, createWriteStream(target, { flags: 'wx' }));
          if (stream.truncated) throw new ApiError(413, 'too_large', '单个文件不能超过 256 MiB');
          manifest.push({ path: relative, hash: hash.digest('hex'), bytes });
        })();
        tasks.push(task);
        void task.catch(error => { stream.resume(); parser.destroy(error as Error); });
      });
      source.pipe(parser);
    });
    await Promise.all(tasks);
    request.signal.throwIfAborted();
    if (!metadata || !staging || !manifest.length) throw new ApiError(400, 'invalid_input', '没有收到文件');
    manifest.sort((a, b) => a.path.localeCompare(b.path));
    const input = metadata;
    const stage = staging;
    return await serializeFileWrite(`${config.workspaceDir}/${workspaceId}`, async () => {
      const single = manifest.length === 1 && !input.folderName && !manifest[0].path.includes('/');
      const topName = single ? manifest[0].path : input.folderName || `材料-${input.requestId.slice(0, 8)}`;
      let finalPath = input.target ? `${input.target}/${topName}` : topName;
      const receipt: ImportReceipt = { ...input, workspaceId, finalPath, manifest, state: 'ready', result: { requestId: input.requestId, path: finalPath, files: manifest.length, bytes: totalBytes, duplicate: false } };
      const old = await readImportReceipt(config, input.requestId);
      if (old) {
        if (!sameImport(old, receipt)) throw new ApiError(409, 'conflict', '相同导入 ID 已用于其他材料');
        const existing = await resolveWorkspacePath(config.workspaceDir, workspaceId, old.finalPath, true);
        if (await verifyImportFiles(existing, old.manifest, single)) return { ...old.result, duplicate: true };
        if (old.state === 'committed') throw new ApiError(409, 'material_changed', '已导入的材料后来发生变化，请使用新的导入请求');
      }
      const parent = await resolveWorkspacePath(config.workspaceDir, workspaceId, input.target);
      if (!(await stat(parent)).isDirectory()) throw new ApiError(400, 'invalid_path', '导入目标必须是目录');
      let destination = await resolveWorkspacePath(config.workspaceDir, workspaceId, finalPath, true);
      for (let suffix = 1; ; suffix++) {
        try {
          await stat(destination);
          if (await verifyImportFiles(destination, manifest, single)) {
            receipt.finalPath = finalPath; receipt.state = 'committed'; receipt.result.path = finalPath; receipt.result.duplicate = true;
            await saveImportReceipt(config, receipt);
            return receipt.result;
          }
          const parsed = path.parse(topName);
          const alternative = single ? `${parsed.name} (${suffix})${parsed.ext}` : `${topName} (${suffix})`;
          finalPath = input.target ? `${input.target}/${alternative}` : alternative;
          destination = await resolveWorkspacePath(config.workspaceDir, workspaceId, finalPath, true);
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
      }
      receipt.finalPath = finalPath; receipt.result.path = finalPath;
      await saveImportReceipt(config, receipt);
      request.signal.throwIfAborted();
      await resolveWorkspacePath(config.workspaceDir, workspaceId, finalPath, true);
      await rename(single ? path.join(stage, manifest[0].path) : stage, destination);
      receipt.state = 'committed';
      await saveImportReceipt(config, receipt);
      return receipt.result;
    });
  } finally {
    request.signal.removeEventListener('abort', aborted);
    await Promise.allSettled(tasks);
    if (ownsStaging && metadata) await removeImportStaging(config, metadata.requestId);
  }
}

import { text as t } from '@/app/i18n/server.mjs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import {
  createDirectorySchema,
  fileListQuerySchema,
  folderMarkerFile,
  folderMarkerRequestSchema,
  folderMarkerSchema,
  maxSearchResults,
  type FileEntry,
  type FolderMarker,
} from '@/app/files/schema';
import { resolveWorkspacePath, validateRelativePath } from '@/app/files/server/paths';
import { getWorkspace } from '@/app/workspaces/workspaces';
import { getAppRuntime } from '@/app/runtime';
import { ApiError } from '@/shared/http/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workspaceId: string }> };

/** Reads `research.json`; a missing or malformed marker leaves the folder as a plain folder. */
async function readFolderMarker(absolute: string, relative: string): Promise<FolderMarker | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(absolute, folderMarkerFile), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const marker = folderMarkerSchema.parse(JSON.parse(text));
    if (!marker.main) return marker;
    const main = validateRelativePath(marker.main, false);
    return { ...marker, main: `${relative}/${main}` };
  } catch {
    return undefined;
  }
}

function matches(entry: FileEntry, query: string) {
  return entry.name.toLowerCase().includes(query) || !!entry.marker?.title?.toLowerCase().includes(query);
}

export function GET(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const { workspaceId } = await validatedIds(context);
    getWorkspace(app.config.workspaceDir, workspaceId);
    const { path: relative, view, q } = fileListQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const directory = await resolveWorkspacePath(app.config.workspaceDir, workspaceId, relative);
    const query = q.toLowerCase();
    const papers = view === 'papers';
    const recursive = papers || !!query;
    const result: FileEntry[] = [];
    async function collect(directory: string, relative: string) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (query && result.length >= maxSearchResults) return;
        // `.pi` holds conversation internals and is never material.
        if (entry.name === '.pi' || (recursive && entry.isSymbolicLink())) continue;
        const filePath = relative ? `${relative}/${entry.name}` : entry.name;
        try {
          const resolved = await resolveWorkspacePath(app.config.workspaceDir, workspaceId, filePath);
          const info = await stat(resolved);
          const marker = info.isDirectory() ? await readFolderMarker(resolved, filePath) : undefined;
          const item: FileEntry = {
            path: filePath,
            name: entry.name,
            kind: info.isDirectory() ? 'directory' : 'file',
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
            ...(marker ? { marker } : {}),
          };
          if (papers) {
            // Paper folders are leaves of the paper filter; their contents are browsed through the tree.
            if (marker?.type === 'paper') {
              if (!query || matches(item, query)) result.push(item);
            } else if (info.isDirectory()) await collect(resolved, filePath);
          } else if (query) {
            if (info.isDirectory()) {
              if (marker && matches(item, query)) result.push(item);
              await collect(resolved, filePath);
            } else if (info.isFile() && matches(item, query)) result.push(item);
          } else if (info.isFile() || info.isDirectory()) result.push(item);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === 'invalid_path' || code === 'file_missing') continue;
          throw error;
        }
      }
    }
    await collect(directory, relative);
    return result.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
        : a.kind === 'directory' ? -1 : 1,
    );
  });
}

/** Marks a folder as a paper (choosing its shallowest PDF as main) or removes the marker. */
export function PATCH(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const { workspaceId } = await validatedIds(context);
    getWorkspace(app.config.workspaceDir, workspaceId);
    const input = folderMarkerRequestSchema.parse(await request.json());
    const relative = validateRelativePath(input.path, false);
    const directory = await resolveWorkspacePath(app.config.workspaceDir, workspaceId, relative);
    if (!(await stat(directory)).isDirectory()) throw new ApiError(400, 'invalid_input', t('errors.folderRequired'));
    const target = path.join(directory, folderMarkerFile);
    if (!input.type) {
      await rm(target, { force: true });
      return Response.json({ path: relative });
    }
    const pdfs: string[] = [];
    async function find(absolute: string, prefix: string, depth: number) {
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isFile() && /\.pdf$/i.test(entry.name)) pdfs.push(name);
        else if (entry.isDirectory() && depth < 2) await find(path.join(absolute, entry.name), name, depth + 1);
      }
    }
    await find(directory, '', 0);
    const main = pdfs.sort((a, b) => a.split('/').length - b.split('/').length
      || a.localeCompare(b, 'en', { numeric: true }))[0];
    if (!main) throw new ApiError(400, 'invalid_input', t('errors.paperPdfMissing'));
    const marker: FolderMarker = { type: input.type, title: path.parse(main).name, main };
    await writeFile(target, `${JSON.stringify(marker, null, 2)}\n`);
    return Response.json({ path: relative, marker: { ...marker, main: `${relative}/${main}` } });
  });
}

export function POST(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const { workspaceId } = await validatedIds(context);
    getWorkspace(app.config.workspaceDir, workspaceId);
    const input = createDirectorySchema.parse(await request.json());
    const safe = validateRelativePath(input.path, false);
    const target = await resolveWorkspacePath(app.config.workspaceDir, workspaceId, safe, true);
    try {
      await mkdir(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new ApiError(409, 'conflict', t('errors.pathExists'));
      if (code === 'ENOENT') throw new ApiError(404, 'directory_missing', t('errors.parentMissing'));
      throw error;
    }
    return Response.json({ path: safe }, { status: 201 });
  });
}

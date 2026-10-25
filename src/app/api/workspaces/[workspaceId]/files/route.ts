import { text as t } from '@/app/i18n/server.mjs';
import { mkdir, readdir, stat } from 'node:fs/promises';

import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { createDirectorySchema, fileListQuerySchema, type FileEntry } from '@/app/files/schema';
import { resolveWorkspacePath, validateRelativePath } from '@/app/files/server/paths';
import { getWorkspace } from '@/app/workspaces/workspaces';
import { getAppRuntime } from '@/app/runtime';
import { ApiError } from '@/shared/http/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workspaceId: string }> };

export function GET(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const { workspaceId } = await validatedIds(context);
    getWorkspace(app.config.workspaceDir, workspaceId);
    const { path: relative, view } = fileListQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const directory = await resolveWorkspacePath(app.config.workspaceDir, workspaceId, relative);
    const result: FileEntry[] = [];
    async function collect(directory: string, relative: string) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (view === 'papers' && (entry.isSymbolicLink() || entry.name === '.pi')) continue;
        const filePath = relative ? `${relative}/${entry.name}` : entry.name;
        try {
          const resolved = await resolveWorkspacePath(app.config.workspaceDir, workspaceId, filePath);
          const info = await stat(resolved);
          if (view === 'papers' && info.isDirectory()) {
            await collect(resolved, filePath);
          } else if (view === 'papers' ? info.isFile() && /\.pdf$/i.test(entry.name) : info.isFile() || info.isDirectory()) {
            result.push({
              path: filePath,
              name: entry.name,
              kind: info.isDirectory() ? 'directory' : 'file',
              size: info.size,
              modifiedAt: info.mtime.toISOString(),
            });
          }
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

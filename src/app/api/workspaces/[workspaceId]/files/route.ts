import { mkdir, readdir, stat } from 'node:fs/promises';

import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { createDirectorySchema, type FileEntry } from '@/app/files/schema';
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
    const relative = new URL(request.url).searchParams.get('path') ?? '';
    const directory = await resolveWorkspacePath(app.config.workspaceDir, workspaceId, relative);
    const entries = await readdir(directory, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      const filePath = relative ? `${relative}/${entry.name}` : entry.name;
      try {
        const resolved = await resolveWorkspacePath(app.config.workspaceDir, workspaceId, filePath);
        const info = await stat(resolved);
        if (info.isFile() || info.isDirectory())
          result.push({
            path: filePath,
            name: entry.name,
            kind: info.isDirectory() ? 'directory' : 'file',
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'invalid_path' || code === 'file_missing') continue;
        throw error;
      }
    }
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
      if (code === 'EEXIST') throw new ApiError(409, 'conflict', '同名文件或目录已存在');
      if (code === 'ENOENT') throw new ApiError(404, 'directory_missing', '上级目录不存在');
      throw error;
    }
    return Response.json({ path: safe }, { status: 201 });
  });
}

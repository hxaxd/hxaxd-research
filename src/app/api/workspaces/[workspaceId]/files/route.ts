import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { createDirectorySchema } from '@/features/files/schema';
import { createWorkspaceDirectory, listWorkspaceFiles } from '@/features/files/server/directories';
import { getWorkspace } from '@/features/workspaces/server/workspaces';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workspaceId: string }> };

export function GET(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const { workspaceId } = await validatedIds(context);
    getWorkspace(app.config.workspaceDir, workspaceId);
    return listWorkspaceFiles(
      app.config.workspaceDir,
      workspaceId,
      new URL(request.url).searchParams.get('path') ?? '',
    );
  });
}

export function POST(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const { workspaceId } = await validatedIds(context);
    getWorkspace(app.config.workspaceDir, workspaceId);
    const input = createDirectorySchema.parse(await request.json());
    const result = await createWorkspaceDirectory(app.config.workspaceDir, workspaceId, input.path);
    return Response.json(result, { status: 201 });
  });
}

import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { importWorkspaceFiles } from './import-files';
import { getWorkspace } from '@/app/workspaces/workspaces';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workspaceId: string }> };

export function POST(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const { workspaceId } = await validatedIds(context);
    getWorkspace(app.config.workspaceDir, workspaceId);
    return Response.json(
      await importWorkspaceFiles(app.config, workspaceId, request),
      {
        status: 201,
      },
    );
  });
}

import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { serveWorkspaceFile } from '@/features/files/server/serve-file';
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
    return serveWorkspaceFile(request, app.config.workspaceDir, workspaceId);
  });
}

import { handleApiRequest } from '@/app/api/handle-request';
import { serveWorkspaceFile } from '../../serve-file';
import { getAppRuntime } from '@/app/runtime';
import { getWorkspace } from '@/app/workspaces/workspaces';
import { idSchema } from '@/shared/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request, context: { params: Promise<{ workspaceId: string; path: string[] }> }) {
  return handleApiRequest(request, async () => {
    const params = await context.params;
    const config = getAppRuntime().config;
    const workspaceId = idSchema.parse(params.workspaceId);
    getWorkspace(config.workspaceDir, workspaceId);
    return serveWorkspaceFile(request, config, workspaceId, params.path.join('/'));
  });
}

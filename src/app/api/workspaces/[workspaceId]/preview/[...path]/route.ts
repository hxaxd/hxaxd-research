import { handleApiRequest } from '@/app/api/handle-request';
import { serveWorkspaceFile } from '../../serve-file';
import { getAppRuntime } from '@/app/runtime';
import { idSchema } from '@/shared/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request, context: { params: Promise<{ workspaceId: string; path: string[] }> }) {
  return handleApiRequest(request, async () => {
    const params = await context.params;
    return serveWorkspaceFile(request, getAppRuntime().config, idSchema.parse(params.workspaceId), params.path.join('/'));
  });
}

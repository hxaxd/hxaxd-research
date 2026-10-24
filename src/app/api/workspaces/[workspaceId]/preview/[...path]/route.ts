import { handleApiRequest } from '@/app/api/handle-request';
import { serveWorkspaceFile } from '@/features/files/server/serve-file';
import { getAppRuntime } from '@/server/runtime';
import { idSchema } from '@/shared/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request, context: { params: Promise<{ workspaceId: string; path: string[] }> }) {
  return handleApiRequest(request, async () => {
    const params = await context.params;
    return serveWorkspaceFile(request, getAppRuntime().config.workspaceDir, idSchema.parse(params.workspaceId), params.path.join('/'));
  });
}

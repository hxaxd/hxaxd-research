import { handleApiRequest, validatedIds } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { listWorkspaceFiles } from '@/features/files/server/list-workspace-files';
import { getWorkspace } from '@/features/workspaces/server/workspace-store';
type Context = { params: Promise<{ workspaceId: string }> };
export function GET(request: Request, context: Context) { return handleApiRequest(request, async () => { const app = getAppRuntime(); const { workspaceId } = await validatedIds(context); getWorkspace(app.db, workspaceId); return listWorkspaceFiles(app.config.workspaceDir, workspaceId, new URL(request.url).searchParams.get('path') ?? ''); }); }


import { handleApiRequest, validatedIds } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { importWorkspaceFiles } from '@/features/files/server/import-workspace-files';
import { getWorkspace } from '@/features/workspaces/server/workspace-store';
type Context = { params: Promise<{ workspaceId: string }> };
export function POST(request: Request, context: Context) { return handleApiRequest(request, async () => { const app = getAppRuntime(); const { workspaceId } = await validatedIds(context); getWorkspace(app.db, workspaceId); return Response.json(await importWorkspaceFiles(app.config, workspaceId, request), { status: 201 }); }); }


import { handleApiRequest, validatedIds } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { renameSchema } from '@/features/workspaces/workspace-schema';
import { renameWorkspace } from '@/features/workspaces/server/workspace-store';
type Context = { params: Promise<{ workspaceId: string }> };
export function PATCH(request: Request, context: Context) { return handleApiRequest(request, async () => { const { workspaceId } = await validatedIds(context); return renameWorkspace(getAppRuntime().db, workspaceId, renameSchema.parse(await request.json()).name); }); }


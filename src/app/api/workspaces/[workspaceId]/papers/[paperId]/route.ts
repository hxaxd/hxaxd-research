import { handleApiRequest, validatedIds } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { renameSchema } from '@/features/workspaces/workspace-schema';
import { renamePaper } from '@/features/papers/server/paper-store';
type Context = { params: Promise<{ workspaceId: string; paperId: string }> };
export function PATCH(request: Request, context: Context) { return handleApiRequest(request, async () => { const { workspaceId, paperId } = await validatedIds(context); return renamePaper(getAppRuntime().db, workspaceId, paperId, renameSchema.parse(await request.json()).name); }); }


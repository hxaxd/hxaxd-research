import { handleApiRequest, validatedIds } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { renameSchema } from '@/features/workspaces/workspace-schema';
import { renameConversation } from '@/features/conversations/server/conversation-store';
type Context = { params: Promise<{ workspaceId: string; conversationId: string }> };
export function GET(request: Request, context: Context) { return handleApiRequest(request, async () => { const { workspaceId, conversationId } = await validatedIds(context); return getAppRuntime().sessions.snapshot(workspaceId, conversationId); }); }
export function PATCH(request: Request, context: Context) { return handleApiRequest(request, async () => { const { workspaceId, conversationId } = await validatedIds(context); return renameConversation(getAppRuntime().db, workspaceId, conversationId, renameSchema.parse(await request.json()).name); }); }


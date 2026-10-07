import { handleApiRequest, validatedIds } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { streamConversationEvents } from '@/features/conversations/server/stream-conversation-events';
type Context = { params: Promise<{ workspaceId: string; conversationId: string }> };
export function GET(request: Request, context: Context) { return handleApiRequest(request, async () => { const { workspaceId, conversationId } = await validatedIds(context); return streamConversationEvents(request, getAppRuntime().sessions, workspaceId, conversationId); }); }


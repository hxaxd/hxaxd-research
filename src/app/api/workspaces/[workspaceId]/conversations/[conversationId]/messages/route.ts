import { handleApiRequest, validatedIds } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { sendMessageSchema } from '@/features/conversations/conversation-schema';
import { sendConversationMessage } from '@/features/conversations/server/send-conversation-message';
type Context = { params: Promise<{ workspaceId: string; conversationId: string }> };
export function POST(request: Request, context: Context) { return handleApiRequest(request, async () => { const app = getAppRuntime(); const { workspaceId, conversationId } = await validatedIds(context); return Response.json(await sendConversationMessage(app.db, app.sessions, app.config.workspaceDir, workspaceId, conversationId, sendMessageSchema.parse(await request.json())), { status: 202 }); }); }


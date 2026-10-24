import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { streamConversationEvents } from '@/features/conversations/server/events';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {
  params: Promise<{ workspaceId: string; conversationId: string }>;
};

export function GET(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { workspaceId, conversationId } = await validatedIds(context);
    return streamConversationEvents(
      request,
      getAppRuntime().sessions,
      workspaceId,
      conversationId,
    );
  });
}

import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { conversationImageQuerySchema } from '@/features/conversations/schema';
import { readConversationImage } from '@/features/conversations/server/history';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request, context: { params: Promise<{ workspaceId: string; conversationId: string }> }) {
  return handleApiRequest(request, async () => {
    const { workspaceId, conversationId } = await validatedIds(context);
    const { message, index } = conversationImageQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return readConversationImage(getAppRuntime().config.workspaceDir, workspaceId, conversationId, message, index);
  });
}

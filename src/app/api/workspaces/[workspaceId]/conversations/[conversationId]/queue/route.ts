import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { getAppRuntime } from '@/app/runtime';
import { idSchema } from '@/shared/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {
  params: Promise<{ workspaceId: string; conversationId: string }>;
};

export function POST(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { workspaceId, conversationId } = await validatedIds(context);
    return getAppRuntime().sessions.resumeQueue(workspaceId, conversationId);
  });
}

export function DELETE(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { workspaceId, conversationId } = await validatedIds(context);
    const id = idSchema.parse(new URL(request.url).searchParams.get('id'));
    return getAppRuntime().sessions.removeQueued(workspaceId, conversationId, id);
  });
}

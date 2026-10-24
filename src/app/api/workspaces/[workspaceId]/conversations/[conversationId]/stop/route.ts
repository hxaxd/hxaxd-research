import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { stopRunSchema } from '@/features/conversations/schema';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {
  params: Promise<{ workspaceId: string; conversationId: string }>;
};

export function POST(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { workspaceId, conversationId } = await validatedIds(context);
    const body = stopRunSchema.parse(await request.json());
    return getAppRuntime().sessions.stop(workspaceId, conversationId, body.id);
  });
}

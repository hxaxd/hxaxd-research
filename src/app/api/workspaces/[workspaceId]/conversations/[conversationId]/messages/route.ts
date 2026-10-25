import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { sendMessageSchema } from '@/app/conversations/schema';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {
  params: Promise<{ workspaceId: string; conversationId: string }>;
};

export function POST(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const { workspaceId, conversationId } = await validatedIds(context);
    return Response.json(
      await app.sessions.send(
        workspaceId,
        conversationId,
        sendMessageSchema.parse(await request.json()),
      ),
      { status: 202 },
    );
  });
}

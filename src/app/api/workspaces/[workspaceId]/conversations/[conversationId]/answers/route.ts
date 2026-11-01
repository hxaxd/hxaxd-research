import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { answerQuestionSchema } from '@/app/conversations/schema';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workspaceId: string; conversationId: string }> };

export function POST(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { workspaceId, conversationId } = await validatedIds(context);
    const body = answerQuestionSchema.parse(await request.json());
    return getAppRuntime().sessions.answer(workspaceId, conversationId, body.id, body.answer);
  });
}

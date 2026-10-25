import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { createConversationSchema } from '@/app/conversations/schema';
import {
  createConversation,
  listConversations,
} from '@/app/conversations/server/conversations';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workspaceId: string }> };

export function GET(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { config } = getAppRuntime();
    const { workspaceId } = await validatedIds(context);
    return listConversations(config.workspaceDir, workspaceId);
  });
}

export function POST(request: Request, context: Context) {
  return handleApiRequest(request, async () =>
    Response.json(
      createConversation(
        getAppRuntime().config.workspaceDir,
        (await validatedIds(context)).workspaceId,
        createConversationSchema.parse(await request.json()),
      ),
      { status: 201 },
    ),
  );
}

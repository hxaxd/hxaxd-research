import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { getAppRuntime } from '@/app/runtime';
import { renameSchema } from '@/shared/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {
  params: Promise<{ workspaceId: string; conversationId: string }>;
};

export function GET(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { workspaceId, conversationId } = await validatedIds(context);
    return getAppRuntime().sessions.snapshot(workspaceId, conversationId);
  });
}

export function PATCH(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { workspaceId, conversationId } = await validatedIds(context);
    return getAppRuntime().sessions.rename(
      workspaceId,
      conversationId,
      renameSchema.parse(await request.json()).name,
    );
  });
}

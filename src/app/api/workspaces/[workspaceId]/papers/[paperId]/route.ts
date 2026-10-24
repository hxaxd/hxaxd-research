import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { renamePaper } from '@/features/papers/server/papers';
import { getAppRuntime } from '@/server/runtime';
import { renameSchema } from '@/shared/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workspaceId: string; paperId: string }> };

export function PATCH(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { workspaceId, paperId } = await validatedIds(context);
    return renamePaper(
      getAppRuntime().config.workspaceDir,
      workspaceId,
      paperId,
      renameSchema.parse(await request.json()).name,
    );
  });
}

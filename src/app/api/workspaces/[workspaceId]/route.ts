import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import {
  getWorkspace,
  renameWorkspace,
} from '@/features/workspaces/server/workspaces';
import { getAppRuntime } from '@/server/runtime';
import { renameSchema } from '@/shared/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workspaceId: string }> };

export function GET(request: Request, context: Context) {
  return handleApiRequest(request, async () =>
    getWorkspace(
      getAppRuntime().config.workspaceDir,
      (await validatedIds(context)).workspaceId,
    ),
  );
}

export function PATCH(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { workspaceId } = await validatedIds(context);
    return renameWorkspace(
      getAppRuntime().config.workspaceDir,
      workspaceId,
      renameSchema.parse(await request.json()).name,
    );
  });
}

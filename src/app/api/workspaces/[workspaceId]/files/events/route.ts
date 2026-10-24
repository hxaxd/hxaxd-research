import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { streamFileEvents } from '@/features/files/server/events';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  return handleApiRequest(request, async () => {
    const { workspaceId } = await validatedIds(context);
    return streamFileEvents(
      request,
      getAppRuntime().config.workspaceDir,
      workspaceId,
      getAppRuntime().reader,
    );
  });
}

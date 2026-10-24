import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { createPaperSchema } from '@/features/papers/schema';
import { createPaper, listPapers } from '@/features/papers/server/papers';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workspaceId: string }> };

export function GET(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { config } = getAppRuntime();
    const { workspaceId } = await validatedIds(context);
    return listPapers(config.workspaceDir, workspaceId);
  });
}

export function POST(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    return Response.json(
      createPaper(
        app.config.workspaceDir,
        (await validatedIds(context)).workspaceId,
        createPaperSchema.parse(await request.json()),
      ),
      { status: 201 },
    );
  });
}

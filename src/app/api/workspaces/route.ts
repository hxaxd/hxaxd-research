import { handleApiRequest } from '@/app/api/handle-request';
import { createWorkspaceSchema } from '@/features/workspaces/schema';
import {
  createWorkspace,
  listWorkspaces,
} from '@/features/workspaces/server/workspaces';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handleApiRequest(request, () =>
    listWorkspaces(getAppRuntime().config.workspaceDir),
  );
}

export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    return Response.json(
      createWorkspace(
        app.config.workspaceDir,
        createWorkspaceSchema.parse(await request.json()),
      ),
      { status: 201 },
    );
  });
}

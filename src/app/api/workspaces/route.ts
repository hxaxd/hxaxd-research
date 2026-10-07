import { handleApiRequest } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { createWorkspaceSchema } from '@/features/workspaces/workspace-schema';
import { listWorkspaces } from '@/features/workspaces/server/workspace-store';
import { createWorkspace } from '@/features/workspaces/server/create-workspace';
export function GET(request: Request) { return handleApiRequest(request, () => listWorkspaces(getAppRuntime().db)); }
export function POST(request: Request) { return handleApiRequest(request, async () => { const app = getAppRuntime(); return Response.json(createWorkspace(app.db, app.config.workspaceDir, createWorkspaceSchema.parse(await request.json())), { status: 201 }); }); }


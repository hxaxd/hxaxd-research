import { handleApiRequest, validatedIds } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { createPaperSchema } from '@/features/papers/paper-schema';
import { listPapers } from '@/features/papers/server/paper-store';
import { createPaper } from '@/features/papers/server/create-paper';
type Context = { params: Promise<{ workspaceId: string }> };
export function GET(request: Request, context: Context) { return handleApiRequest(request, async () => listPapers(getAppRuntime().db, (await validatedIds(context)).workspaceId)); }
export function POST(request: Request, context: Context) { return handleApiRequest(request, async () => { const app = getAppRuntime(); return Response.json(createPaper(app.db, app.config.workspaceDir, (await validatedIds(context)).workspaceId, createPaperSchema.parse(await request.json())), { status: 201 }); }); }


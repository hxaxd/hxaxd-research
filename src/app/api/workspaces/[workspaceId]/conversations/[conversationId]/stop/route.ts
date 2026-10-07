import { handleApiRequest, validatedIds } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { idSchema } from '@/features/workspaces/workspace-schema';
import { z } from 'zod';
type Context = { params: Promise<{ workspaceId: string; conversationId: string }> };
export function POST(request: Request, context: Context) { return handleApiRequest(request, async () => { const { workspaceId, conversationId } = await validatedIds(context); const body = z.object({ id: idSchema }).parse(await request.json()); return getAppRuntime().sessions.stop(workspaceId, conversationId, body.id); }); }

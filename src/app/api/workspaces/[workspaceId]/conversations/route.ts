import { handleApiRequest, validatedIds } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { createConversationSchema } from '@/features/conversations/conversation-schema';
import { listConversations } from '@/features/conversations/server/conversation-store';
import { createConversation } from '@/features/conversations/server/create-conversation';
type Context = { params: Promise<{ workspaceId: string }> };
export function GET(request: Request, context: Context) { return handleApiRequest(request, async () => listConversations(getAppRuntime().db, (await validatedIds(context)).workspaceId)); }
export function POST(request: Request, context: Context) { return handleApiRequest(request, async () => Response.json(createConversation(getAppRuntime().db, (await validatedIds(context)).workspaceId, createConversationSchema.parse(await request.json())), { status: 201 })); }


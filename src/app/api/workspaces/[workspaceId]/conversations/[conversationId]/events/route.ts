import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import type { ConversationSnapshot } from '@/app/conversations/schema';
import { getAppRuntime } from '@/app/runtime';
import { eventStream } from '@/shared/http/event-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {
  params: Promise<{ workspaceId: string; conversationId: string }>;
};

export function GET(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const { workspaceId, conversationId } = await validatedIds(context);
    const app = getAppRuntime();
    return eventStream(request, app.config.events.heartbeatMs, (output) => {
      let pending: ConversationSnapshot | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        clearTimeout(timer);
        timer = undefined;
        if (pending && output.ready) {
          output.send({ type: 'snapshot', snapshot: pending });
          pending = undefined;
        }
      };
      const unsubscribe = app.sessions.subscribe(workspaceId, conversationId, (snapshot) => {
        pending = snapshot;
        timer ??= setTimeout(flush, app.config.events.conversationBatchMs);
      });
      flush();
      return { flush, dispose() { unsubscribe(); clearTimeout(timer); } };
    });
  });
}

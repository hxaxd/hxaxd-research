import 'server-only';

import type { AppConfig } from '@/server/config.mjs';
import type { ConversationSnapshot } from '../schema';
import type { PiSessionRegistry } from './session-registry';

export function streamConversationEvents(
  request: Request,
  sessions: PiSessionRegistry,
  workspaceId: string,
  id: string,
  events: AppConfig['events'],
) {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  let flush: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let pending: ConversationSnapshot | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      flush = () => {
        timer = undefined;
        if (!closed && pending && (controller.desiredSize ?? 0) > 0) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'snapshot', snapshot: pending })}\n\n`),
          );
          pending = undefined;
        }
      };
      const unsubscribe = sessions.subscribe(workspaceId, id, (snapshot) => {
        pending = snapshot;
        timer ??= setTimeout(() => flush?.(), events.conversationBatchMs);
      });
      const heartbeat = setInterval(() => {
        if (!closed && (controller.desiredSize ?? 0) > 0)
          controller.enqueue(encoder.encode(': keepalive\n\n'));
      }, events.heartbeatMs);
      const abort = () => {
        if (!closed) {
          controller.close();
          cleanup?.();
        }
      };
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearTimeout(timer);
        clearInterval(heartbeat);
        request.signal.removeEventListener('abort', abort);
      };
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      flush();
    },
    pull() {
      flush?.();
    },
    cancel() {
      cleanup?.();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

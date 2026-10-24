import 'server-only';

import { watch } from 'node:fs';
import path from 'node:path';

import { getWorkspace } from '@/features/workspaces/server/workspaces';
import type { ReaderController } from './reader';

export function streamFileEvents(request: Request, root: string, workspaceId: string, reader: ReaderController) {
  getWorkspace(root, workspaceId);
  const encoder = new TextEncoder();
  let cleanup = () => {};
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const unsubscribe = reader.subscribe(workspaceId, (request) => {
          controller.enqueue(encoder.encode(`event: reader\ndata: ${JSON.stringify(request)}\n\n`));
        });
        const pending = new Set<string>();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const send = () => {
          timer = undefined;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ paths: [...pending] })}\n\n`),
          );
          pending.clear();
        };
        const watcher = watch(
          path.join(root, workspaceId),
          { recursive: true },
          (_event, filename) => {
            const name = filename?.toString().replaceAll('\\', '/') ?? '';
            if (name === '.pi' || name.startsWith('.pi/')) return;
            pending.add(name);
            timer ??= setTimeout(send, 100);
          },
        );
        watcher.on('error', (error) => {
          controller.error(error);
          cleanup();
        });
        const heartbeat = setInterval(
          () => controller.enqueue(encoder.encode(': keepalive\n\n')),
          15000,
        );
        const abort = () => {
          controller.close();
          cleanup();
        };
        cleanup = () => {
          unsubscribe();
          watcher.close();
          clearTimeout(timer);
          clearInterval(heartbeat);
          request.signal.removeEventListener('abort', abort);
        };
        request.signal.addEventListener('abort', abort, { once: true });
        controller.enqueue(encoder.encode(': connected\n\n'));
        if (request.signal.aborted) abort();
      },
      cancel() {
        cleanup();
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    },
  );
}

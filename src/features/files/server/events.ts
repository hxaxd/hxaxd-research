import 'server-only';

import { watch } from 'node:fs';
import path from 'node:path';

import { getWorkspace } from '@/features/workspaces/server/workspaces';
import type { AppConfig } from '@/server/config.mjs';
import type { ReaderController } from './reader';

export function streamFileEvents(request: Request, config: AppConfig, workspaceId: string, reader: ReaderController) {
  getWorkspace(config.workspaceDir, workspaceId);
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
          path.join(config.workspaceDir, workspaceId),
          { recursive: true },
          (_event, filename) => {
            const name = filename?.toString().replaceAll('\\', '/') ?? '';
            if (name === '.pi' || name.startsWith('.pi/')) return;
            pending.add(name);
            timer ??= setTimeout(send, config.events.fileBatchMs);
          },
        );
        watcher.on('error', (error) => {
          controller.error(error);
          cleanup();
        });
        const heartbeat = setInterval(
          () => controller.enqueue(encoder.encode(': keepalive\n\n')),
          config.events.heartbeatMs,
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

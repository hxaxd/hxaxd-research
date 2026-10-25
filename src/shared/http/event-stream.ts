import 'server-only';

type Output = {
  readonly ready: boolean;
  send: (data: unknown, event?: string) => void;
  error: (error: unknown) => void;
};
type Subscription = { dispose: () => void; flush?: () => void };

export function eventStream(
  request: Request,
  heartbeatMs: number,
  subscribe: (output: Output) => Subscription,
) {
  const encoder = new TextEncoder();
  let subscription: Subscription | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let abort: () => void;
  function dispose() {
    closed = true;
    clearInterval(heartbeat);
    request.signal.removeEventListener('abort', abort);
    subscription?.dispose();
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (closed) return;
        controller.close();
        dispose();
      };
      subscription = subscribe({
        get ready() { return !closed && (controller.desiredSize ?? 0) > 0; },
        send(data, event) {
          if (!closed) controller.enqueue(encoder.encode(
            `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`,
          ));
        },
        error(error) {
          if (closed) return;
          controller.error(error);
          dispose();
        },
      });
      controller.enqueue(encoder.encode(': connected\n\n'));
      heartbeat = setInterval(() => {
        if ((controller.desiredSize ?? 0) > 0)
          controller.enqueue(encoder.encode(': keepalive\n\n'));
      }, heartbeatMs);
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
    },
    pull() { subscription?.flush?.(); },
    cancel() { dispose(); },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

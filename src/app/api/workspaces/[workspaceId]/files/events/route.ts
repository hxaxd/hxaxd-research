import { watch } from 'node:fs';
import path from 'node:path';

import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { getWorkspace } from '@/app/workspaces/workspaces';
import { getAppRuntime } from '@/app/runtime';
import { eventStream } from '@/shared/http/event-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  return handleApiRequest(request, async () => {
    const { workspaceId } = await validatedIds(context);
    const app = getAppRuntime();
    getWorkspace(app.config.workspaceDir, workspaceId);
    return eventStream(request, app.config.events.heartbeatMs, (output) => {
      const pending = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(path.join(app.config.workspaceDir, workspaceId), { recursive: true }, (_event, filename) => {
        const name = filename?.toString().replaceAll('\\', '/') ?? '';
        if (name === '.pi' || name.startsWith('.pi/')) return;
        pending.add(name);
        timer ??= setTimeout(() => {
          timer = undefined;
          output.send({ paths: [...pending] });
          pending.clear();
        }, app.config.events.fileBatchMs);
      });
      watcher.on('error', output.error);
      const unsubscribe = app.reader.subscribe(workspaceId, (document) => output.send(document, 'reader'));
      return { dispose() { unsubscribe(); watcher.close(); clearTimeout(timer); } };
    });
  });
}

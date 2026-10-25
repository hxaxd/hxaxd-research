import 'server-only';

import type { ReaderRequest } from '../schema';

export class ReaderController {
  private readonly listeners = new Map<string, Set<(request: ReaderRequest) => void>>();

  subscribe(workspaceId: string, listener: (request: ReaderRequest) => void) {
    let listeners = this.listeners.get(workspaceId);
    if (!listeners) this.listeners.set(workspaceId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(workspaceId);
    };
  }

  open(workspaceId: string, request: ReaderRequest) {
    for (const listener of this.listeners.get(workspaceId) ?? []) listener(request);
  }
}

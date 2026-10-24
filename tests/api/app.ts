import { vi } from 'vitest';

import { createTestApp } from '../create-test-app';

export function restartApp() {
  delete (globalThis as typeof globalThis & { researchAppRuntime?: unknown }).researchAppRuntime;
}

export async function createApiTestApp() {
  const app = await createTestApp();
  vi.stubEnv('APP_DATA_DIR', app.config.dataDir);
  return {
    ...app,
    async cleanup() {
      restartApp();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await app.cleanup();
    },
  };
}

export function request(url: string, method = 'GET', body?: object, headers?: Record<string, string>) {
  return new Request(new URL(url, 'http://localhost'), {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function workspaceContext(workspaceId: string) {
  return { params: Promise.resolve({ workspaceId }) };
}

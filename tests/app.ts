import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';

import { POST as createWorkspace } from '@/app/api/workspaces/route';
import { getAppRuntime } from '@/server/runtime';

export function restartApp() {
  delete (globalThis as typeof globalThis & { researchAppRuntime?: unknown }).researchAppRuntime;
}

export async function createTestApp() {
  const root = path.resolve('.runtime/dev');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(path.join(root, 'test-'));
  vi.stubEnv('APP_DATA_DIR', dataDir);
  const { config } = getAppRuntime();
  const workspace = await (await createWorkspace(request('/workspaces', 'POST', {
    id: randomUUID(), name: '测试工作区',
  }))).json() as { id: string; name: string };
  return {
    config,
    workspace,
    async cleanup() {
      restartApp();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await rm(dataDir, { recursive: true, force: true });
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

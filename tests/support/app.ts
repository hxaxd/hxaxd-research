import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, vi } from 'vitest';

import { POST as createWorkspace } from '@/app/api/workspaces/route';
import { getAppRuntime } from '@/app/runtime';
import { workspaceSchema } from '@/app/workspaces/schema';

export function restartApp() {
  delete (globalThis as typeof globalThis & { researchAppRuntime?: unknown }).researchAppRuntime;
}

export async function createTestApp() {
  const root = path.resolve('.runtime/dev');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(path.join(root, 'test-'));
  const configFile = path.join(dataDir, 'config.jsonc');
  await writeFile(configFile, JSON.stringify({ dataDir }));
  vi.stubEnv('APP_CONFIG_FILE', configFile);
  const { config } = getAppRuntime();
  const response = await createWorkspace(request('/workspaces', 'POST', {
    id: randomUUID(), name: '测试工作区',
  }));
  expect(response.status).toBe(201);
  const workspace = workspaceSchema.parse(await response.json());
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

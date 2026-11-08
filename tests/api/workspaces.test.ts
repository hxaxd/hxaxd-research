import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { GET as workspaces, POST as createWorkspace } from '@/app/api/workspaces/route';
import { GET as workspace, PATCH as renameWorkspace } from '@/app/api/workspaces/[workspaceId]/route';
import { createTestApp, request, restartApp, workspaceContext } from '../support/app';

let app: Awaited<ReturnType<typeof createTestApp>>;
beforeEach(async () => { app = await createTestApp(); });
afterEach(async () => { await app.cleanup(); });

test('workspace identity and name persist and follow external metadata edits', async () => {
  const context = workspaceContext(app.workspace.id);
  const root = path.join(app.config.workspaceDir, app.workspace.id);
  const metadata = path.join(root, 'workspace.json');
  expect(JSON.parse(await readFile(metadata, 'utf8'))).not.toHaveProperty('papers');
  expect((await renameWorkspace(request('/workspace', 'PATCH', { name: '新名称' }), context)).status).toBe(200);
  expect(await (await workspaces(request('/workspaces'))).json()).toContainEqual(expect.objectContaining({ name: '新名称' }));
  const config = JSON.parse(await readFile(metadata, 'utf8'));
  config.name = '外部编辑';
  await writeFile(metadata, JSON.stringify(config));
  expect(await (await workspace(request('/workspace'), context)).json()).toMatchObject({ name: '外部编辑' });
  restartApp();
  expect(await (await workspaces(request('/workspaces'))).json()).toContainEqual(
    expect.objectContaining({ id: app.workspace.id, name: '外部编辑' }),
  );
  await writeFile(metadata, '{invalid');
  expect((await workspace(request('/workspace'), context)).status).toBe(422);
});

test('metadata writes reject duplicate identities and malformed requests without replacing the workspace', async () => {
  expect((await createWorkspace(request('/workspaces', 'POST', { id: app.workspace.id, name: '替换' }))).status).toBe(409);
  expect((await createWorkspace(request('/workspaces', 'POST', { id: '../../bad', name: '无效' }))).status).toBe(400);
  const context = workspaceContext(app.workspace.id);
  const response = await renameWorkspace(new Request('http://localhost/workspace', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{invalid',
  }), context);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_input' } });
  expect(await (await workspace(request('/workspace'), context)).json()).toMatchObject({ name: app.workspace.name });
  expect((await workspace(request('/workspace'), workspaceContext(randomUUID()))).status).toBe(404);
});

import { randomUUID } from 'node:crypto';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { GET as workspaces, POST as createWorkspace } from '@/app/api/workspaces/route';
import { GET as workspace, PATCH as renameWorkspace } from '@/app/api/workspaces/[workspaceId]/route';
import { GET as papers, POST as createPaper } from '@/app/api/workspaces/[workspaceId]/papers/route';
import { PATCH as renamePaper } from '@/app/api/workspaces/[workspaceId]/papers/[paperId]/route';
import { GET as files } from '@/app/api/workspaces/[workspaceId]/files/route';
import { GET as file } from '@/app/api/workspaces/[workspaceId]/file/route';
import { POST as importFiles } from '@/app/api/workspaces/[workspaceId]/imports/route';
import { GET as openapi } from '@/app/api/openapi/route';

import { pdfFixture } from '../pdf-fixture';
import { createApiTestApp, request, workspaceContext } from './app';

let app: Awaited<ReturnType<typeof createApiTestApp>>;
beforeEach(async () => { app = await createApiTestApp(); });
afterEach(async () => { await app.cleanup(); });

test('workspace and paper names persist, external metadata edits work, and papers belong to their workspace', async () => {
  const context = workspaceContext(app.workspace.id);
  const created = await createPaper(request('/papers', 'POST', { id: randomUUID(), name: '论文' }), context);
  expect(created.status).toBe(201);
  const paper = await created.json();
  expect((await renameWorkspace(request('/workspace', 'PATCH', { name: '新名称' }), context)).status).toBe(200);
  expect((await renamePaper(request('/paper', 'PATCH', { name: '新论文名' }), {
    params: Promise.resolve({ workspaceId: app.workspace.id, paperId: paper.id }),
  })).status).toBe(200);
  expect(await (await workspaces(request('/workspaces'))).json()).toContainEqual(expect.objectContaining({ name: '新名称' }));

  const metadata = path.join(app.config.workspaceDir, app.workspace.id, 'workspace.json');
  const config = JSON.parse(await readFile(metadata, 'utf8'));
  config.name = '外部编辑';
  config.papers[0].path = 'research/custom-location';
  await writeFile(metadata, JSON.stringify(config));
  expect(await (await workspace(request('/workspace'), context)).json()).toMatchObject({ name: '外部编辑' });
  expect(await (await papers(request('/papers'), context)).json()).toContainEqual(expect.objectContaining({ name: '新论文名', path: 'research/custom-location' }));

  const other = await (await createWorkspace(request('/workspaces', 'POST', { id: randomUUID(), name: '其他工作区' }))).json();
  expect((await renamePaper(request('/paper', 'PATCH', { name: '错误归属' }), {
    params: Promise.resolve({ workspaceId: other.id, paperId: paper.id }),
  })).status).toBe(404);
  await writeFile(metadata, '{invalid');
  expect((await workspace(request('/workspace'), context)).status).toBe(422);
});

test('HTTP boundaries reject invalid names, origins and paths while exposing ordinary filesystem files', async () => {
  expect((await createWorkspace(request('/workspaces', 'POST', { id: '../../bad', name: '无效' }))).status).toBe(400);
  expect((await createWorkspace(request('/workspaces', 'POST', { id: randomUUID(), name: '异源' }, { Origin: 'http://evil.example' }))).status).toBe(403);
  const browserRequest = request('http://localhost:4219/workspaces', 'POST', { id: randomUUID(), name: '本机浏览器' }, {
    Host: '127.0.0.1:4219', Origin: 'http://127.0.0.1:4219',
  });
  expect((await createWorkspace(browserRequest)).status).toBe(201);
  const root = path.join(app.config.workspaceDir, app.workspace.id);
  await writeFile(path.join(root, 'external.custom'), 'external');
  await symlink(app.config.piDir, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const context = workspaceContext(app.workspace.id);
  expect(await (await files(request('/files'), context)).json()).toContainEqual(expect.objectContaining({ name: 'external.custom' }));
  for (const candidate of ['../outside.txt', 'C:\\secret', 'escape/auth.json', 'a:stream', 'NUL.txt']) {
    const response = await file(request(`/file?path=${encodeURIComponent(candidate)}`), context);
    expect([400, 403]).toContain(response.status);
  }
  const schema = await (await openapi(request('/api/openapi'))).json();
  expect(schema.paths['/api/workspaces']).toHaveProperty('post');
});

test('imports preserve directories and existing material; file responses serve text and PDF byte ranges', async () => {
  const context = workspaceContext(app.workspace.id);
  function upload(name = 'source', filename = 'sections/body.tex') {
    const form = new FormData();
    form.set('metadata', JSON.stringify({ target: '', folderName: name }));
    form.append('files', new Blob(['\\input{sections/body.tex}']), 'main.tex');
    form.append('files', new Blob(['alpha']), filename);
    return new Request('http://localhost/imports', { method: 'POST', body: form });
  }
  expect((await importFiles(upload(), context)).status).toBe(201);
  expect(await (await file(request('/file?path=source/sections/body.tex&format=text'), context)).json()).toMatchObject({ text: 'alpha' });
  expect(await (await importFiles(upload(), context)).json()).toMatchObject({ path: 'source (1)' });
  expect((await importFiles(upload('batch', '../escape.txt'), context)).status).toBe(400);
  expect(await (await files(request('/files'), context)).json()).not.toContainEqual(expect.objectContaining({ name: 'batch' }));
  const bytes = pdfFixture();
  await writeFile(path.join(app.config.workspaceDir, app.workspace.id, 'paper.pdf'), bytes);
  const response = await file(request('/file?path=paper.pdf', 'GET', undefined, { Range: 'bytes=0-9' }), context);
  expect(response.status).toBe(206);
  expect(response.headers.get('Content-Range')).toBe(`bytes 0-9/${bytes.length}`);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(0, 10));
  expect((await file(request('/file?path=paper.pdf', 'GET', undefined, { Range: 'bytes=99999999-' }), context)).status).toBe(416);
});

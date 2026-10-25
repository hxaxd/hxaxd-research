import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { GET as workspaces, POST as createWorkspace } from '@/app/api/workspaces/route';
import { GET as workspace, PATCH as renameWorkspace } from '@/app/api/workspaces/[workspaceId]/route';
import { GET as files, POST as createDirectory } from '@/app/api/workspaces/[workspaceId]/files/route';
import { GET as file } from '@/app/api/workspaces/[workspaceId]/file/route';
import { POST as importFiles } from '@/app/api/workspaces/[workspaceId]/imports/route';
import { GET as openapi } from '@/app/api/openapi/route';
import { GET as preview } from '@/app/api/workspaces/[workspaceId]/preview/[...path]/route';
import { GET as changes } from '@/app/api/workspaces/[workspaceId]/files/events/route';

import { createTestApp, request, restartApp, workspaceContext } from '../app';

let app: Awaited<ReturnType<typeof createTestApp>>;
beforeEach(async () => { app = await createTestApp(); });
afterEach(async () => { await app.cleanup(); });

test('application configuration controls preview and upload limits through the file APIs', async () => {
  await writeFile(app.config.configFile, JSON.stringify({
    dataDir: app.config.dataDir,
    tempDir: path.join(app.config.dataDir, 'uploads'),
    files: { textBytes: 6, previewBytes: 3, uploadFileBytes: 6, uploadTotalBytes: 7 },
  }));
  restartApp();
  const context = workspaceContext(app.workspace.id);
  const root = path.join(app.config.workspaceDir, app.workspace.id);
  await writeFile(path.join(root, 'note.txt'), 'abcdef');
  expect(await (await file(request('/file?path=note.txt&format=text'), context)).json()).toMatchObject({ text: 'abc', truncated: true });
  await writeFile(path.join(root, 'large.txt'), 'abcdefg');
  expect((await file(request('/file?path=large.txt&format=text'), context)).status).toBe(413);
  expect(await (await file(request('/file?path=large.txt'), context)).text()).toBe('abcdefg');
  async function upload(contents: string[]) {
    const form = new FormData();
    form.set('metadata', JSON.stringify({ target: '', folderName: 'imported' }));
    contents.forEach((text, index) => form.append('files', new Blob([text]), `${index}.txt`));
    return importFiles(new Request('http://localhost/imports', { method: 'POST', body: form }), context);
  }
  expect((await upload(['abcdefgh'])).status).toBe(413);
  expect((await upload(['abcd', 'efgh'])).status).toBe(413);
  const accepted = await upload(['abcd']);
  expect(accepted.status).toBe(201);
  expect(await (await file(request('/file?path=imported/0.txt'), context)).text()).toBe('abcd');
});

test('workspace identity persists while materials follow the filesystem without registration', async () => {
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
  const created = await createDirectory(request('/files', 'POST', { path: '论文材料' }), context);
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ path: '论文材料' });
  await writeFile(path.join(root, '论文材料', '原文.md'), '# 论文');
  await rename(path.join(root, '论文材料'), path.join(root, '任意目录'));
  restartApp();
  expect(await (await files(request('/files'), context)).json()).toContainEqual(expect.objectContaining({ path: '任意目录', kind: 'directory' }));
  expect(await (await file(request('/file?path=任意目录/原文.md'), context)).text()).toBe('# 论文');
  expect(JSON.parse(await readFile(metadata, 'utf8'))).not.toHaveProperty('papers');
  await writeFile(metadata, '{invalid');
  expect((await workspace(request('/workspace'), context)).status).toBe(422);
});

test('directory creation checks paths and reports conflicts without replacing existing materials', async () => {
  const context = workspaceContext(app.workspace.id);
  expect((await createDirectory(request('/files', 'POST', { path: '材料' }), context)).status).toBe(201);
  expect((await createDirectory(request('/files', 'POST', { path: '材料/翻译' }), context)).status).toBe(201);
  expect((await createDirectory(request('/files', 'POST', { path: '材料' }), context)).status).toBe(409);
  expect((await createDirectory(request('/files', 'POST', { path: '../外部' }), context)).status).toBe(400);
  expect((await createDirectory(request('/files', 'POST', { path: '' }), context)).status).toBe(400);
  expect((await createDirectory(request('/files', 'POST', { path: '不存在/子目录' }), context)).status).toBe(404);
  expect((await createDirectory(request('/files', 'POST', { path: '目录' }), workspaceContext(randomUUID()))).status).toBe(404);
});

test('metadata writes reject duplicate identities and malformed requests without replacing the workspace', async () => {
  expect((await createWorkspace(request('/workspaces', 'POST', { id: app.workspace.id, name: '替换' }))).status).toBe(409);
  const context = workspaceContext(app.workspace.id);
  const response = await renameWorkspace(new Request('http://localhost/workspace', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{invalid',
  }), context);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_input' } });
  expect(await (await workspace(request('/workspace'), context)).json()).toMatchObject({ name: app.workspace.name });
  expect((await workspace(request('/workspace'), workspaceContext(randomUUID()))).status).toBe(404);
});

test('HTML previews serve their source and relative assets without allowing paths outside the workspace', async () => {
  const root = path.join(app.config.workspaceDir, app.workspace.id, 'panel');
  await mkdir(root);
  await writeFile(path.join(root, 'index.html'), '<img src="./figure.svg">');
  await writeFile(path.join(root, 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const context = (parts: string[]) => ({ params: Promise.resolve({ workspaceId: app.workspace.id, path: parts }) });
  const html = await preview(request('/preview/panel/index.html'), context(['panel', 'index.html']));
  expect(html.status).toBe(200);
  expect(html.headers.get('Content-Type')).toContain('text/html');
  expect(await html.text()).toContain('./figure.svg');
  const asset = await preview(request('/preview/panel/figure.svg'), context(['panel', 'figure.svg']));
  expect(asset.headers.get('Content-Type')).toBe('image/svg+xml');
  expect(await asset.text()).toContain('<svg');
  expect((await preview(request('/preview/outside'), context(['..', 'outside']))).status).toBe(400);
  expect((await preview(request('/preview/missing'), context(['missing']))).status).toBe(404);
});

test('material events report external file changes and exclude internal conversation files', async () => {
  const root = path.join(app.config.workspaceDir, app.workspace.id);
  await mkdir(path.join(root, '.pi'));
  const controller = new AbortController();
  const response = await changes(new Request('http://localhost/files/events', { signal: controller.signal }), workspaceContext(app.workspace.id));
  expect(response.headers.get('Content-Type')).toBe('text/event-stream');
  const reader = response.body!.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected');
    await writeFile(path.join(root, '.pi', 'session.jsonl'), '{}');
    await writeFile(path.join(root, 'external.md'), '# 外部新增');
    const notification = new TextDecoder().decode((await reader.read()).value);
    const event = JSON.parse(notification.split('data: ')[1]);
    expect(event.paths).toContain('external.md');
    expect(event.paths.some((name: string) => name.startsWith('.pi'))).toBe(false);
    controller.abort();
    expect((await reader.read()).done).toBe(true);
  } finally {
    await reader.cancel();
  }
});

test('file downloads support suffix ranges and empty files; binary content cannot be read as text', async () => {
  const root = path.join(app.config.workspaceDir, app.workspace.id);
  const context = workspaceContext(app.workspace.id);
  await writeFile(path.join(root, 'bytes.bin'), Buffer.from([0, 1, 2, 3]));
  const suffix = await file(request('/file?path=bytes.bin', 'GET', undefined, { Range: 'bytes=-2' }), context);
  expect(suffix.status).toBe(206);
  expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([2, 3]);
  expect(suffix.headers.get('Content-Disposition')).toContain('attachment');
  for (const [range, expected] of [['bytes=1-', [1, 2, 3]], ['bytes=0-99', [0, 1, 2, 3]]] as const) {
    const result = await file(request('/file?path=bytes.bin', 'GET', undefined, { Range: range }), context);
    expect(result.status).toBe(206);
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([...expected]);
  }
  expect((await file(request('/file?path=bytes.bin', 'GET', undefined, { Range: 'bytes=3-2' }), context)).status).toBe(416);
  expect((await file(request('/file?path=bytes.bin&format=text'), context)).status).toBe(400);
  await writeFile(path.join(root, 'empty.txt'), '');
  expect(await (await file(request('/file?path=empty.txt'), context)).text()).toBe('');
  expect((await file(request('/file?path=empty.txt', 'GET', undefined, { Range: 'bytes=0-' }), context)).status).toBe(416);
  expect((await file(request('/file?path=missing'), context)).status).toBe(404);
  expect((await file(request('/file?path=.'), context)).status).toBe(400);
});

test('invalid uploads are rejected as client input without adding material', async () => {
  const context = workspaceContext(app.workspace.id);
  const before = await (await files(request('/files'), context)).json();
  const response = await importFiles(request('/imports', 'POST', { metadata: {} }), context);
  expect(response.status).toBe(400);
  const empty = new FormData();
  empty.set('metadata', JSON.stringify({ target: '' }));
  expect((await importFiles(new Request('http://localhost/imports', { method: 'POST', body: empty }), context)).status).toBe(400);
  const repeated = new FormData();
  repeated.set('metadata', JSON.stringify({ target: '' }));
  repeated.append('files', new Blob(['first']), 'same.txt');
  repeated.append('files', new Blob(['second']), 'same.txt');
  expect((await importFiles(new Request('http://localhost/imports', { method: 'POST', body: repeated }), context)).status).toBe(409);
  expect(await (await files(request('/files'), context)).json()).toEqual(before);
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

test.each(['', 'notes'])('single-file imports into "%s" preserve names and keep existing content on a name collision', async target => {
  const context = workspaceContext(app.workspace.id);
  if (target) await mkdir(path.join(app.config.workspaceDir, app.workspace.id, target));
  async function upload(text: string) {
    const form = new FormData();
    form.set('metadata', JSON.stringify({ target }));
    form.append('files', new Blob([text]), 'paper.tex');
    const response = await importFiles(new Request('http://localhost/imports', { method: 'POST', body: form }), context);
    expect(response.status).toBe(201);
    return response.json();
  }
  const prefix = target ? `${target}/` : '';
  expect(await upload('original')).toMatchObject({ path: `${prefix}paper.tex`, bytes: 8 });
  expect(await upload('new')).toMatchObject({ path: `${prefix}paper (1).tex`, bytes: 3 });
  expect(await (await file(request(`/file?path=${prefix}paper.tex`), context)).text()).toBe('original');
  expect(await (await file(request(`/file?path=${prefix}paper%20(1).tex`), context)).text()).toBe('new');
});

test('batch imports without a directory name group their files under the returned path', async () => {
  const context = workspaceContext(app.workspace.id);
  const form = new FormData();
  form.set('metadata', JSON.stringify({ target: '' }));
  form.append('files', new Blob(['main']), 'main.tex');
  form.append('files', new Blob(['section']), 'sections/body.tex');
  const response = await importFiles(new Request('http://localhost/imports', { method: 'POST', body: form }), context);
  expect(response.status).toBe(201);
  const result = await response.json();
  expect(result.path).toBeTruthy();
  for (const [name, text] of [['main.tex', 'main'], ['sections/body.tex', 'section']])
    expect(await (await file(request(`/file?path=${result.path}/${name}`), context)).text()).toBe(text);
});

test('imports preserve directories and existing material; file responses serve text and byte ranges', async () => {
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
  const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  await writeFile(path.join(app.config.workspaceDir, app.workspace.id, 'sample.bin'), bytes);
  const response = await file(request('/file?path=sample.bin', 'GET', undefined, { Range: 'bytes=0-9' }), context);
  expect(response.status).toBe(206);
  expect(response.headers.get('Content-Range')).toBe(`bytes 0-9/${bytes.length}`);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(0, 10));
  expect((await file(request('/file?path=sample.bin', 'GET', undefined, { Range: 'bytes=99999999-' }), context)).status).toBe(416);
});

import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';
import { afterAll, beforeAll, expect, test } from 'vitest';

let directory: string | undefined;
let server: ReturnType<typeof fork> | undefined;
let closed: Promise<unknown> | undefined;
let base: string;

beforeAll(async () => {
  const root = path.resolve('.runtime/dev');
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(path.join(root, 'http-test-'));
  const project = path.join(directory, 'project');
  await mkdir(project);
  await Promise.all(['src', 'config.default.jsonc', 'package.json', 'next.config.ts', 'postcss.config.mjs', 'tsconfig.json'].map(
    name => cp(path.resolve(name), path.join(project, name), { recursive: true }),
  ));
  const config = path.join(directory, 'config.jsonc');
  await writeFile(config, JSON.stringify({ dataDir: path.join(directory, 'data'), tempDir: path.join(directory, 'uploads') }));
  const child = fork(fileURLToPath(new URL('../support/next-server.mjs', import.meta.url)), [project], {
    silent: true, execArgv: [],
    env: { ...process.env, NODE_ENV: 'development', APP_CONFIG_FILE: config },
  });
  server = child;
  let output = '';
  child.stdout?.on('data', chunk => { output += chunk; });
  child.stderr?.on('data', chunk => { output += chunk; });
  closed = new Promise(resolve => child.once('close', resolve));
  try {
    const [address] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(30_000) }),
      closed.then(() => { throw new Error('Next.js exited before listening'); }),
    ]);
    base = address;
  } catch (error) {
    throw new Error(`HTTP test server did not start.\n${output}`, { cause: error });
  }
}, 35_000);

afterAll(async () => {
  server?.kill();
  await closed;
  if (directory) await rm(directory, { recursive: true, force: true });
}, 15_000);

test('the HTTP interface publishes its OpenAPI document at the documented address', async () => {
  const response = await request(`${base}/api/openapi`, { signal: AbortSignal.timeout(15_000) });
  expect(response.statusCode).toBe(200);
  const document = await response.body.json() as { paths: Record<string, unknown> };
  expect(document.paths['/api/workspaces']).toHaveProperty('post');
  expect(document.paths['/api/workspaces/{workspaceId}/file']).toHaveProperty('get');
});

test('real workspace requests enforce their origin and return request-localized file errors', async () => {
  const name = '本机浏览器';
  const id = randomUUID();
  const create = (origin: string) => request(`${base}/api/workspaces`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ id, name }),
  });
  const rejected = await create('http://evil.example');
  expect(rejected.statusCode).toBe(403);
  expect(await rejected.body.json()).toMatchObject({ error: { code: 'invalid_origin' } });
  const created = await create(base);
  expect(created.statusCode).toBe(201);
  expect(await created.body.json()).toMatchObject({ id, name });

  const workspace = `${base}/api/workspaces/${id}`;
  await Promise.all([
    ['en', 'File or folder not found'],
    ['zh-CN', '文件或目录不存在'],
    ['unknown', '文件或目录不存在'],
  ].map(async ([language, message]) => {
    const options = { headers: { Cookie: `research-locale=${language}` }, signal: AbortSignal.timeout(15_000) };
    const response = await request(`${workspace}/file?path=missing.md`, options);
    expect(response.statusCode).toBe(404);
    expect(await response.body.json()).toMatchObject({ error: { code: 'file_missing', message } });
    expect(await (await request(workspace, options)).body.json()).toMatchObject({ name });
  }));

  const invalid = await request(`${workspace}/files`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', Origin: base, Cookie: 'research-locale=en' },
    body: JSON.stringify({ path: '' }),
  });
  expect(invalid.statusCode).toBe(400);
  expect(await invalid.body.json()).toMatchObject({ error: { code: 'invalid_input', message: 'Invalid input' } });
});

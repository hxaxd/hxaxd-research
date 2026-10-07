import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { freePort } from '../free-port';
test('production restart preserves data and history, interrupts a run and never resubmits it', async ({ request }) => {
  const directory = path.resolve('.tools', 'restart', randomUUID()); await mkdir(path.join(directory, 'pi'), { recursive: true });
  const config = JSON.parse(await readFile(path.join(process.env.RESEARCH_E2E_DATA!, 'pi', 'models.json'), 'utf8'));
  await writeFile(path.join(directory, 'pi', 'models.json'), JSON.stringify(config));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`; let child: ChildProcess | undefined; let output = '';
  async function start() {
    child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: process.cwd(), env: { ...process.env, APP_DATA_DIR: directory }, windowsHide: true });
    child.stdout?.on('data', chunk => { output += chunk; }); child.stderr?.on('data', chunk => { output += chunk; });
    await expect.poll(async () => { try { return (await request.get(`${base}/api/workspaces`)).status(); } catch { return 0; } }, { message: output }).toBe(200);
  }
  async function stop() { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } child = undefined; }
  try {
    await start();
    const workspaceId = randomUUID(), conversationId = randomUUID(), id = randomUUID();
    expect((await request.post(`${base}/api/workspaces`, { data: { id: workspaceId, name: '重启验证' } })).status()).toBe(201);
    await writeFile(path.join(directory, 'workspaces', workspaceId, 'retained.txt'), 'persistent material');
    await request.post(`${base}/api/workspaces/${workspaceId}/conversations`, { data: { id: conversationId, name: '保留对话' } });
    const url = `${base}/api/workspaces/${workspaceId}/conversations/${conversationId}`;
    const data = { id, text: '[SLOW]', model: 'test/test-model', materials: [] };
    expect((await request.post(`${url}/messages`, { data })).status()).toBe(202);
    await expect.poll(async () => (await (await request.get(url)).json()).messages.some((message: { role: string }) => message.role === 'assistant')).toBe(true);
    await stop(); await start();
    const history = await (await request.get(url)).json(); expect(history.run.status).toBe('interrupted'); expect(history.messages.some((message: { text: string }) => message.text.includes('[SLOW]'))).toBe(true);
    expect((await (await request.get(`${base}/api/workspaces/${workspaceId}/file?path=retained.txt&format=text`)).json()).text).toBe('persistent material');
    const before = (await (await request.get(`${config.providers.test.baseUrl}/stats`)).json()).calls;
    expect((await (await request.post(`${url}/messages`, { data })).json()).status).toBe('interrupted');
    expect((await (await request.get(`${config.providers.test.baseUrl}/stats`)).json()).calls).toBe(before);
  } finally { await stop(); }
});

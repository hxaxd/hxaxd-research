import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { POST as create, GET as list } from '@/app/api/workspaces/[workspaceId]/conversations/route';
import { GET as get, PATCH as rename } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/route';
import { POST as send } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/messages/route';
import { GET as events } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/events/route';
import { POST as stop } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/stop/route';
import { POST as createPaper } from '@/app/api/workspaces/[workspaceId]/papers/route';
import type { ConversationSnapshot } from '@/features/conversations/schema';

import { startModelServer } from '../model-server';
import { createApiTestApp, request, restartApp, workspaceContext } from './app';

let app: Awaited<ReturnType<typeof createApiTestApp>>;
let model: Awaited<ReturnType<typeof startModelServer>>;
let conversationId: string;
function context(workspaceId = app.workspace.id) {
  return { params: Promise.resolve({ workspaceId, conversationId }) };
}
async function snapshot(): Promise<ConversationSnapshot> {
  return (await get(request('/conversation'), context())).json();
}
async function complete(status = 'completed') {
  await expect.poll(async () => (await snapshot()).run?.status).toBe(status);
  return snapshot();
}
function message(text: string, extra: object = {}) {
  return send(request('/messages', 'POST', { id: randomUUID(), text, model: 'test/test-model', reading: null, ...extra }), context());
}
beforeEach(async () => {
  app = await createApiTestApp();
  model = await startModelServer();
  await writeFile(path.join(app.config.piDir, 'models.json'), JSON.stringify(model.config));
  conversationId = (await (await create(request('/conversations', 'POST', { id: randomUUID(), name: '讨论' }), workspaceContext(app.workspace.id))).json()).id;
});
afterEach(async () => {
  const run = (await snapshot()).run;
  if (run) await stop(request('/stop', 'POST', { id: run.id }), context());
  await model.close();
  await app.cleanup();
});

test('file editing persists, duplicate sends do not repeat work, and conversation names survive reload', async () => {
  await writeFile(path.join(app.config.workspaceDir, app.workspace.id, 'note.txt'), 'alpha');
  const id = randomUUID();
  expect((await message('[EDIT]', { id })).status).toBe(202);
  const first = await complete();
  expect(await readFile(path.join(app.config.workspaceDir, app.workspace.id, 'note.txt'), 'utf8')).toBe('beta');
  expect((await message('[EDIT]', { id })).status).toBe(202);
  expect((await snapshot()).messages).toEqual(first.messages);
  expect((await message('changed', { id })).status).toBe(409);
  expect((await rename(request('/conversation', 'PATCH', { name: '新标题' }), context())).status).toBe(200);
  restartApp();
  expect(await (await list(request('/conversations'), workspaceContext(app.workspace.id))).json()).toContainEqual(expect.objectContaining({ id: conversationId, name: '新标题' }));
  expect((await snapshot()).messages).toEqual(first.messages);
  expect((await send(request('/messages', 'POST', { id: randomUUID(), text: 'hello', model: 'test/test-model' }), context(randomUUID()))).status).toBe(404);
});

test('disconnecting the event stream keeps generation alive; competing sends fail and stop actually cancels', async () => {
  const response = await message('[SLOW]');
  const run = await response.json();
  const stream = await events(request('/events'), context());
  const reader = stream.body!.getReader();
  await reader.read();
  await reader.cancel();
  await expect.poll(async () => (await snapshot()).run?.status).toBe('running');
  expect((await message('competing')).status).toBe(409);
  expect((await stop(request('/stop', 'POST', { id: run.id }), context())).status).toBe(200);
  expect((await snapshot()).run?.status).toBe('cancelled');
});

test('native commands and workspace metadata produce real material, while service errors remain failures', async () => {
  await createPaper(request('/papers', 'POST', { id: randomUUID(), name: '当前论文' }), workspaceContext(app.workspace.id));
  await message('[WORKSPACE]');
  expect((await complete()).messages.at(-1)?.text).toContain('analysis/summary.custom');
  await message('[SHELL]');
  await complete();
  expect(await readFile(path.join(app.config.workspaceDir, 'native-command.txt'), 'utf8')).toBe('shell-output');
  await message('[FAIL]');
  const failed = await complete('failed');
  expect(failed.error).toContain('Test authentication failure');
});

test('current reading and quotes reach the model without altering user text, live or restored', async () => {
  await writeFile(path.join(app.config.workspaceDir, app.workspace.id, 'note.md'), '# 阅读笔记');
  const quote = { path: 'note.md', mode: 'preview', text: '阅读笔记' };
  const text = '[READING]\n\n<research-workbench-materials>\n这是用户自己输入的文字\n</research-workbench-materials>';
  await message(text, { reading: { path: 'note.md', page: 2 }, quotes: [quote] });
  const live = await complete();
  expect(live.messages.filter(item => item.role === 'user')).toEqual([expect.objectContaining({ text, quotes: [quote] })]);
  expect(live.messages.find(item => item.role === 'assistant')?.text).toContain('当前文件：note.md；当前页码：2');
  restartApp();
  expect((await snapshot()).messages).toEqual(live.messages);
});

test('unsupported image input fails without saving the question', async () => {
  await message('解释截图', { model: 'test/text-only', clips: [{ path: 'article.pdf', page: 2, data: Buffer.from('screenshot').toString('base64') }] });
  const failed = await complete('failed');
  expect(failed.error).toContain('不支持图片');
  expect(failed.messages).toEqual([]);
});

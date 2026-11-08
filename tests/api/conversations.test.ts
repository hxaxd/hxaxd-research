import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { POST as create, GET as list } from '@/app/api/workspaces/[workspaceId]/conversations/route';
import { GET as get, PATCH as rename } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/route';
import { POST as send } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/messages/route';
import { GET as events } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/events/route';
import { GET as image } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/images/route';
import { POST as stop } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/stop/route';
import { POST as answer } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/answers/route';
import { GET as fileEvents } from '@/app/api/workspaces/[workspaceId]/files/events/route';
import type { ConversationSnapshot } from '@/app/conversations/schema';

import { startModelServer } from '../support/model-server';
import { createTestApp, request, restartApp, workspaceContext } from '../support/app';

let app: Awaited<ReturnType<typeof createTestApp>>;
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
  app = await createTestApp();
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
  const event = JSON.parse(new TextDecoder().decode((await reader.read()).value).split('data: ')[1]);
  expect(event.type).toBe('snapshot');
  expect(event.snapshot.run.id).toBe(run.id);
  await reader.cancel();
  await expect.poll(async () => (await snapshot()).run?.status).toBe('running');
  expect((await message('competing')).status).toBe(409);
  expect((await stop(request('/stop', 'POST', { id: run.id }), context())).status).toBe(200);
  expect((await snapshot()).run?.status).toBe('cancelled');
  expect((await message('继续讨论')).status).toBe(202);
  expect((await complete()).messages.at(-1)?.text).toBe('测试回答');
});

test('stopping an idle conversation is harmless and a missing conversation returns not found', async () => {
  const response = await stop(request('/stop', 'POST', { id: randomUUID() }), context());
  expect(response.status).toBe(200);
  expect(await snapshot()).toMatchObject({ run: null, messages: [] });
  const missing = { params: Promise.resolve({ workspaceId: app.workspace.id, conversationId: randomUUID() }) };
  expect((await get(request('/conversation'), missing)).status).toBe(404);
  expect((await message('开始讨论')).status).toBe(202);
  expect((await complete()).messages.at(-1)?.text).toBe('测试回答');
});

test('images remain downloadable from conversation history after the runtime is reloaded', async () => {
  const data = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAO0lEQVRIiWMwTptJU8QwakHaaBDNHE1FxqMZbeZoUWE8WpqmjVY4xqNVZtpoq2LmaMMrbbTpOHNQt64BpuTIPb7rfhkAAAAASUVORK5CYII=';
  await message('请看截图', { clips: [{ path: 'figure.png', data }] });
  const saved = await complete();
  const url = saved.messages.find(item => item.role === 'user')!.images![0].url;
  restartApp();
  const response = await image(request(url), context());
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('image/png');
  expect(response.headers.get('Cache-Control')).toContain('private');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(data, 'base64'));
  expect((await image(request(url.replace('index=0', 'index=1')), context())).status).toBe(404);
  expect((await image(request('/images?message=invalid&index=0'), context())).status).toBe(400);
});

test('unknown models fail explicitly and unreadable references do not save a question', async () => {
  await message('hello', { model: 'test/missing' });
  expect((await complete('failed')).error).toContain('模型不可用');
  expect((await snapshot()).messages).toEqual([]);
  expect((await message('解释', { reading: { path: 'missing.md' } })).status).toBe(404);
  expect((await message('解释', { reading: { path: '' } })).status).toBe(400);
  expect((await message('解释', { quotes: [{ path: 'missing.md', text: '引用' }] })).status).toBe(404);
  expect((await snapshot()).messages).toEqual([]);
  expect((await create(request('/conversations', 'POST', { id: conversationId, name: '重复' }), workspaceContext(app.workspace.id))).status).toBe(409);
});

test('a rejected model request is reported as a failure', async () => {
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
  expect(JSON.parse(live.messages.find(item => item.role === 'assistant')!.text)).toEqual({
    reading: { path: 'note.md', page: 2 },
    quotes: [{ kind: 'text-quote', path: 'note.md', mode: 'preview', text: '阅读笔记' }],
  });
  restartApp();
  expect((await snapshot()).messages).toEqual(live.messages);
});

test('opening a document from a conversation tells the workspace reader which file and page to display', async () => {
  await writeFile(path.join(app.config.workspaceDir, app.workspace.id, 'paper.pdf'), '%PDF-1.7');
  const stream = await fileEvents(
    new Request('http://localhost/files/events', { signal: AbortSignal.timeout(8000) }),
    workspaceContext(app.workspace.id),
  );
  const reader = stream.body!.getReader();
  try {
    await reader.read();
    expect((await message('[OPEN]')).status).toBe(202);
    await complete();
    const decoder = new TextDecoder();
    let event = '';
    while (!event.includes('event: reader\n')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      event = decoder.decode(chunk.value);
    }
    expect(JSON.parse(event.split('data: ')[1])).toMatchObject({ conversationId, path: 'paper.pdf', page: 3 });
  } finally { await reader.cancel(); }
});

test('unsupported image input fails without saving the question', async () => {
  await message('解释截图', { model: 'test/text-only', clips: [{ path: 'article.pdf', page: 2, data: Buffer.from('screenshot').toString('base64') }] });
  const failed = await complete('failed');
  expect(failed.error).toContain('不支持图片');
  expect(failed.messages).toEqual([]);
});

test('questions wait for a clicked choice, survive reconnect and persist the answer in conversation history', async () => {
  await message('[ASK]');
  await expect.poll(async () => (await snapshot()).messages.find(item => item.question)?.question?.prompt).toBe('由谁完成翻译？');
  const waiting = await snapshot();
  const question = waiting.messages.find(item => item.question)!.question!;
  expect(waiting.run?.status).toBe('running');
  const stream = await events(request('/events'), context());
  await stream.body!.cancel();
  expect((await snapshot()).messages.find(item => item.question)?.question).toEqual(question);
  expect((await answer(request('/answers', 'POST', { id: question.id, answer: '' }), context())).status).toBe(400);
  expect((await answer(request('/answers', 'POST', { id: 'stale', answer: '当前助手' }), context())).status).toBe(409);
  expect((await answer(request('/answers', 'POST', { id: question.id, answer: '当前助手' }), context())).status).toBe(200);
  expect((await answer(request('/answers', 'POST', { id: question.id, answer: '注册模型' }), context())).status).toBe(409);
  const finished = await complete();
  expect(finished.messages.filter(item => item.question)).toHaveLength(1);
  expect(finished.messages.find(item => item.question)?.question?.answer).toBe('当前助手');
  expect(finished.messages.at(-1)?.text).toContain('当前助手');
  restartApp();
  expect((await snapshot()).messages).toEqual(finished.messages);
});

test.each(['自己的回答', null])('questions accept custom text or cancellation: %s', async value => {
  await message('[ASK]');
  await expect.poll(async () => (await snapshot()).messages.some(item => item.question)).toBe(true);
  const question = (await snapshot()).messages.find(item => item.question)!.question!;
  expect((await answer(request('/answers', 'POST', { id: question.id, answer: value }), context())).status).toBe(200);
  expect((await complete(value === null ? 'cancelled' : 'completed')).messages.find(item => item.question)?.question?.answer).toBe(value);
});

test('stopping a waiting question releases the run and rejects stale replies', async () => {
  await message('[ASK]');
  await expect.poll(async () => (await snapshot()).messages.some(item => item.question)).toBe(true);
  const waiting = await snapshot();
  const question = waiting.messages.find(item => item.question)!.question!;
  expect((await stop(request('/stop', 'POST', { id: waiting.run!.id }), context())).status).toBe(200);
  expect((await snapshot()).run?.status).toBe('cancelled');
  expect((await answer(request('/answers', 'POST', { id: question.id, answer: '迟到的回答' }), context())).status).toBe(409);
  await message('继续');
  await complete();
  const missing = { params: Promise.resolve({ workspaceId: app.workspace.id, conversationId: randomUUID() }) };
  expect((await answer(request('/answers', 'POST', { id: question.id, answer: '回答' }), missing)).status).toBe(404);
});

test('search uses hosted web results and preserves citations; unsupported protocols return command guidance', async () => {
  await message('[SEARCH]');
  expect((await complete()).messages.at(-1)?.text).toContain('"supported":false');
  const provider = { ...model.config.providers.test, api: 'openai-responses' };
  await writeFile(path.join(app.config.piDir, 'models.json'), JSON.stringify({ providers: { test: provider } }));
  restartApp();
  await message('[SEARCH]');
  const finished = await complete();
  const search = finished.messages.filter(item => item.toolName === 'web_search').at(-1)!;
  expect(search.isError).toBe(false);
  expect(search.args).toEqual({ query: 'Find the official paper' });
  const result = JSON.parse(search.text);
  expect(result.sources).toEqual([{ title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762' }]);
  expect(result.text).toContain('https://arxiv.org/abs/1706.03762');
});

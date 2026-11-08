import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GET as settings } from '@/app/api/model-providers/route';
import { GET as catalog } from '@/app/api/models/route';
import { POST as createConnection } from '@/app/api/model-providers/connections/route';
import { PATCH as updateConnection, DELETE as removeConnection } from '@/app/api/model-providers/connections/[id]/route';
import { POST as discover } from '@/app/api/model-providers/discover/route';
import { POST as createSpeech } from '@/app/api/speech/connections/route';
import { POST as createConversation } from '@/app/api/workspaces/[workspaceId]/conversations/route';
import { POST as send } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/messages/route';
import { GET as conversation } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/route';

import { startModelServer } from '../support/model-server';
import { createTestApp, request, restartApp, workspaceContext } from '../support/app';
import { cancel, login, openCallback, state } from '../support/chatgpt-authorization';

let app: Awaited<ReturnType<typeof createTestApp>>;
beforeEach(async () => { app = await createTestApp(); });
afterEach(async () => {
  const { authorization } = await state();
  if (authorization) await cancel(request('/authorization', 'DELETE', { id: authorization.id }));
  await app.cleanup();
});

test('editing or deleting a connection requires a stored provider with that ID', async () => {
  const config = path.join(app.config.piDir, 'models.json');
  const original = '{"providers":{}}\n';
  await writeFile(config, original);
  for (const id of ['constructor', '__proto__']) {
    const context = { params: Promise.resolve({ id }) };
    const url = `/model-providers/connections/${id}`;
    const updated = await updateConnection(request(url, 'PATCH', {
      baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', models: [{ id: 'example' }],
    }), context);
    const removed = await removeConnection(request(url, 'DELETE'), context);
    for (const response of [updated, removed]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'model_connection_missing' } });
    }
  }
  expect(await readFile(config, 'utf8')).toBe(original);
});

test('a failed account catalog leaves other configured providers usable', async () => {
  const server = await startModelServer();
  try {
    await writeFile(path.join(app.config.piDir, 'models.json'), JSON.stringify(server.config));
    const { callback } = await login({ catalogStatus: 503 });
    await openCallback(callback);
    await expect.poll(async () => (await state()).authorization.status).toBe('connected');
    const result = await (await catalog(request('/models'))).json();
    expect(result.models).toContainEqual(expect.objectContaining({ id: 'test/test-model' }));
    expect(result.issues).toContainEqual({ provider: 'openai', message: expect.stringContaining('503') });
  } finally { await server.close(); }
});

test('malformed model configuration is reported through the catalog without replacing the file', async () => {
  const config = path.join(app.config.piDir, 'models.json');
  await writeFile(config, '{invalid');
  const result = await (await catalog(request('/models'))).json();
  expect(result.models).toEqual([]);
  expect(result.issues).toContainEqual({ provider: 'configuration', message: expect.any(String) });
  expect((await settings(request('/model-providers'))).status).toBe(422);
  expect(await readFile(config, 'utf8')).toBe('{invalid');
});

test('an API-configured text service inherits known model capabilities and can answer after reload', async () => {
  const server = await startModelServer();
  try {
    const input = { name: '文字服务', api: 'openai-completions', baseUrl: server.config.providers.test.baseUrl,
      key: 'private-service-key', models: [{ id: 'gpt-6-luna' }] };
    const created = await createConnection(request('/connections', 'POST', input));
    expect(created.status).toBe(200);
    const result = await created.json();
    expect(JSON.stringify(result)).not.toContain('private-service-key');
    const saved = result.connections.find((item: { name: string }) => item.name === input.name);
    expect(saved.models[0]).toMatchObject({ id: 'gpt-6-luna', recognized: true, contextWindow: expect.any(Number), maxTokens: expect.any(Number) });
    expect(saved.models[0].contextWindow).toBeGreaterThan(0);
    restartApp();
    const model = `${saved.id}/gpt-6-luna`;
    expect((await (await catalog(request('/models'))).json()).models).toContainEqual(expect.objectContaining({ id: model, thinkingLevels: expect.arrayContaining(['high']) }));
    const id = randomUUID();
    await createConversation(request('/conversations', 'POST', { id, name: '讨论' }), workspaceContext(app.workspace.id));
    const context = { params: Promise.resolve({ workspaceId: app.workspace.id, conversationId: id }) };
    expect((await send(request('/messages', 'POST', { id: randomUUID(), text: '[REASONING]', model, thinkingLevel: 'high' }), context)).status).toBe(202);
    await expect.poll(async () => (await (await conversation(request('/conversation'), context)).json()).run?.status).toBe('completed');
    expect(JSON.parse((await (await conversation(request('/conversation'), context)).json()).messages.at(-1).text)).toEqual({ reasoning: 'high' });
  } finally { await server.close(); }
});

test('model information can be corrected and reset without losing connection credentials', async () => {
  const input = { api: 'openai-completions', baseUrl: 'http://localhost:9000/v1', key: 'retained-secret',
    models: [{ id: 'gpt-6-luna' }, { id: 'unknown-model' }] };
  const created = (await (await createConnection(request('/connections', 'POST', input))).json()).connections[0];
  const automatic = created.models[0];
  expect(created.models[1]).toMatchObject({ recognized: false, customized: false });
  expect(created.models[1]).not.toHaveProperty('contextWindow');
  expect(created.models[1]).not.toHaveProperty('vision');
  const context = { params: Promise.resolve({ id: created.id }) };
  const corrected = await updateConnection(request('/connections', 'PATCH', { ...input, key: '', models: [
    { id: 'gpt-6-luna', contextWindow: 8000, maxTokens: 1000, vision: false, reasoning: false },
    { id: 'unknown-model', contextWindow: 9000, maxTokens: 2000, vision: true },
  ] }), context);
  expect(corrected.status).toBe(200);
  expect((await corrected.json()).connections[0].models).toContainEqual(expect.objectContaining({ id: 'gpt-6-luna', contextWindow: 8000, vision: false, customized: true }));
  restartApp();
  const reset = await updateConnection(request('/connections', 'PATCH', { ...input, key: '',
    models: input.models.map(model => ({ ...model, reset: true })),
  }), context);
  expect(reset.status).toBe(200);
  const restored = (await reset.json()).connections[0].models;
  expect(restored[0]).toMatchObject({ contextWindow: automatic.contextWindow, maxTokens: automatic.maxTokens, vision: automatic.vision, reasoning: automatic.reasoning, customized: false });
  expect(restored[1]).not.toHaveProperty('contextWindow');
  expect(restored[1]).not.toHaveProperty('vision');
  const stored = JSON.parse(await readFile(path.join(app.config.piDir, 'models.json'), 'utf8'));
  expect(stored.providers[created.id].apiKey).toBe('retained-secret');
});

test('editing a service retains credentials and unrelated native settings; deleting it removes only that service', async () => {
  const file = path.join(app.config.piDir, 'models.json');
  const unrelated = { api: 'openai-completions', baseUrl: 'http://localhost:8000/v1', apiKey: 'other-key',
    models: [{ id: 'other-model', contextWindow: 9000, maxTokens: 1000, compat: { supportsStore: false } }] };
  await writeFile(file, '// User configuration\n' + JSON.stringify({ providers: { other: unrelated } }));
  const input = { name: '自定义', api: 'openai-completions', baseUrl: 'http://localhost:9000/v1',
    key: 'keep-this-key', models: [{ id: 'new-model', contextWindow: 12000, maxTokens: 2000, vision: true }] };
  const response = await createConnection(request('/connections', 'POST', input));
  expect(response.status).toBe(200);
  const created = (await response.json()).connections.find((item: { name: string }) => item.name === input.name);
  const context = { params: Promise.resolve({ id: created.id }) };
  const updated = await updateConnection(request('/connections', 'PATCH', { ...input, key: '', name: '改名' }), context);
  expect(updated.status).toBe(200);
  expect(JSON.stringify(await updated.json())).not.toContain('keep-this-key');
  let stored = JSON.parse(await readFile(file, 'utf8'));
  expect(stored.providers[created.id].apiKey).toBe('keep-this-key');
  expect(stored.providers.other).toEqual(unrelated);
  expect((await removeConnection(request('/connections', 'DELETE'), context)).status).toBe(200);
  stored = JSON.parse(await readFile(file, 'utf8'));
  expect(stored.providers).toEqual({ other: unrelated });
  expect((await removeConnection(request('/connections', 'DELETE'), context)).status).toBe(404);
  expect((await updateConnection(request('/connections', 'PATCH', input), context)).status).toBe(404);
});

test('model discovery reads IDs and distinguishes catalog capabilities from unknown models', async () => {
  const server = await startModelServer();
  try {
    const response = await discover(request('/discover', 'POST', { api: 'openai-completions', baseUrl: server.config.providers.test.baseUrl }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.models).toContainEqual(expect.objectContaining({ id: 'gpt-6-luna', recognized: true, contextWindow: expect.any(Number) }));
    expect(result.models).toContainEqual(expect.objectContaining({ id: 'test-model', name: 'test-model', recognized: false }));
  } finally { await server.close(); }
});

test('model discovery reuses saved text and speech credentials only on their origin and never returns them', async () => {
  const text = await createConnection(request('/connections', 'POST', { api: 'openai-completions', baseUrl: 'https://text.example/v1',
    key: 'text-secret', models: [{ id: 'custom-model' }] }));
  const connectionId = (await text.json()).connections[0].id;
  const speech = await createSpeech(request('/speech/connections', 'POST', { name: '语音', protocol: 'file',
    baseUrl: 'https://speech.example/v1', model: 'transcriber', key: 'speech-secret' }));
  const speechConnectionId = (await speech.json()).activeId;
  const outbound = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
    .mockImplementation(async () => Response.json({ data: [{ id: 'custom-model' }] }));
  vi.stubGlobal('fetch', outbound);
  for (const [value, url, authorization] of [
    [{ connectionId, baseUrl: 'https://text.example/v2/' }, 'https://text.example/v2/models', 'Bearer text-secret'],
    [{ speechConnectionId, baseUrl: 'https://speech.example/v1' }, 'https://speech.example/v1/models', 'Bearer speech-secret'],
    [{ connectionId, baseUrl: 'https://other.example/v1' }, 'https://other.example/v1/models', null],
    [{ speechConnectionId, baseUrl: 'http://speech.example/v1' }, 'http://speech.example/v1/models', null],
    [{ connectionId, baseUrl: 'https://text.example:8443/v1', key: 'new-key' }, 'https://text.example:8443/v1/models', 'Bearer new-key'],
    [{ connectionId, baseUrl: 'https://text.example/v1', clearKey: true }, 'https://text.example/v1/models', null],
  ] as const) {
    outbound.mockClear();
    const response = await discover(request('/discover', 'POST', { ...value, api: 'openai-completions' }));
    expect(response.status).toBe(200);
    const result = JSON.stringify(await response.json());
    expect(result).not.toMatch(/text-secret|speech-secret|new-key/);
    expect(outbound).toHaveBeenCalledTimes(1);
    const [destination, init] = outbound.mock.calls[0];
    expect(destination).toBe(url);
    expect(new Headers(init.headers).get('Authorization')).toBe(authorization);
    if (authorization) expect(init.redirect).toBe('error');
  }
});

test('moving a saved text connection to another origin drops the old credential', async () => {
  const input = { api: 'openai-completions', baseUrl: 'https://text.example/v1',
    key: 'text-secret', models: [{ id: 'custom-model' }] };
  const created = await createConnection(request('/connections', 'POST', input));
  expect(created.status).toBe(200);
  const { id } = (await created.json()).connections[0];
  const moved = await updateConnection(request('/connection', 'PATCH', {
    ...input, baseUrl: 'https://other.example/v1', key: '',
  }), { params: Promise.resolve({ id }) });
  expect(moved.status).toBe(200);
  const stored = await readFile(path.join(app.config.piDir, 'models.json'), 'utf8');
  expect(JSON.parse(stored).providers[id].baseUrl).toBe('https://other.example/v1');
  expect(stored).not.toContain('text-secret');
});

test('invalid connection inputs and failed upstream discovery do not overwrite model configuration', async () => {
  const file = path.join(app.config.piDir, 'models.json');
  const original = '{ "providers": {} }';
  await writeFile(file, original);
  expect((await createConnection(request('/connections', 'POST', { baseUrl: 'file:///tmp', api: 'openai-completions', models: [] }))).status).toBe(400);
  const input = { api: 'openai-completions', baseUrl: 'https://service.example/v1', key: 'private-key' };
  for (const result of [new Response('private-key', { status: 401 }), Response.json({ wrong: [] })]) {
    vi.stubGlobal('fetch', async () => result);
    const response = await discover(request('/discover', 'POST', input));
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('private-key');
  }
  expect(await readFile(file, 'utf8')).toBe(original);
});

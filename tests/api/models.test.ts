import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GET as settings } from '@/app/api/model-providers/route';
import { GET as catalog } from '@/app/api/models/route';
import { POST as connectRoute, DELETE as cancelRoute } from '@/app/api/model-providers/[providerId]/authorization/route';
import { POST as submitRoute } from '@/app/api/model-providers/[providerId]/authorization/callback/route';
import { DELETE as disconnectRoute } from '@/app/api/model-providers/[providerId]/route';
import { POST as realtime } from '@/app/api/speech/realtime/route';
import { POST as testSpeech } from '@/app/api/speech/test/route';
import { POST as transcribe } from '@/app/api/speech/transcriptions/route';
import { POST as createConnection } from '@/app/api/model-providers/connections/route';
import { PATCH as updateConnection, DELETE as removeConnection } from '@/app/api/model-providers/connections/[id]/route';
import { POST as discover } from '@/app/api/model-providers/discover/route';
import { GET as speechSettings, PATCH as selectSpeech } from '@/app/api/speech/route';
import { POST as createSpeech } from '@/app/api/speech/connections/route';
import { POST as createConversation } from '@/app/api/workspaces/[workspaceId]/conversations/route';
import { POST as send } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/messages/route';
import { GET as conversation } from '@/app/api/workspaces/[workspaceId]/conversations/[conversationId]/route';

import { startModelServer } from '../model-server';
import { createTestApp, request, restartApp, workspaceContext } from '../app';

const execute = promisify(execFile);
const networkFetch = globalThis.fetch;
const signing = await generateKeyPair('RS256');
const publicKey = { ...(await exportJWK(signing.publicKey)), kid: 'test-key' };
let app: Awaited<ReturnType<typeof createTestApp>>;
beforeEach(async () => { app = await createTestApp(); });
const providerContext = (providerId = 'openai') => ({ params: Promise.resolve({ providerId }) });
const connect = (request: Request) => connectRoute(request, providerContext());
const cancel = (request: Request) => cancelRoute(request, providerContext());
const submit = (request: Request) => submitRoute(request, providerContext());
const disconnect = (request: Request) => disconnectRoute(request, providerContext());
async function state() { return (await settings(request('/model-providers'))).json(); }
afterEach(async () => {
  const { authorization } = await state();
  if (authorization) await cancel(request('/authorization', 'DELETE', { id: authorization.id }));
  await app.cleanup();
});

async function login(options: { invalidNonce?: boolean; catalogStatus?: number; tokenStatus?: number; scope?: string } = {}) {
  const id = randomUUID();
  expect((await connect(request('/authorization', 'POST', { id }))).status).toBe(200);
  await expect.poll(async () => (await state()).authorization?.url).toBeTruthy();
  const authorization = new URL((await state()).authorization.url);
  const callback = new URL(authorization.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({
    code: 'test-code', state: authorization.searchParams.get('state')!, client_id: 'oaiapp_test',
  }).toString();
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({ keys: [publicKey] });
    if (url === 'https://api.openai.com/v1/models') {
      if (options.catalogStatus) return new Response(null, { status: options.catalogStatus });
      return Response.json({ models: [
        { slug: 'gpt-6-luna', display_name: '账号可用模型', visibility: 'list' },
        { slug: 'not-in-sdk', display_name: '未知模型', visibility: 'list' },
      ] });
    }
    expect(url).toBe('https://auth.openai.com/api/accounts/oauth/token');
    const body = new URLSearchParams(init!.body as URLSearchParams);
    expect(body.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'));
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
    if (options.tokenStatus) return new Response(null, { status: options.tokenStatus });
    const identity = await new SignJWT({ nonce: options.invalidNonce ? 'wrong' : authorization.searchParams.get('nonce') })
      .setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).setIssuer('https://auth.openai.com')
      .setAudience('oaiapp_test').setSubject('test-account').setExpirationTime('1h').sign(signing.privateKey);
    return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', id_token: identity,
      expires_in: 3600, scope: options.scope ?? 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
  });
  return { id, callback };
}

test.each(['browser', 'manual'])('ChatGPT %s callback connects, survives reload and disconnects without exposing credentials', async method => {
  const { id, callback } = await login();
  const unrelated = new URL(callback);
  unrelated.searchParams.set('state', 'unrelated');
  expect((await networkFetch(unrelated)).status).toBe(400);
  if (method === 'browser') expect((await networkFetch(callback)).status).toBe(200);
  else expect((await submit(request('/callback', 'POST', { id, url: String(callback) }))).status).toBe(200);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
  expect((await state()).authorization.providerId).toBe('openai');
  expect(await (await speechSettings(request('/speech'))).json()).toMatchObject({
    activeId: 'chatgpt', chatgpt: { connected: true },
  });
  expect(JSON.stringify(await state())).not.toContain('private-');
  const models = await (await catalog(request('/models'))).json();
  expect(models.models).toContainEqual(expect.objectContaining({ id: 'openai/gpt-6-luna', name: '账号可用模型' }));
  expect(models.models).not.toContainEqual(expect.objectContaining({ id: 'openai/not-in-sdk' }));
  if (method === 'manual') {
    const upstream = `globalThis.fetch = async input => {
      if (String(input) !== 'https://api.openai.com/v1/models') throw new Error('Unexpected external request');
      return Response.json({ models: [{ slug: 'gpt-6-luna', display_name: '账号可用模型', visibility: 'list' }] });
    };`;
    const args = ['--import', 'data:text/javascript,' + encodeURIComponent(upstream),
      path.resolve('src/app/models/invoke.mjs'), '--pi-dir', app.config.piDir, '--list'];
    const native = JSON.parse((await execute(process.execPath, args)).stdout);
    expect(native.models).toEqual([expect.objectContaining({ id: 'openai/gpt-6-luna', name: '账号可用模型' })]);
    expect(JSON.stringify(native)).not.toContain('private-');
    await expect(execute(process.execPath, [...args, '--model', 'openai/gpt-4.1'])).rejects.toThrow('模型不可用');
  }
  restartApp();
  expect((await state()).providers).toContainEqual(expect.objectContaining({ id: 'openai', subscription: true, connected: true }));
  await disconnect(request('/openai', 'DELETE'));
  expect(await (await speechSettings(request('/speech'))).json()).toMatchObject({
    activeId: null, chatgpt: { connected: false },
  });
  expect((await state()).providers).not.toContainEqual(expect.objectContaining({ id: 'openai' }));
});

test('an existing ChatGPT connection can authorize again using its registered client', async () => {
  const first = await login();
  await networkFetch(first.callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
  restartApp();
  const second = await login();
  second.callback.searchParams.delete('client_id');
  expect((await networkFetch(second.callback)).status).toBe(200);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
  restartApp();
  expect((await state()).providers).toContainEqual(expect.objectContaining({ id: 'openai', subscription: true, connected: true }));
  const models = await (await catalog(request('/models'))).json();
  expect(models.models).toContainEqual(expect.objectContaining({ id: 'openai/gpt-6-luna' }));
});

test.each([
  { options: { tokenStatus: 503 }, reason: 'token exchange' },
  { options: { scope: 'openid profile email' }, reason: 'missing model scope' },
])('unsuccessful authorization ($reason) leaves the provider disconnected and allows retry', async ({ options }) => {
  const first = await login(options);
  await networkFetch(first.callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('failed');
  expect((await state()).authorization.error).toBeTruthy();
  expect((await state()).providers).not.toContainEqual(expect.objectContaining({ id: 'openai' }));
  const retry = await login();
  await networkFetch(retry.callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
});

test('denying ChatGPT authorization reports the refusal and allows a new attempt', async () => {
  const first = await login();
  first.callback.searchParams.delete('code');
  first.callback.searchParams.set('error', 'access_denied');
  expect((await networkFetch(first.callback)).status).toBe(400);
  await expect.poll(async () => (await state()).authorization.status).toBe('failed');
  expect((await state()).authorization.error).toContain('access_denied');
  expect((await state()).providers).not.toContainEqual(expect.objectContaining({ id: 'openai' }));
  const retry = await login();
  await networkFetch(retry.callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
});

test('competing authorization is rejected, cancellation permits retry, and invalid identity does not connect', async () => {
  const first = await login();
  expect((await connect(request('/authorization', 'POST', { id: first.id }))).status).toBe(200);
  expect((await connect(request('/authorization', 'POST', { id: randomUUID() }))).status).toBe(409);
  expect((await cancel(request('/authorization', 'DELETE', { id: first.id }))).status).toBe(200);
  expect((await state()).authorization.status).toBe('cancelled');
  const invalid = await login({ invalidNonce: true });
  expect((await networkFetch(invalid.callback)).status).toBe(200);
  await expect.poll(async () => (await state()).authorization.status).toBe('failed');
  expect((await state()).authorization.error).toContain('身份令牌');
  expect((await state()).providers).not.toContainEqual(expect.objectContaining({ id: 'openai' }));
});

test('a failed account catalog leaves other configured providers usable', async () => {
  const server = await startModelServer();
  try {
    await writeFile(path.join(app.config.piDir, 'models.json'), JSON.stringify(server.config));
    const { callback } = await login({ catalogStatus: 503 });
    await networkFetch(callback);
    await expect.poll(async () => (await state()).authorization.status).toBe('connected');
    const result = await (await catalog(request('/models'))).json();
    expect(result.models).toContainEqual(expect.objectContaining({ id: 'test/test-model' }));
    expect(result.issues).toContainEqual({ provider: 'openai', message: expect.stringContaining('503') });
  } finally { await server.close(); }
});

test('connected ChatGPT authorization can establish and test realtime speech without returning credentials', async () => {
  const { callback } = await login();
  await networkFetch(callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
  const authorizationFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/realtime/client_secrets')) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-access');
      return Response.json({ value: 'temporary-speech-key' });
    }
    if (url.endsWith('/realtime/calls')) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer temporary-speech-key');
      expect(init?.body).toBe('offer');
      return new Response('speech-answer');
    }
    return authorizationFetch(input, init);
  });
  const answer = await realtime(request('/speech/realtime', 'POST', { connectionId: 'chatgpt', sdp: 'offer' }));
  expect(await answer.json()).toEqual({ sdp: 'speech-answer' });
  const testResult = await testSpeech(request('/speech/test', 'POST', { connectionId: 'chatgpt' }));
  expect(await testResult.json()).toMatchObject({ ok: true });
  const form = new FormData();
  form.set('connectionId', 'chatgpt');
  form.set('audio', new Blob(['audio']), 'audio.wav');
  expect((await transcribe(new Request('http://localhost/transcriptions', { method: 'POST', body: form }))).status).toBe(409);
});

test('authorization callbacks and cancellation reject attempts that are not awaiting a response', async () => {
  const id = randomUUID();
  expect((await cancel(request('/authorization', 'DELETE', { id }))).status).toBe(409);
  expect((await submit(request('/callback', 'POST', { id, url: 'http://127.0.0.1:1455/auth/callback?code=x' }))).status).toBe(409);
  expect((await connect(request('/authorization', 'POST', {}))).status).toBe(400);
  expect((await state()).authorization).toBeNull();
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

test('model discovery reuses saved text and speech credentials without returning them', async () => {
  const text = await createConnection(request('/connections', 'POST', { api: 'openai-completions', baseUrl: 'https://text.example/v1',
    key: 'text-secret', models: [{ id: 'custom-model' }] }));
  const connectionId = (await text.json()).connections[0].id;
  const speech = await createSpeech(request('/speech/connections', 'POST', { name: '语音', protocol: 'file',
    baseUrl: 'https://speech.example/v1', model: 'transcriber', key: 'speech-secret' }));
  const speechConnectionId = (await speech.json()).activeId;
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('Authorization')).toBe(input.includes('text.example') ? 'Bearer text-secret' : 'Bearer speech-secret');
    return Response.json({ data: [{ id: 'custom-model' }] });
  });
  for (const value of [{ connectionId, baseUrl: 'https://text.example/v1' }, { speechConnectionId, baseUrl: 'https://speech.example/v1' }]) {
    const response = await discover(request('/discover', 'POST', { ...value, api: 'openai-completions' }));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('-secret');
  }
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

test('an empty installation lists available authorization methods without registering connections', async () => {
  expect(await state()).toMatchObject({
    providers: [], connections: [], authorization: null,
    authorizationProviders: expect.arrayContaining([{ id: 'openai', name: 'ChatGPT', capabilities: ['text', 'speech'] }]),
  });
  expect(await (await speechSettings(request('/speech'))).json()).toMatchObject({
    activeId: null, connections: [], chatgpt: { connected: false },
  });
  expect((await selectSpeech(request('/speech', 'PATCH', { activeId: 'chatgpt' }))).status).toBe(409);
  expect((await connectRoute(request('/authorization', 'POST', { id: randomUUID() }), providerContext('unknown'))).status).toBe(404);
  expect((await state()).authorization).toBeNull();
});

test('adding and removing account authorization preserves a selected API speech connection', async () => {
  const created = await createSpeech(request('/speech/connections', 'POST', {
    name: 'API speech', baseUrl: 'https://api.example.com/v1', protocol: 'file', model: 'transcribe',
  }));
  const { activeId } = await created.json();
  const { callback } = await login();
  await networkFetch(callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
  expect(await (await speechSettings(request('/speech'))).json()).toMatchObject({
    activeId, chatgpt: { connected: true },
  });
  await disconnect(request('/openai', 'DELETE'));
  expect(await (await speechSettings(request('/speech'))).json()).toMatchObject({
    activeId, chatgpt: { connected: false },
  });
});

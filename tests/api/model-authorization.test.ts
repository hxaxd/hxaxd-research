import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { GET as catalog } from '@/app/api/models/route';
import { POST as connectRoute } from '@/app/api/model-providers/[providerId]/authorization/route';
import { GET as speechSettings } from '@/app/api/speech/route';
import { POST as createSpeech } from '@/app/api/speech/connections/route';

import { createTestApp, request, restartApp } from '../support/app';
import { cancel, connect, disconnect, login, openCallback, providerContext, state, submit } from '../support/chatgpt-authorization';

let app: Awaited<ReturnType<typeof createTestApp>>;
beforeEach(async () => { app = await createTestApp(); });
afterEach(async () => {
  const { authorization } = await state();
  if (authorization) await cancel(request('/authorization', 'DELETE', { id: authorization.id }));
  await app.cleanup();
});

test('a malformed loopback request returns 400 and leaves authorization available', async () => {
  const { callback } = await login();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    get({ hostname: callback.hostname, port: callback.port, path: '//%', signal: AbortSignal.timeout(5000) }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  expect(status).toBe(400);
  expect(await openCallback(callback)).toBe(200);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
});

test.each(['browser', 'manual'])('ChatGPT %s callback connects, survives reload and disconnects without exposing credentials', async method => {
  const { id, callback } = await login();
  const unrelated = new URL(callback);
  unrelated.searchParams.set('state', 'unrelated');
  expect(await openCallback(unrelated)).toBe(400);
  if (method === 'browser') expect(await openCallback(callback)).toBe(200);
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
  await openCallback(first.callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
  restartApp();
  const second = await login();
  second.callback.searchParams.delete('client_id');
  expect(await openCallback(second.callback)).toBe(200);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
  restartApp();
  expect((await state()).providers).toContainEqual(expect.objectContaining({ id: 'openai', subscription: true, connected: true }));
  const models = await (await catalog(request('/models'))).json();
  expect(models.models).toContainEqual(expect.objectContaining({ id: 'openai/gpt-6-luna' }));
});

test.each([
  { options: { tokenStatus: 403, tokenError: 'unsupported_country_region_territory' }, reason: 'unsupported region' },
  { options: { tokenStatus: 403, tokenError: 'access_denied' }, reason: 'upstream refusal' },
  { options: { tokenStatus: 503 }, reason: 'token exchange' },
  { options: { networkFailure: true }, reason: 'network connection' },
  { options: { scope: 'openid profile email' }, reason: 'missing model scope' },
])('unsuccessful authorization ($reason) leaves the provider disconnected and allows retry', async ({ options }) => {
  const first = await login(options);
  await openCallback(first.callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('failed');
  expect((await state()).authorization.error).toBeTruthy();
  if (options.tokenStatus) expect((await state()).authorization.error).toContain(String(options.tokenStatus));
  if (options.tokenError) expect((await state()).authorization.error).toContain(options.tokenError);
  if (options.networkFailure) expect((await state()).authorization.error).toContain('网络与代理');
  expect((await state()).providers).not.toContainEqual(expect.objectContaining({ id: 'openai' }));
  const retry = await login();
  await openCallback(retry.callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
});

test('denying ChatGPT authorization reports the refusal and allows a new attempt', async () => {
  const first = await login();
  first.callback.searchParams.delete('code');
  first.callback.searchParams.set('error', 'access_denied');
  expect(await openCallback(first.callback)).toBe(400);
  await expect.poll(async () => (await state()).authorization.status).toBe('failed');
  expect((await state()).authorization.error).toContain('access_denied');
  expect((await state()).providers).not.toContainEqual(expect.objectContaining({ id: 'openai' }));
  const retry = await login();
  await openCallback(retry.callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
});

test('competing authorization is rejected, cancellation permits retry, and invalid identity does not connect', async () => {
  const first = await login();
  expect((await connect(request('/authorization', 'POST', { id: first.id }))).status).toBe(200);
  expect((await connect(request('/authorization', 'POST', { id: randomUUID() }))).status).toBe(409);
  expect((await cancel(request('/authorization', 'DELETE', { id: first.id }))).status).toBe(200);
  expect((await state()).authorization.status).toBe('cancelled');
  const invalid = await login({ invalidNonce: true });
  expect(await openCallback(invalid.callback)).toBe(200);
  await expect.poll(async () => (await state()).authorization.status).toBe('failed');
  expect((await state()).authorization.error).toContain('身份令牌');
  expect((await state()).providers).not.toContainEqual(expect.objectContaining({ id: 'openai' }));
});

test('authorization callbacks and cancellation reject attempts that are not awaiting a response', async () => {
  const id = randomUUID();
  expect((await cancel(request('/authorization', 'DELETE', { id }))).status).toBe(409);
  expect((await submit(request('/callback', 'POST', { id, url: 'http://127.0.0.1:1455/auth/callback?code=x' }))).status).toBe(409);
  expect((await connect(request('/authorization', 'POST', {}))).status).toBe(400);
  expect((await state()).authorization).toBeNull();
});

test('an empty installation lists available authorization methods without registering connections', async () => {
  expect(await state()).toMatchObject({
    providers: [], connections: [], authorization: null,
    authorizationProviders: expect.arrayContaining([{ id: 'openai', name: 'ChatGPT', capabilities: ['text', 'speech'] }]),
  });
  expect((await connectRoute(request('/authorization', 'POST', { id: randomUUID() }), providerContext('unknown'))).status).toBe(404);
  expect((await state()).authorization).toBeNull();
});

test('adding and removing account authorization preserves a selected API speech connection', async () => {
  const created = await createSpeech(request('/speech/connections', 'POST', {
    name: 'API speech', baseUrl: 'https://api.example.com/v1', protocol: 'file', model: 'transcribe',
  }));
  const { activeId } = await created.json();
  const { callback } = await login();
  await openCallback(callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('connected');
  expect(await (await speechSettings(request('/speech'))).json()).toMatchObject({
    activeId, chatgpt: { connected: true },
  });
  await disconnect(request('/openai', 'DELETE'));
  expect(await (await speechSettings(request('/speech'))).json()).toMatchObject({
    activeId, chatgpt: { connected: false },
  });
});

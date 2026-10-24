import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GET as settings } from '@/app/api/model-providers/route';
import { GET as catalog } from '@/app/api/models/route';
import { POST as connect, DELETE as cancel } from '@/app/api/model-providers/openai/authorization/route';
import { POST as submit } from '@/app/api/model-providers/openai/authorization/callback/route';
import { DELETE as disconnect } from '@/app/api/model-providers/openai/route';
import { POST as realtime } from '@/app/api/speech/realtime/route';
import { POST as testSpeech } from '@/app/api/speech/test/route';
import { POST as transcribe } from '@/app/api/speech/transcriptions/route';

import { startModelServer } from '../model-server';
import { createTestApp, request, restartApp } from '../app';

const networkFetch = globalThis.fetch;
const signing = await generateKeyPair('RS256');
const publicKey = { ...(await exportJWK(signing.publicKey)), kid: 'test-key' };
let app: Awaited<ReturnType<typeof createTestApp>>;
beforeEach(async () => { app = await createTestApp(); });
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
  expect(JSON.stringify(await state())).not.toContain('private-');
  const models = await (await catalog(request('/models'))).json();
  expect(models.models).toContainEqual(expect.objectContaining({ id: 'openai/gpt-6-luna', name: '账号可用模型' }));
  expect(models.models).not.toContainEqual(expect.objectContaining({ id: 'openai/not-in-sdk' }));
  restartApp();
  expect((await state()).providers).toContainEqual(expect.objectContaining({ id: 'openai', subscription: true, connected: true }));
  await disconnect(request('/openai', 'DELETE'));
  expect((await state()).providers).toContainEqual(expect.objectContaining({ id: 'openai', subscription: false }));
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
  { options: { tokenStatus: 503 }, error: '令牌交换失败' },
  { options: { scope: 'openid profile email' }, error: '未授予' },
])('unsuccessful authorization ($error) leaves the provider disconnected and allows retry', async ({ options, error }) => {
  const first = await login(options);
  await networkFetch(first.callback);
  await expect.poll(async () => (await state()).authorization.status).toBe('failed');
  expect((await state()).authorization.error).toContain(error);
  expect((await state()).providers).toContainEqual(expect.objectContaining({ id: 'openai', connected: false }));
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
  expect((await state()).providers).toContainEqual(expect.objectContaining({ id: 'openai', connected: false }));
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
  expect((await state()).providers).toContainEqual(expect.objectContaining({ id: 'openai', subscription: false }));
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
  expect(await readFile(config, 'utf8')).toBe('{invalid');
});

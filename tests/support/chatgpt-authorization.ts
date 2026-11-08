import { createHash, randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, vi } from 'vitest';

import { GET as settings } from '@/app/api/model-providers/route';
import { POST as connectRoute, DELETE as cancelRoute } from '@/app/api/model-providers/[providerId]/authorization/route';
import { POST as submitRoute } from '@/app/api/model-providers/[providerId]/authorization/callback/route';
import { DELETE as disconnectRoute } from '@/app/api/model-providers/[providerId]/route';
import { request } from './app';

const signing = await generateKeyPair('RS256');
const publicKey = { ...(await exportJWK(signing.publicKey)), kid: 'test-key' };

export function openCallback(url: URL) {
  expect(url.protocol).toBe('http:');
  expect(url.hostname).toBe('127.0.0.1');
  return new Promise<number | undefined>((resolve, reject) => {
    get(url, { signal: AbortSignal.timeout(5000) }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
}

export const providerContext = (providerId = 'openai') => ({ params: Promise.resolve({ providerId }) });
export const connect = (request: Request) => connectRoute(request, providerContext());
export const cancel = (request: Request) => cancelRoute(request, providerContext());
export const submit = (request: Request) => submitRoute(request, providerContext());
export const disconnect = (request: Request) => disconnectRoute(request, providerContext());
export async function state() { return (await settings(request('/model-providers'))).json(); }
export async function login(options: { invalidNonce?: boolean; catalogStatus?: number; tokenStatus?: number; tokenError?: string; networkFailure?: boolean; scope?: string } = {}) {
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
    if (options.networkFailure) throw new TypeError('fetch failed');
    if (options.tokenStatus) return Response.json({ error: { code: options.tokenError } }, { status: options.tokenStatus });
    const identity = await new SignJWT({ nonce: options.invalidNonce ? 'wrong' : authorization.searchParams.get('nonce') })
      .setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).setIssuer('https://auth.openai.com')
      .setAudience('oaiapp_test').setSubject('test-account').setExpirationTime('1h').sign(signing.privateKey);
    return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', id_token: identity,
      expires_in: 3600, scope: options.scope ?? 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
  });
  return { id, callback };
}

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GET as settings, PATCH as select } from '@/app/api/speech/route';
import { POST as create } from '@/app/api/speech/connections/route';
import { PATCH as update, DELETE as remove } from '@/app/api/speech/connections/[id]/route';
import { PATCH as chatgptModel } from '@/app/api/speech/chatgpt/route';
import { POST as realtime } from '@/app/api/speech/realtime/route';
import { POST as transcribe } from '@/app/api/speech/transcriptions/route';
import { POST as testConnection } from '@/app/api/speech/test/route';

import { createApiTestApp, request, restartApp } from './app';

let app: Awaited<ReturnType<typeof createApiTestApp>>;
const input = { name: '本地转写', protocol: 'file', baseUrl: 'http://127.0.0.1:8000/v1/', model: 'whisper-1', key: 'sk-private' };
const context = (id: string) => ({ params: Promise.resolve({ id }) });
beforeEach(async () => { app = await createApiTestApp(); });
afterEach(async () => { await app.cleanup(); });
async function state() { return (await settings(request('/speech'))).json(); }
async function connection(extra: object = {}) {
  const response = await create(request('/connections', 'POST', { ...input, ...extra }));
  expect(response.status).toBe(200);
  return (await response.json()).activeId as string;
}
function audio(connectionId: string) {
  const form = new FormData();
  form.set('connectionId', connectionId);
  form.set('audio', new Blob(['audio'], { type: 'audio/webm' }), 'recording.webm');
  return new Request('http://localhost/transcriptions', { method: 'POST', body: form });
}

test('connections, selection and ChatGPT model persist; keys are retained, replaced or cleared without disclosure', async () => {
  expect(await state()).toMatchObject({ activeId: 'chatgpt', connections: [] });
  const id = await connection();
  expect((await state()).connections).toContainEqual(expect.objectContaining({ id, hasKey: true, baseUrl: 'http://127.0.0.1:8000/v1' }));
  await update(request('/connection', 'PATCH', { ...input, name: '改名', key: '' }), context(id));
  restartApp();
  expect((await state()).connections).toContainEqual(expect.objectContaining({ id, name: '改名', hasKey: true }));
  for (const key of ['sk-replaced', '']) {
    const result = await (await update(request('/connection', 'PATCH', { ...input, key, clearKey: !key }), context(id))).json();
    expect(result.connections[0].hasKey).toBe(Boolean(key));
    expect(JSON.stringify(result)).not.toContain('sk-');
  }
  await chatgptModel(request('/chatgpt', 'PATCH', { model: 'configured-transcriber' }));
  await select(request('/speech', 'PATCH', { activeId: id }));
  expect(await state()).toMatchObject({ activeId: id, chatgpt: { model: 'configured-transcriber' } });
  await remove(request('/connection', 'DELETE'), context(id));
  expect(await state()).toMatchObject({ activeId: 'chatgpt', connections: [] });
  expect((await select(request('/speech', 'PATCH', { activeId: id }))).status).toBe(404);
  expect((await remove(request('/connection', 'DELETE'), context(randomUUID()))).status).toBe(404);
});

test('invalid addresses and malformed local configuration are rejected without overwriting the file', async () => {
  for (const baseUrl of ['file:///etc/passwd', 'https://user:pass@example.com/v1', 'https://example.com/v1?token=1'])
    expect((await create(request('/connections', 'POST', { ...input, baseUrl }))).status).toBe(400);
  const config = path.join(app.config.dataDir, 'speech.json');
  await writeFile(config, '{not json');
  expect((await settings(request('/speech'))).status).toBe(500);
  expect((await create(request('/connections', 'POST', input))).status).toBe(500);
  expect(await readFile(config, 'utf8')).toBe('{not json');
});

test('file transcription uploads the selected model and audio using the stored credential', async () => {
  const id = await connection();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const upstream = new Request(url, init);
    expect(upstream.url).toBe('http://127.0.0.1:8000/v1/audio/transcriptions');
    expect(upstream.headers.get('authorization')).toBe('Bearer sk-private');
    const form = await upstream.formData();
    expect(form.get('model')).toBe('whisper-1');
    expect(await (form.get('file') as File).text()).toBe('audio');
    return Response.json({ text: '可编辑的文字' });
  });
  expect(await (await transcribe(audio(id))).json()).toEqual({ text: '可编辑的文字' });
  expect((await realtime(request('/realtime', 'POST', { connectionId: id, sdp: 'offer' }))).status).toBe(409);
  expect((await transcribe(audio('chatgpt'))).status).toBe(409);
});

test('custom realtime exchanges SDP; connection tests and protocol errors are exposed through the API', async () => {
  const id = await connection({ protocol: 'realtime', key: '' });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const upstream = new Request(url, init);
    expect(upstream.headers.has('authorization')).toBe(false);
    if (upstream.url.endsWith('/client_secrets')) return Response.json({ value: 'ephemeral-key' });
    const form = await upstream.formData();
    expect(form.get('sdp')).toBe('offer');
    expect(JSON.parse(form.get('session') as string)).toMatchObject({ type: 'transcription', audio: { input: { transcription: { model: 'whisper-1' } } } });
    return new Response('answer', { headers: { 'Content-Type': 'application/sdp' } });
  });
  expect(await (await realtime(request('/realtime', 'POST', { connectionId: id, sdp: 'offer' }))).json()).toEqual({ sdp: 'answer' });
  expect(await (await testConnection(request('/test', 'POST', { connectionId: id }))).json()).toMatchObject({ ok: true });
  expect((await transcribe(audio(id))).status).toBe(409);
});

test('upstream authentication, malformed responses and network failure return recoverable errors without secrets', async () => {
  const id = await connection();
  for (const upstream of [
    new Response('sk-private', { status: 401 }),
    new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    vi.stubGlobal('fetch', async () => upstream);
    const response = await transcribe(audio(id));
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('sk-private');
  }
  vi.stubGlobal('fetch', async () => { throw new TypeError('connection refused'); });
  const response = await transcribe(audio(id));
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: { code: 'speech_unreachable' } });
});

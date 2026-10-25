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

import { createTestApp, request, restartApp } from '../app';

let app: Awaited<ReturnType<typeof createTestApp>>;
const input = { name: '本地转写', protocol: 'file', baseUrl: 'http://127.0.0.1:8000/v1/', model: 'whisper-1', key: 'sk-private' };
const context = (id: string) => ({ params: Promise.resolve({ id }) });
beforeEach(async () => { app = await createTestApp(); });
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

test('the annotated speech configuration loads through the API without exposing its key', async () => {
  const sample = await readFile(path.resolve('src/features/settings/skills/workbench-guide/references/speech.example.jsonc'), 'utf8');
  const file = path.join(app.config.dataDir, 'speech.json');
  await writeFile(file, '\uFEFF' + sample);
  const response = await settings(request('/speech'));
  expect(response.status).toBe(200);
  const loaded = await response.json();
  expect(loaded).toMatchObject({ activeId: 'chatgpt', connections: [expect.objectContaining({
    protocol: 'file', baseUrl: 'https://api.example.com/v1', hasKey: true,
  })] });
  expect(JSON.stringify(loaded)).not.toContain('replace-with-your-key');
  await writeFile(file, '// Incomplete edit\n{"connections":');
  expect((await settings(request('/speech'))).status).toBe(500);
  expect(await readFile(file, 'utf8')).toBe('// Incomplete edit\n{"connections":');
});

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
  await select(request('/speech', 'PATCH', { activeId: null }));
  expect((await state()).activeId).toBeNull();
  await select(request('/speech', 'PATCH', { activeId: id }));
  await remove(request('/connection', 'DELETE'), context(id));
  expect(await state()).toMatchObject({ activeId: 'chatgpt', connections: [] });
  expect((await select(request('/speech', 'PATCH', { activeId: id }))).status).toBe(404);
  expect((await remove(request('/connection', 'DELETE'), context(randomUUID()))).status).toBe(404);
  expect((await update(request('/connection', 'PATCH', input), context(id))).status).toBe(404);
  expect((await testConnection(request('/test', 'POST', { connectionId: id }))).status).toBe(404);
});

test('editing or removing another speech connection preserves the selected connection', async () => {
  const other = await connection({ name: '备用转写' });
  const active = await connection({ name: '当前转写' });
  const selected = (await state()).connections.find((item: { id: string }) => item.id === active);
  const updated = await update(request('/connection', 'PATCH', { ...input, name: '备用新名称' }), context(other));
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ activeId: active, connections: expect.arrayContaining([
    selected, expect.objectContaining({ id: other, name: '备用新名称' }),
  ]) });
  expect((await remove(request('/connection', 'DELETE'), context(other))).status).toBe(200);
  restartApp();
  expect(await state()).toMatchObject({ activeId: active, connections: [selected] });
});

test('invalid addresses and malformed local configuration are rejected without overwriting the file', async () => {
  for (const baseUrl of ['file:///etc/passwd', 'https://user:pass@example.com/v1', 'https://example.com/v1?token=1'])
    expect((await create(request('/connections', 'POST', { ...input, baseUrl }))).status).toBe(400);
  const config = path.join(app.config.dataDir, 'speech.json');
  await writeFile(config, '{not json');
  expect((await settings(request('/speech'))).status).toBe(500);
  expect((await create(request('/connections', 'POST', input))).status).toBe(500);
  expect(await readFile(config, 'utf8')).toBe('{not json');
  await writeFile(config, '{}');
  expect((await settings(request('/speech'))).status).toBe(500);
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
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const form = init.body as FormData;
    const sample = Buffer.from(await (form.get('file') as File).arrayBuffer());
    expect(sample.subarray(0, 4).toString()).toBe('RIFF');
    return Response.json({ text: '' });
  });
  expect(await (await testConnection(request('/test', 'POST', { connectionId: id }))).json()).toMatchObject({ ok: true });
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

test('transcription distinguishes invalid responses, timeouts and cancelled requests', async () => {
  const id = await connection();
  vi.stubGlobal('fetch', async () => Response.json({ text: 42 }));
  expect(await (await transcribe(audio(id))).json()).toMatchObject({ error: { code: 'speech_response_invalid' } });
  vi.stubGlobal('fetch', async () => { throw new DOMException('timeout', 'TimeoutError'); });
  expect((await transcribe(audio(id))).status).toBe(504);
  const controller = new AbortController();
  controller.abort();
  const input = audio(id);
  const cancelled = new Request(input, { signal: controller.signal });
  vi.stubGlobal('fetch', async () => { throw new DOMException('cancelled', 'AbortError'); });
  expect((await transcribe(cancelled)).status).toBe(408);
});

test('recording requests reject missing or oversized audio before contacting a speech service', async () => {
  const id = await connection();
  const form = new FormData();
  form.set('connectionId', id);
  const missing = await transcribe(new Request('http://localhost/transcriptions', { method: 'POST', body: form }));
  expect(missing.status).toBe(400);
  expect((await transcribe(new Request('http://localhost/transcriptions', { method: 'POST', body: 'invalid' }))).status).toBe(400);
  const oversized = await transcribe(new Request('http://localhost/transcriptions', {
    method: 'POST', headers: { 'Content-Length': '40000001' }, body: 'audio',
  }));
  expect(oversized.status).toBe(413);
  expect((await realtime(request('/realtime', 'POST', { connectionId: 'chatgpt', sdp: 'offer' }))).status).toBe(409);
});

test.each([
  [404, 'speech_endpoint_missing'], [429, 'speech_limited'], [503, 'speech_unavailable'], [400, 'speech_request_failed'],
])('speech service status %i is reported as %s', async (status, code) => {
  const id = await connection();
  vi.stubGlobal('fetch', async () => new Response(null, { status }));
  const response = await transcribe(audio(id));
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: { code } });
});

test('connection testing accepts an SDP validation response but rejects invalid credentials', async () => {
  const id = await connection({ protocol: 'realtime' });
  let status = 400;
  vi.stubGlobal('fetch', async (url: string) => new Response(null, {
    status: url.endsWith('/client_secrets') ? 404 : status,
  }));
  expect(await (await testConnection(request('/test', 'POST', { connectionId: id }))).json()).toMatchObject({ ok: true });
  status = 401;
  const rejected = await testConnection(request('/test', 'POST', { connectionId: id }));
  expect(rejected.status).toBe(502);
  expect(await rejected.json()).toMatchObject({ error: { code: 'speech_auth_failed' } });
});

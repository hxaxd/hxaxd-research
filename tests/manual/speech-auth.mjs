import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ModelRuntime, readStoredCredential } from '@earendil-works/pi-coding-agent';

const piDir = path.resolve(process.env.APP_DATA_DIR || '.runtime/data', 'pi');
const authPath = path.join(piDir, 'auth.json');
if (readStoredCredential('openai', authPath)?.type !== 'oauth')
  throw new Error('应用当前没有 ChatGPT OAuth 授权');
const runtime = await ModelRuntime.create({ authPath, modelsPath: path.join(piDir, 'models.json') });
const provider = runtime.getProvider('openai');
const oauth = provider.auth.oauth;
runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth, oauth: {
  ...oauth, async refresh(credential, signal) {
    return { ...credential, ...(await oauth.refresh(credential, signal)) };
  },
} } });
const resolved = await runtime.getAuth('openai', { signal: AbortSignal.timeout(30000) });
const token = resolved?.auth.apiKey;
if (!token || token !== readStoredCredential('openai', authPath)?.access)
  throw new Error('解析到的凭据不是应用保存的 ChatGPT 访问令牌，停止测试');
const results = [];
function safe(value) {
  return String(value ?? '').replaceAll(token, '[REDACTED]')
    .replace(/\b(?:sk-|ek_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]+/g, '[REDACTED]');
}
async function probe(endpoint, options = {}) {
  const response = await fetch(`https://api.openai.com/v1/${endpoint}`, {
    ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` },
    redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  const result = { endpoint, status: response.status,
    ...(body.error ? { error: { code: body.error.code, type: body.error.type, message: safe(body.error.message) } } : {}),
    ...(response.ok && endpoint === 'models' ? {
      audioModels: (body.models ?? body.data ?? []).map(model => model.slug ?? model.id)
        .filter(id => /transcri|realtime|whisper|live/i.test(id)),
    } : {}),
    ...(response.ok && endpoint.includes('client_secrets') ? { temporaryCredentialIssued: !!body.value } : {}),
    ...(response.ok && endpoint === 'audio/transcriptions' ? { text: body.text } : {}),
  };
  results.push(result);
  console.log(JSON.stringify(result));
  return body;
}
await probe('models');
if (!process.argv.includes('--realtime-only')) {
const wav = Buffer.alloc(44 + 24000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const form = new FormData();
form.set('model', 'gpt-transcribe');
form.set('file', new Blob([wav], { type: 'audio/wav' }), 'silence.wav');
await probe('audio/transcriptions', { method: 'POST', body: form });
}
const secret = await probe('realtime/client_secrets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 10 },
    session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 },
      transcription: { model: 'gpt-live-transcribe' }, turn_detection: null } } },
  }),
});
if (secret.value) {
  let audio;
  if (process.argv.includes('--audio')) {
    const wav = await readFile('.runtime/dev/speech-auth-sample.wav');
    for (let offset = 12; offset + 8 <= wav.length;) {
      const length = wav.readUInt32LE(offset + 4);
      if (wav.toString('ascii', offset, offset + 4) === 'data') {
        audio = wav.subarray(offset + 8, offset + 8 + length);
        break;
      }
      offset += 8 + length + (length % 2);
    }
    if (!audio) throw new Error('测试 WAV 没有音频数据');
  }
  const WebSocket = createRequire(import.meta.url)('next/dist/compiled/ws');
  const outcome = await new Promise(resolve => {
    const ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: { Authorization: `Bearer ${secret.value}` }, handshakeTimeout: 20000,
    });
    const events = [];
    let configuredModel;
    const timer = setTimeout(() => finish({ connected: ws.readyState === WebSocket.OPEN, timeout: true }), 25000);
    function finish(result) {
      clearTimeout(timer);
      ws.close();
      resolve({ endpoint: 'realtime WebSocket', events, ...result });
    }
    ws.on('open', () => ws.send(JSON.stringify({ type: 'session.update', session: {
      type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 },
        transcription: { model: 'gpt-live-transcribe' }, turn_detection: null } },
    } })));
    ws.on('message', data => {
      const event = JSON.parse(data.toString());
      events.push(event.type);
      if (event.type === 'error') finish({ connected: true, error: safe(event.error?.message), code: event.error?.code });
      if (event.type === 'session.updated' || event.type === 'transcription_session.updated') {
        configuredModel = event.session?.audio?.input?.transcription?.model ?? event.session?.input_audio_transcription?.model;
        if (!audio) return finish({ connected: true, configuredModel });
        for (let offset = 0; offset < audio.length; offset += 4800)
          ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audio.subarray(offset, offset + 4800).toString('base64') }));
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed')
        finish({ connected: true, configuredModel, transcript: event.transcript });
      if (event.type === 'conversation.item.input_audio_transcription.failed')
        finish({ connected: true, configuredModel, error: safe(event.error?.message), code: event.error?.code });
    });
    ws.on('unexpected-response', (_, response) => {
      response.resume();
      finish({ connected: false, status: response.statusCode });
    });
    ws.on('error', error => finish({ connected: false, error: safe(error.message) }));
  });
  results.push(outcome);
  console.log(JSON.stringify(outcome));
}
await mkdir('.runtime/dev', { recursive: true });
await writeFile('.runtime/dev/speech-auth-probe-result.json', JSON.stringify({ at: new Date().toISOString(), usesChatGPTAuthorization: true, results }, null, 2));

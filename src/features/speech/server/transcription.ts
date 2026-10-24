import 'server-only';

import { z } from 'zod';

import { ApiError, isApiError } from '@/shared/http/api-error';

import type { SpeechTarget } from './connections';

const secretSchema = z.object({ value: z.string().min(1) });
const transcriptSchema = z.object({ text: z.string() });

export function transcriptionSession(model: string) {
  return {
    type: 'transcription' as const,
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { model },
        turn_detection: null,
      },
    },
  };
}

function failure(status: number) {
  if (status === 401 || status === 403)
    return new ApiError(502, 'speech_auth_failed', `语音服务拒绝了凭据（${status}），请检查密钥或重新连接授权`);
  if (status === 404)
    return new ApiError(502, 'speech_endpoint_missing', '语音服务没有对应的接口（404），请检查地址与连接协议');
  if (status === 429)
    return new ApiError(502, 'speech_limited', '语音服务的额度或频率受限（429），请稍后重试');
  if (status >= 500)
    return new ApiError(502, 'speech_unavailable', `语音服务暂时不可用（${status}）`);
  return new ApiError(502, 'speech_request_failed', `语音服务请求失败（${status}）`);
}

function transportFailure(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw new ApiError(408, 'request_cancelled', '请求已取消');
  if (error instanceof Error && error.name === 'TimeoutError')
    throw new ApiError(504, 'speech_timeout', '语音服务响应超时，请检查地址与网络');
  throw new ApiError(502, 'speech_unreachable', '无法连接语音服务，请检查地址、端口与网络');
}

async function send(url: string, init: RequestInit, timeout: number, outer: AbortSignal) {
  const signal = AbortSignal.any([outer, AbortSignal.timeout(timeout)]);
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    transportFailure(error, outer);
  }
}

function authorization(key: string | undefined): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function readJson<T>(response: Response, schema: z.ZodType<T>) {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(502, 'speech_response_invalid', '语音服务返回了无法识别的数据');
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new ApiError(502, 'speech_response_invalid', '语音服务返回的数据格式无效');
  return parsed.data;
}

async function mintSecret(
  target: Extract<SpeechTarget, { kind: 'custom' }>,
  signal: AbortSignal,
  key?: string,
) {
  const response = await send(
    `${target.baseUrl}/realtime/client_secrets`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authorization(key) },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 600 },
        session: transcriptionSession(target.model),
      }),
    },
    20_000,
    signal,
  );
  if (!response.ok) throw failure(response.status);
  return (await readJson(response, secretSchema)).value;
}

export async function realtimeAnswer(target: SpeechTarget, sdp: string, signal: AbortSignal) {
  if (target.kind === 'chatgpt') {
    const token = target.token;
    const secret = await send(
      'https://api.openai.com/v1/realtime/client_secrets',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: 120 },
          session: transcriptionSession(target.model),
        }),
      },
      20_000,
      signal,
    );
    if (!secret.ok) throw failure(secret.status);
    const key = (await readJson(secret, secretSchema)).value;
    const answer = await send(
      'https://api.openai.com/v1/realtime/calls',
      { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/sdp' }, body: sdp },
      30_000,
      signal,
    );
    if (!answer.ok) throw failure(answer.status);
    return answer.text();
  }
  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify(transcriptionSession(target.model)));
  const answer = await send(
    `${target.baseUrl}/realtime/calls`,
    { method: 'POST', headers: authorization(target.key), body: form },
    30_000,
    signal,
  );
  if (!answer.ok) throw failure(answer.status);
  return answer.text();
}

export async function fileTranscript(
  target: SpeechTarget,
  audio: Blob,
  filename: string,
  signal: AbortSignal,
) {
  if (target.kind === 'chatgpt')
    throw new ApiError(409, 'speech_protocol_unsupported', 'ChatGPT 授权只用于实时转写，请配置文件转写服务');
  const form = new FormData();
  form.set('model', target.model);
  form.set('file', audio, filename);
  const response = await send(
    `${target.baseUrl}/audio/transcriptions`,
    { method: 'POST', headers: authorization(target.key), body: form },
    120_000,
    signal,
  );
  if (!response.ok) throw failure(response.status);
  return (await readJson(response, transcriptSchema)).text;
}

function silentWav(seconds = 1) {
  const rate = 16000;
  const samples = Math.round(rate * seconds);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function testTarget(target: SpeechTarget, signal: AbortSignal) {
  if (target.kind === 'chatgpt') {
    const token = target.token;
    const response = await send(
      'https://api.openai.com/v1/realtime/client_secrets',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: 60 },
          session: transcriptionSession(target.model),
        }),
      },
      20_000,
      signal,
    );
    if (!response.ok) throw failure(response.status);
    return '实时转写接口可用';
  }
  if (target.protocol === 'realtime') {
    try {
      await mintSecret(target, signal, target.key);
      return '实时转写接口可用';
    } catch (error) {
      if (!isApiError(error) || error.code !== 'speech_endpoint_missing') throw error;
      const reachable = await send(`${target.baseUrl}/realtime/calls`, { method: 'POST', body: '' }, 10_000, signal);
      if (reachable.status >= 500) throw failure(reachable.status);
      return '地址可访问；实时连接将在开始录音时建立';
    }
  }
  await fileTranscript(target, silentWav(), 'silence.wav', signal);
  return '文件转写接口可用';
}

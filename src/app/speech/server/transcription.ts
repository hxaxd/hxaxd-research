import 'server-only';
import { text as t } from '@/app/i18n/server.mjs';

import { z } from 'zod';
import type { AppConfig } from '@/app/config.mjs';

import { ApiError } from '@/shared/http/api-error';

import type { SpeechTarget } from '@/app/models/server/speech-connections';
import type { SpeechRealtimeSession } from '../schema';

const secretSchema = z.object({ value: z.string().min(1) });
const transcriptSchema = z.object({ text: z.string() });

function transcriptionSession(model: string) {
  return {
    type: 'transcription' as const,
    audio: {
      input: {
        format: { type: 'audio/pcm' as const, rate: 24000 as const },
        transcription: { model },
        turn_detection: null,
      },
    },
  };
}

function failure(status: number) {
  if (status === 401 || status === 403)
    return new ApiError(502, 'speech_auth_failed', t('errors.speechAuth', {value0: status}));
  if (status === 404)
    return new ApiError(502, 'speech_endpoint_missing', t('errors.speechEndpoint'));
  if (status === 429)
    return new ApiError(502, 'speech_limited', t('errors.speechLimit'));
  if (status >= 500)
    return new ApiError(502, 'speech_unavailable', t('errors.speechUnavailable', {value0: status}));
  return new ApiError(502, 'speech_request_failed', t('errors.speechStatus', {value0: status}));
}

function transportFailure(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw new ApiError(408, 'request_cancelled', t('common.cancelled'));
  if (error instanceof Error && error.name === 'TimeoutError')
    throw new ApiError(504, 'speech_timeout', t('errors.speechTimeout'));
  throw new ApiError(502, 'speech_unreachable', t('errors.speechNetwork'));
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
    throw new ApiError(502, 'speech_response_invalid', t('errors.speechResponse'));
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new ApiError(502, 'speech_response_invalid', t('errors.speechResponseFormat'));
  return parsed.data;
}

async function mintSecret(
  target: SpeechTarget,
  signal: AbortSignal,
  timeouts: AppConfig['timeouts'],
) {
  const baseUrl = target.kind === 'chatgpt' ? 'https://api.openai.com/v1' : target.baseUrl;
  const key = target.kind === 'chatgpt' ? target.token : target.key;
  const response = await send(
    `${baseUrl}/realtime/client_secrets`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authorization(key) },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 120 },
        session: transcriptionSession(target.model),
      }),
    },
    timeouts.speechSecretMs,
    signal,
  );
  if (!response.ok) throw failure(response.status);
  return (await readJson(response, secretSchema)).value;
}

export async function realtimeSession(target: SpeechTarget, signal: AbortSignal, timeouts: AppConfig['timeouts']): Promise<SpeechRealtimeSession> {
  const key = await mintSecret(target, signal, timeouts);
  const baseUrl = target.kind === 'chatgpt' ? 'https://api.openai.com/v1' : target.baseUrl;
  const url = new URL(`${baseUrl}/realtime`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('intent', 'transcription');
  return { url: url.toString(), key, session: transcriptionSession(target.model), timeoutMs: timeouts.speechRealtimeMs };
}

export async function fileTranscript(
  target: SpeechTarget,
  audio: Blob,
  filename: string,
  signal: AbortSignal,
  timeouts: AppConfig['timeouts'],
) {
  if (target.kind === 'chatgpt')
    throw new ApiError(409, 'speech_protocol_unsupported', t('errors.chatgptSpeechProtocol'));
  const form = new FormData();
  form.set('model', target.model);
  form.set('file', audio, filename);
  const response = await send(
    `${target.baseUrl}/audio/transcriptions`,
    { method: 'POST', headers: authorization(target.key), body: form },
    timeouts.speechTranscriptionMs,
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

export async function testTarget(target: SpeechTarget, signal: AbortSignal, timeouts: AppConfig['timeouts']) {
  if (target.kind === 'chatgpt' || target.protocol === 'realtime') {
    await mintSecret(target, signal, { ...timeouts, speechSecretMs: timeouts.speechProbeMs });
    return t('speech.realtimeAvailable');
  }
  await fileTranscript(target, silentWav(), 'silence.wav', signal, timeouts);
  return t('speech.fileAvailable');
}

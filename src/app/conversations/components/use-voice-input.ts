'use client';

import { useTranslations } from 'use-intl';
import { useEffect, useRef, useState, type RefObject } from 'react';

import type { ActiveSpeech } from '@/app/models/active-speech';
import type { SpeechRealtimeSession } from '@/app/speech/schema';
import { requestJson } from '@/shared/http/request-json';

import { adjustRange, insertVoiceText, removeRanges, type TextRange } from '../voice-draft';
import { applyVoiceEvent, pendingVoiceText, type VoiceItem, type VoiceServerEvent } from '../voice-events';
import { recordPcm, type PcmRecording } from './voice-recorder';

export type VoiceState = 'idle' | 'permission' | 'recording' | 'finishing';

type Session = {
  active: ActiveSpeech;
  canceled: boolean;
  finishing: boolean;
  connected: boolean;
  controller: AbortController;
  ready?: Promise<void>;
  socket?: WebSocket;
  stream?: MediaStream;
  pcm?: PcmRecording;
  recorder?: MediaRecorder;
  chunks: Blob[];
  audio: ArrayBuffer[];
  sentSamples: number;
  clock?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
};

function microphoneError(error: unknown, t: ReturnType<typeof useTranslations>) {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return t('errors.microphonePermission');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('errors.microphoneMissing');
  if (name === 'NotReadableError' || name === 'AbortError') return t('errors.microphoneBusy');
  return t('errors.microphoneOpen');
}

async function openMicrophone(t: ReturnType<typeof useTranslations>) {
  if (!window.isSecureContext) throw new Error(t('errors.secureContext'));
  if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('errors.microphoneUnsupported'));
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw new Error(microphoneError(error, t));
  }
}

function dispose(session: Session) {
  session.canceled = true;
  clearInterval(session.clock);
  clearTimeout(session.timeout);
  session.controller.abort();
  session.pcm?.cancel();
  if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
  session.stream?.getTracks().forEach(track => track.stop());
  session.socket?.close();
  session.chunks = [];
  session.audio = [];
}

export function useVoiceInput({ text, onTextChange, textarea }: {
  text: string;
  onTextChange: (next: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  const t = useTranslations();
  const [state, setState] = useState<VoiceState>('idle');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const textRef = useRef(text);
  const anchorRef = useRef<TextRange>({ start: text.length, end: text.length });
  const insertedRef = useRef<TextRange[]>([]);
  const sessionRef = useRef<Session | null>(null);
  const itemsRef = useRef<Map<string, VoiceItem>>(new Map());

  useEffect(() => {
    if (textRef.current === text) return;
    const previous = textRef.current;
    textRef.current = text;
    anchorRef.current = adjustRange(anchorRef.current, previous, text);
    insertedRef.current = insertedRef.current.map(range => adjustRange(range, previous, text));
  }, [text]);

  useEffect(() => () => {
    if (sessionRef.current) dispose(sessionRef.current);
    sessionRef.current = null;
  }, []);

  function commit(chunk: string) {
    const content = chunk.trim();
    if (!content) return;
    const node = textarea.current;
    const focused = Boolean(node && document.activeElement === node);
    const caret = focused ? node!.selectionStart : null;
    const result = insertVoiceText(textRef.current, anchorRef.current, content);
    const insertedLength = result.inserted.end - result.inserted.start;
    anchorRef.current = result.range;
    insertedRef.current = [...insertedRef.current, result.inserted];
    textRef.current = result.text;
    onTextChange(result.text);
    if (focused && caret !== null) {
      const position = caret <= result.inserted.start ? caret
        : caret >= result.inserted.end ? caret + insertedLength : result.inserted.end;
      requestAnimationFrame(() => {
        const current = textarea.current;
        if (!current || document.activeElement !== current) return;
        const bounded = Math.max(0, Math.min(position, current.value.length));
        current.setSelectionRange(bounded, bounded);
      });
    }
  }

  function finish(session: Session) {
    dispose(session);
    if (sessionRef.current !== session) return;
    sessionRef.current = null;
    insertedRef.current = [];
    itemsRef.current.clear();
    setState('idle');
    setConnecting(false);
    setPending('');
    setElapsed(0);
  }

  function fail(session: Session, message: string) {
    if (sessionRef.current !== session || session.canceled) return;
    finish(session);
    setError(message);
  }

  function handleEvent(session: Session, event: VoiceServerEvent) {
    if (session.canceled) return;
    const result = applyVoiceEvent(itemsRef.current, event, t);
    if (result.error) {
      fail(session, result.error);
      return;
    }
    if (result.completed !== null) {
      commit(result.completed);
      setPending(pendingVoiceText(itemsRef.current));
      if (session.finishing) finish(session);
    } else if (event.type === 'conversation.item.input_audio_transcription.delta') {
      setPending(pendingVoiceText(itemsRef.current));
    }
  }

  function flushAudio(session: Session) {
    if (!session.connected || session.canceled || session.socket!.readyState !== WebSocket.OPEN) return;
    for (const audio of session.audio) {
      session.socket!.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: btoa(String.fromCharCode(...new Uint8Array(audio))),
      }));
      session.sentSamples += audio.byteLength / 2;
    }
    session.audio = [];
  }

  async function connectRealtime(session: Session) {
    const { signal } = session.controller;
    const result = await requestJson<SpeechRealtimeSession>('/api/speech/realtime', {
      method: 'POST', signal, body: JSON.stringify({ connectionId: session.active.id }),
    });
    if (session.canceled) return;
    const socket = new WebSocket(result.url, ['realtime', `openai-insecure-api-key.${result.key}`]);
    session.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settled(new Error(t('errors.speechConnectTimeout'))), result.timeoutMs);
      function settled(error?: Error) {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve();
      }
      function aborted() { settled(new DOMException(t('common.cancelled'), 'AbortError')); }
      signal.addEventListener('abort', aborted, { once: true });
      socket.onopen = () => socket.send(JSON.stringify({ type: 'session.update', session: result.session }));
      socket.onerror = () => {
        const message = t('errors.speechNetwork');
        settled(new Error(message));
        if (session.connected) fail(session, message);
      };
      socket.onclose = () => {
        if (session.canceled) return;
        const message = t('errors.speechClosed');
        settled(new Error(message));
        if (session.connected) fail(session, message);
      };
      socket.onmessage = event => {
        if (session.canceled) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'session.updated') {
            session.connected = true;
            setConnecting(false);
            flushAudio(session);
            settled();
          } else handleEvent(session, message);
        } catch {
          fail(session, t('errors.speechEvent'));
        }
      };
    });
  }

  async function startRecording(session: Session) {
    const stream = await openMicrophone(t);
    if (session.canceled) { stream.getTracks().forEach(track => track.stop()); return; }
    session.stream = stream;
    if (session.active.protocol === 'realtime') {
      if (typeof AudioWorkletNode === 'undefined') throw new Error(t('errors.recordingUnsupported'));
      const recorder = await recordPcm(stream, audio => {
        if (session.canceled) return;
        session.audio.push(audio);
        flushAudio(session);
      });
      if (session.canceled) { recorder.cancel(); return; }
      session.pcm = recorder;
    } else {
      if (typeof MediaRecorder === 'undefined') throw new Error(t('errors.recordingUnsupported'));
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(value => MediaRecorder.isTypeSupported(value));
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      session.recorder = recorder;
      recorder.ondataavailable = event => { if (!session.canceled && event.data.size) session.chunks.push(event.data); };
      recorder.start(500);
    }
    setState('recording');
    const started = Date.now();
    session.clock = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
  }

  async function start(active: ActiveSpeech) {
    if (sessionRef.current) return;
    setError('');
    setPending('');
    setElapsed(0);
    const node = textarea.current!;
    anchorRef.current = { start: node.selectionStart, end: node.selectionEnd };
    insertedRef.current = [];
    const session: Session = {
      active, canceled: false, finishing: false, connected: false,
      controller: new AbortController(), chunks: [], audio: [], sentSamples: 0,
    };
    sessionRef.current = session;
    setState('permission');
    setConnecting(active.protocol === 'realtime');
    try {
      session.ready = Promise.all([
        startRecording(session),
        active.protocol === 'realtime' ? connectRealtime(session) : Promise.resolve(),
      ]).then(() => {});
      await session.ready;
    } catch (error) {
      fail(session, (error as Error).message);
    }
  }

  async function stop() {
    const session = sessionRef.current;
    if (!session || session.canceled || session.finishing) return;
    session.finishing = true;
    setState('finishing');
    clearInterval(session.clock);
    try {
      if (session.active.protocol === 'realtime') {
        await session.pcm!.stop();
        session.stream!.getTracks().forEach(track => track.stop());
        await session.ready;
        if (session.canceled) return;
        flushAudio(session);
        if (!session.sentSamples) throw new Error(t('errors.recordingEmpty'));
        session.socket!.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        session.timeout = setTimeout(() => fail(session, t('errors.transcriptionTimeout')), 20000);
      } else {
        const recorder = session.recorder!;
        const stopped = new Promise<void>(resolve => recorder.addEventListener('stop', () => resolve(), { once: true }));
        recorder.stop();
        await stopped;
        session.stream!.getTracks().forEach(track => track.stop());
        if (session.canceled) return;
        const blob = new Blob(session.chunks, { type: recorder.mimeType || 'audio/webm' });
        session.chunks = [];
        if (!blob.size) throw new Error(t('errors.recordingEmpty'));
        const form = new FormData();
        form.set('connectionId', session.active.id);
        form.set('audio', blob, blob.type.includes('mp4') ? 'recording.mp4' : 'recording.webm');
        const result = await requestJson<{ text: string }>('/api/speech/transcriptions', {
          method: 'POST', body: form, signal: session.controller.signal,
        });
        if (session.canceled) return;
        commit(result.text);
        finish(session);
      }
    } catch (error) {
      fail(session, (error as Error).message);
    }
  }

  function cancel() {
    const session = sessionRef.current;
    if (!session) return;
    const next = removeRanges(textRef.current, insertedRef.current);
    finish(session);
    if (next !== textRef.current) { textRef.current = next; onTextChange(next); }
    setError('');
  }

  return { state, connecting, error, pending, elapsed, start, stop, cancel };
}

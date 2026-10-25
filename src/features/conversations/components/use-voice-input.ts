'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { ActiveSpeech } from '@/features/models/active-speech';
import { requestJson } from '@/shared/http/request-json';

import {
  adjustRange,
  insertVoiceText,
  removeRanges,
  type TextRange,
} from '../voice-draft';
import {
  applyVoiceEvent,
  pendingVoiceText,
  type VoiceItem,
  type VoiceServerEvent,
} from '../voice-events';

export type VoiceState =
  | 'idle'
  | 'permission'
  | 'connecting'
  | 'recording'
  | 'finishing';

type Session = {
  canceled: boolean;
  finishing: boolean;
  timeout?: ReturnType<typeof setTimeout>;
};

function microphoneError(error: unknown) {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return '浏览器未授予麦克风权限，请在站点设置中允许后重试';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return '没有找到可用的麦克风';
  if (name === 'NotReadableError' || name === 'AbortError')
    return '麦克风正被其他应用占用，请关闭后重试';
  return '无法打开麦克风，请检查浏览器权限与设备';
}

async function openMicrophone() {
  if (!window.isSecureContext)
    throw new Error(
      '当前页面不是安全上下文；请通过 127.0.0.1 或 HTTPS 打开后使用语音输入',
    );
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('当前浏览器不支持麦克风访问，请更换浏览器或使用 HTTPS');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    throw new Error(microphoneError(error));
  }
}

function waitForChannel(dc: RTCDataChannel, signal: AbortSignal) {
  if (dc.readyState === 'open') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('连接语音服务超时')), 15000);
    function cleanup() {
      clearTimeout(timer);
      dc.removeEventListener('open', opened);
      dc.removeEventListener('close', closed);
      signal.removeEventListener('abort', aborted);
    }
    function finish(error?: Error) {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    function opened() {
      finish();
    }
    function closed() {
      finish(new Error('语音连接已关闭'));
    }
    function aborted() {
      finish(new DOMException('已取消', 'AbortError'));
    }
    dc.addEventListener('open', opened);
    dc.addEventListener('close', closed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export function useVoiceInput({
  text,
  onTextChange,
  textarea,
}: {
  text: string;
  onTextChange: (next: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const textRef = useRef(text);
  const anchorRef = useRef<TextRange>({ start: text.length, end: text.length });
  const insertedRef = useRef<TextRange[]>([]);
  const sessionRef = useRef<Session | null>(null);
  const protocolRef = useRef<'realtime' | 'file'>('realtime');
  const connectionRef = useRef<string>('');
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const itemsRef = useRef<Map<string, VoiceItem>>(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    if (textRef.current === text) return;
    const previous = textRef.current;
    textRef.current = text;
    anchorRef.current = adjustRange(anchorRef.current, previous, text);
    insertedRef.current = insertedRef.current.map((range) =>
      adjustRange(range, previous, text),
    );
  }, [text]);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== 'inactive')
      recorderRef.current.stop();
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    itemsRef.current.clear();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      if (session) session.canceled = true;
      cleanup();
      sessionRef.current = null;
    };
  }, [cleanup]);

  function updatePending() {
    setPending(pendingVoiceText(itemsRef.current));
  }

  function commit(chunk: string) {
    const content = chunk.trim();
    if (!content) return;
    const node = textarea.current;
    const focused = Boolean(node && document.activeElement === node);
    const caret = focused ? (node!.selectionStart ?? null) : null;
    const range = anchorRef.current;
    const result = insertVoiceText(textRef.current, range, content);
    const insertedLength = result.inserted.end - result.inserted.start;
    anchorRef.current = result.range;
    insertedRef.current = [...insertedRef.current, result.inserted];
    textRef.current = result.text;
    onTextChange(result.text);
    if (focused && caret !== null && node) {
      const position =
        caret <= result.inserted.start
          ? caret
          : caret >= result.inserted.end
            ? caret + insertedLength
            : result.inserted.end;
      requestAnimationFrame(() => {
        const current = textarea.current;
        if (!current || document.activeElement !== current) return;
        const bounded = Math.max(0, Math.min(position, current.value.length));
        current.setSelectionRange(bounded, bounded);
      });
    }
  }

  function finish() {
    const session = sessionRef.current;
    if (session?.timeout) clearTimeout(session.timeout);
    cleanup();
    sessionRef.current = null;
    insertedRef.current = [];
    if (!mountedRef.current) return;
    setState('idle');
    setPending('');
    setElapsed(0);
  }

  function fail(message: string) {
    const session = sessionRef.current;
    if (session) session.canceled = true;
    finish();
    if (mountedRef.current) setError(message);
  }

  function handleEvent(event: VoiceServerEvent) {
    const session = sessionRef.current;
    if (!session || session.canceled) return;
    const result = applyVoiceEvent(itemsRef.current, event);
    if (result.error) {
      fail(result.error);
      return;
    }
    if (result.completed !== null) {
      commit(result.completed);
      updatePending();
      if (session.finishing) finish();
      return;
    }
    if (
      event.type === 'conversation.item.input_audio_transcription.delta'
    )
      updatePending();
  }

  function startClock() {
    const started = Date.now();
    timerRef.current = setInterval(() => {
      if (mountedRef.current)
        setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 250);
  }

  async function connectRealtime(active: ActiveSpeech, session: Session) {
    if (typeof RTCPeerConnection === 'undefined')
      throw new Error('当前浏览器不支持实时音频连接，请更换浏览器');
    const stream = streamRef.current!;
    const controller = new AbortController();
    abortRef.current = controller;
    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    pc.onconnectionstatechange = () => {
      if (sessionRef.current !== session || session.canceled) return;
      if (pc.connectionState === 'failed')
        fail('语音连接已中断，已确认的文字保留');
    };
    const channel = pc.createDataChannel('oai-events');
    channelRef.current = channel;
    channel.onmessage = (event) => {
      if (sessionRef.current !== session) return;
      try {
        handleEvent(JSON.parse(event.data));
      } catch {
        fail('无法解析语音服务返回的识别结果');
      }
    };
    pc.addTrack(stream.getAudioTracks()[0], stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const result = await requestJson<{ sdp: string }>('/api/speech/realtime', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ connectionId: active.id, sdp: offer.sdp }),
    });
    if (session.canceled) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: result.sdp });
    await waitForChannel(channel, controller.signal);
  }

  async function startFile() {
    if (typeof MediaRecorder === 'undefined')
      throw new Error('当前浏览器不支持录音，请更换浏览器');
    const stream = streamRef.current!;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '';
    const recorder = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunksRef.current.push(event.data);
    };
    recorder.start(500);
  }

  const start = useCallback(
    async (active: ActiveSpeech) => {
      if (state !== 'idle' || sessionRef.current) return;
      setError('');
      setPending('');
      setElapsed(0);
      const node = textarea.current!;
      anchorRef.current = { start: node.selectionStart, end: node.selectionEnd };
      insertedRef.current = [];
      protocolRef.current = active.protocol;
      connectionRef.current = active.id;
      const session: Session = {
        canceled: false,
        finishing: false,
      };
      sessionRef.current = session;
      try {
        setState('permission');
        const stream = await openMicrophone();
        if (session.canceled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        setState('connecting');
        if (active.protocol === 'realtime') await connectRealtime(active, session);
        else await startFile();
        if (session.canceled) return;
        setState('recording');
        startClock();
      } catch (error) {
        if (session.canceled) return;
        fail((error as Error).message);
      }
    },
    // The draft helpers and lifecycle refs are stable; the composer passes fresh text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, text],
  );

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || session.canceled || session.finishing) return;
    if (state === 'permission' || state === 'connecting') {
      session.canceled = true;
      cleanup();
      sessionRef.current = null;
      setState('idle');
      setPending('');
      return;
    }
    if (state !== 'recording') return;
    session.finishing = true;
    setState('finishing');
    if (protocolRef.current === 'realtime') {
      try {
        channelRef.current?.send(
          JSON.stringify({ type: 'input_audio_buffer.commit' }),
        );
        streamRef.current?.getTracks().forEach((track) => track.stop());
        session.timeout = setTimeout(() => {
          if (sessionRef.current !== session) return;
          setError('等待识别结果超时，已确认的文字保留');
          finish();
        }, 20000);
      } catch {
        fail('语音连接已中断，已确认的文字保留');
      }
      return;
    }
    try {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === 'inactive')
        throw new Error('录音已经结束');
      const stopped = new Promise<void>((resolve) =>
        recorder.addEventListener('stop', () => resolve(), { once: true }),
      );
      recorder.stop();
      await stopped;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (session.canceled) return;
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || 'audio/webm',
      });
      chunksRef.current = [];
      if (!blob.size) throw new Error('没有录到音频，请重试');
      const filename = blob.type.includes('mp4')
        ? 'recording.mp4'
        : blob.type.includes('ogg')
          ? 'recording.ogg'
          : 'recording.webm';
      const form = new FormData();
      form.set('connectionId', connectionRef.current);
      form.set('audio', blob, filename);
      const controller = new AbortController();
      abortRef.current = controller;
      const result = await requestJson<{ text: string }>(
        '/api/speech/transcriptions',
        { method: 'POST', body: form, signal: controller.signal },
      );
      if (session.canceled) return;
      commit(result.text);
      finish();
    } catch (error) {
      if (session.canceled) return;
      fail((error as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    if (!session) {
      setState('idle');
      return;
    }
    session.canceled = true;
    if (session.timeout) clearTimeout(session.timeout);
    const ranges = insertedRef.current;
    cleanup();
    sessionRef.current = null;
    insertedRef.current = [];
    const next = removeRanges(textRef.current, ranges);
    if (next !== textRef.current) {
      textRef.current = next;
      onTextChange(next);
    }
    setError('');
    setPending('');
    setElapsed(0);
    setState('idle');
  }, [cleanup, onTextChange]);

  return {
    state,
    error,
    pending,
    elapsed,
    start,
    stop,
    cancel,
    busy: state !== 'idle',
  };
}

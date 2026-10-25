'use client';

import {
  ArrowUp,
  BookOpen,
  LoaderCircle,
  Mic,
  Square,
  X,
} from 'lucide-react';
import { useRef, useState, type Dispatch, type SetStateAction } from 'react';

import type { ImageClip, ReadingContext, TextQuote } from '@/app/files/schema';
import {
  activeSpeech,
  speechUnavailable,
} from '@/app/models/active-speech';
import { useSpeechSettings } from '@/app/models/use-speech-settings';
import { openSettings } from '@/app/settings/components/open-settings';
import { requestJson } from '@/shared/http/request-json';

import type { ThinkingLevel } from '@/app/models/schema';

import type { ConversationRun } from '../schema';
import { ImageAttachment } from './ImageAttachment';
import { useVoiceInput } from './use-voice-input';

function clock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function ConversationComposer({
  url,
  model,
  thinkingLevel,
  run,
  reading,
  connected,
  clips,
  onClipsChange,
  quotes,
  onQuotesChange,
  supportsImages,
}: {
  url: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  run: ConversationRun | null;
  reading: ReadingContext | null;
  connected: boolean;
  clips: ImageClip[];
  onClipsChange: Dispatch<SetStateAction<ImageClip[]>>;
  quotes: TextQuote[];
  onQuotesChange: Dispatch<SetStateAction<TextQuote[]>>;
  supportsImages: boolean;
}) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [voiceNotice, setVoiceNotice] = useState('');
  const submission = useRef<{ id: string; content: string } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { settings, error: speechError } = useSpeechSettings();
  const active = activeSpeech(settings);
  const voice = useVoiceInput({ text, onTextChange: setText, textarea });
  const running = run?.status === 'accepted' || run?.status === 'running';
  const canSend =
    (text.trim() || clips.length || quotes.length) &&
    model &&
    connected &&
    voice.state === 'idle' &&
    (!clips.length || supportsImages);

  function openModelSettings() {
    openSettings('models');
  }

  const voiceLabel =
    voice.state === 'recording'
      ? `正在录音 ${clock(voice.elapsed)}，点击结束`
      : voice.state === 'permission'
        ? '请求麦克风权限，点击取消'
        : voice.state === 'connecting'
          ? '正在连接语音服务，点击取消'
          : voice.state === 'finishing'
            ? '正在整理文字，点击取消'
            : active
              ? `开始语音输入 · ${active.name}`
              : '开始语音输入（尚未配置）';

  function toggleVoice() {
    if (voice.state === 'recording') {
      void voice.stop();
      return;
    }
    if (
      voice.state === 'permission' ||
      voice.state === 'connecting' ||
      voice.state === 'finishing'
    ) {
      voice.cancel();
      return;
    }
    if (!active) {
      setVoiceNotice(
        speechError
          ? `无法读取语音设置：${speechError}`
          : settings
            ? `无法开始语音输入：${speechUnavailable(settings)}`
            : '正在读取语音设置，请稍后重试',
      );
      openModelSettings();
      return;
    }
    setVoiceNotice('');
    void voice.start(active);
  }

  async function send() {
    if (running || submitting || !canSend) return;
    const sentClips = clips;
    const sentQuotes = quotes;
    const content = JSON.stringify({ text: text.trim() || (quotes.length ? '请解释引用的选段。' : '请解释所附的截图。'), model, thinkingLevel, reading, clips, quotes });
    if (!submission.current || submission.current.content !== content)
      submission.current = { id: crypto.randomUUID(), content };
    setSubmitting(true);
    setError('');
    try {
      await requestJson(`${url}/messages`, {
        method: 'POST',
        body: JSON.stringify({ id: submission.current.id, ...JSON.parse(content) }),
      });
      setText('');
      onClipsChange(current => current.filter(clip => !sentClips.includes(clip)));
      onQuotesChange(current => current.filter(quote => !sentQuotes.includes(quote)));
      submission.current = null;
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="composer-area">
      {reading && (
        <div className="reading-context" title={reading.path} aria-label="当前阅读材料">
          <BookOpen size={14} aria-hidden="true" />
          <span>{reading.path.split('/').pop()}</span>
          {reading.page && <small>第 {reading.page} 页</small>}
        </div>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {voiceNotice && !active && (
        <p className="model-notice" role="status">
          {voiceNotice}
        </p>
      )}
      {voice.error && (
        <div className="voice-error" role="alert">
          <span>{voice.error}</span>
          <button className="text-action" onClick={openModelSettings}>
            语音设置
          </button>
        </div>
      )}
      {!model && <p className="model-notice">暂无可用模型。配置模型后，即可发送消息。</p>}
      {!!quotes.length && <div className="composer-quotes" aria-label="待发送引用">
        {quotes.map((quote, index) => <div className="quote-card" key={index}>
          <div><small>{quote.path.split('/').pop()}{quote.page ? ` · 第 ${quote.page} 页` : ''}{quote.mode === 'source' ? ' · 源码' : ''}</small>
            <blockquote>{quote.text}</blockquote></div>
          <button className="icon-button" aria-label={`移除引用 ${index + 1}`} disabled={submitting}
            onClick={() => onQuotesChange(current => current.filter((_, i) => i !== index))}><X size={17} /></button>
        </div>)}
      </div>}
      {!!clips.length && (
        <div className="composer-clips" aria-label="待发送截图">
          {clips.map((clip, index) => (
            <div className="composer-clip" key={index}>
              <ImageAttachment src={`data:image/png;base64,${clip.data}`} label={`${clip.path.split('/').pop()}${clip.page ? ` · 第 ${clip.page} 页` : ''}`} />
              <button className="icon-button" aria-label={`移除截图 ${index + 1}`} disabled={submitting} onClick={() => onClipsChange(clips.filter((_, i) => i !== index))}><X size={17} /></button>
            </div>
          ))}
        </div>
      )}
      {!!clips.length && model && !supportsImages && <p className="model-notice" role="status">当前模型不支持图片，请切换模型后发送。</p>}
      <div className="composer">
        <textarea
          ref={textarea}
          aria-label="对话消息"
          placeholder={reading ? '围绕当前材料提问…' : '提问，或描述你想完成的修改…'}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
              event.preventDefault();
              void send();
            }
          }}
          maxLength={100000}
        />
        <div className="composer-bottom">
          {voice.pending ? (
            <span
              className="composer-voice-preview"
              title={voice.pending}
              aria-live="polite"
            >
              {voice.pending}
            </span>
          ) : (
            <span className="composer-keyboard-hint">
              {connected ? (
                <>
                  <kbd>Enter</kbd> 发送 <span className="composer-hint">· Shift + Enter 换行</span>
                </>
              ) : (
                '正在连接…'
              )}
            </span>
          )}
          <div className="voice-control">
            <button
              className={`icon-button voice-button${
                voice.state === 'recording'
                  ? ' is-recording'
                  : voice.state === 'permission' ||
                      voice.state === 'connecting' ||
                      voice.state === 'finishing'
                    ? ' is-busy'
                    : ''
              }`}
              aria-label={voiceLabel}
              title={voiceLabel}
              onClick={toggleVoice}
            >
              {voice.state === 'permission' ||
              voice.state === 'connecting' ||
              voice.state === 'finishing' ? (
                <LoaderCircle size={17} className="tool-spinner" />
              ) : voice.state === 'recording' ? (
                <Square size={15} fill="currentColor" />
              ) : (
                <Mic size={17} />
              )}
            </button>
            {voice.state === 'recording' && (
              <button
                className="icon-button voice-cancel"
                aria-label="取消语音输入"
                title="取消语音输入"
                onClick={voice.cancel}
              >
                <X size={17} />
              </button>
            )}
          </div>
          {running ? (
            <button
              className="send-button stop"
              aria-label="停止回答"
              title="停止回答"
              disabled={submitting}
              onClick={async () => {
                setSubmitting(true);
                setError('');
                try {
                  await requestJson(`${url}/stop`, {
                    method: 'POST',
                    body: JSON.stringify({ id: run.id }),
                  });
                } catch (error) {
                  setError((error as Error).message);
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              <Square size={14} fill="currentColor" />
              <span>停止</span>
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="发送消息"
              title="发送消息"
              disabled={submitting || !canSend}
              onClick={() => void send()}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

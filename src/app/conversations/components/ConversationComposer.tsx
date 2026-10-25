'use client';

import { useTranslations } from 'use-intl';

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
  const t = useTranslations();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [voiceNotice, setVoiceNotice] = useState('');
  const submission = useRef<{ id: string; content: string } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { settings, error: speechError } = useSpeechSettings();
  const active = activeSpeech(settings, t);
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
      ? t('speech.recordingTime', {value0: clock(voice.elapsed)})
      : voice.state === 'permission'
        ? t('speech.permissionPending')
        : voice.state === 'connecting'
          ? t('speech.connecting')
          : voice.state === 'finishing'
            ? t('speech.processing')
            : active
              ? t('speech.startWith', {value0: active.name})
              : t('speech.notConfigured');

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
          ? t('speech.settingsError', {value0: speechError})
          : settings
            ? t('speech.startError', {value0: speechUnavailable(settings, t)})
            : t('speech.settingsLoading'),
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
    const content = JSON.stringify({ text: text.trim() || (quotes.length ? t('conversations.explainQuote') : t('conversations.explainImage')), model, thinkingLevel, reading, clips, quotes });
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
        <div className="reading-context" title={reading.path} aria-label={t('files.current')}>
          <BookOpen size={14} aria-hidden="true" />
          <span>{reading.path.split('/').pop()}</span>
          {reading.page && <small>{t("files.pageNumber", {value0: reading.page})}</small>}
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
            {t('speech.settings')}
          </button>
        </div>
      )}
      {!model && <p className="model-notice">{t('models.noneConfigured')}</p>}
      {!!quotes.length && <div className="composer-quotes" aria-label={t('conversations.pendingQuotes')}>
        {quotes.map((quote, index) => <div className="quote-card" key={index}>
          <div><small>{quote.path.split('/').pop()}{quote.page ? t('files.pageSuffix', {value0: quote.page}) : ''}{quote.mode === 'source' ? t('files.sourceSuffix') : ''}</small>
            <blockquote>{quote.text}</blockquote></div>
          <button className="icon-button" aria-label={t('conversations.removeQuote', {value0: index + 1})} disabled={submitting}
            onClick={() => onQuotesChange(current => current.filter((_, i) => i !== index))}><X size={17} /></button>
        </div>)}
      </div>}
      {!!clips.length && (
        <div className="composer-clips" aria-label={t('conversations.pendingImages')}>
          {clips.map((clip, index) => (
            <div className="composer-clip" key={index}>
              <ImageAttachment src={`data:image/png;base64,${clip.data}`} label={`${clip.path.split('/').pop()}${clip.page ? t('files.pageSuffix', {value0: clip.page}) : ''}`} />
              <button className="icon-button" aria-label={t('conversations.removeImage', {value0: index + 1})} disabled={submitting} onClick={() => onClipsChange(clips.filter((_, i) => i !== index))}><X size={17} /></button>
            </div>
          ))}
        </div>
      )}
      {!!clips.length && model && !supportsImages && <p className="model-notice" role="status">{t('models.noImages')}</p>}
      <div className="composer">
        <textarea
          ref={textarea}
          aria-label={t('conversations.message')}
          placeholder={reading ? t('conversations.placeholder') : t('conversations.placeholder')}
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
                  <kbd>Enter</kbd> {t('common.send')} <span className="composer-hint">{t('conversations.newline')}</span>
                </>
              ) : (
                t('common.connecting')
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
                aria-label={t('speech.cancel')}
                title={t('speech.cancel')}
                onClick={voice.cancel}
              >
                <X size={17} />
              </button>
            )}
          </div>
          {running ? (
            <button
              className="send-button stop"
              aria-label={t('conversations.stopAnswer')}
              title={t('conversations.stopAnswer')}
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
              <span>{t('common.stop')}</span>
            </button>
          ) : (
            <button
              className="send-button"
              aria-label={t('conversations.sendMessage')}
              title={t('conversations.sendMessage')}
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

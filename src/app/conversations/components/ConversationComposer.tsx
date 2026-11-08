'use client';

import '../conversations.css';
import './ConversationComposer.css';


import { useTranslations } from 'use-intl';

import {
  ArrowUp,
  BookOpen,
  ListEnd,
  LoaderCircle,
  Mic,
  Square,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useId, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react';

import type { ImageClip, ReadingContext, TextQuote } from '@/app/files/schema';
import {
  activeSpeech,
  speechUnavailable,
} from '@/app/models/active-speech';
import { useSpeechSettings } from '@/app/models/use-speech-settings';
import { openSettings } from '@/app/settings/components/open-settings';
import { requestJson } from '@/shared/http/request-json';

import type { ThinkingLevel } from '@/app/models/schema';

import type { ConversationRun, QueuedMessage, SendMessage } from '../schema';
import { skillCommandPrefix, type SkillCommand } from '../skill-command';
import { ImageAttachment } from './ImageAttachment';
import { useVoiceInput } from './use-voice-input';

function clock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function ConversationComposer({
  url,
  skillCommands,
  model,
  thinkingLevel,
  run,
  queue,
  reading,
  connected,
  delivering,
  onSend,
  clips,
  onClipsChange,
  quotes,
  onQuotesChange,
  supportsImages,
  modelControl,
}: {
  url: string;
  skillCommands: SkillCommand[];
  model: string;
  thinkingLevel?: ThinkingLevel;
  run: ConversationRun | null;
  queue: QueuedMessage[];
  reading: ReadingContext | null;
  connected: boolean;
  delivering: boolean;
  onSend: (input: SendMessage) => void;
  clips: ImageClip[];
  onClipsChange: Dispatch<SetStateAction<ImageClip[]>>;
  quotes: TextQuote[];
  onQuotesChange: Dispatch<SetStateAction<TextQuote[]>>;
  supportsImages: boolean;
  modelControl: ReactNode;
}) {
  const t = useTranslations();
  const [text, setText] = useState('');
  const [skillIndex, setSkillIndex] = useState<number | null>(null);
  const [dismissedSkills, setDismissedSkills] = useState(false);
  const skillListId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [voiceNotice, setVoiceNotice] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { settings, error: speechError } = useSpeechSettings();
  const active = activeSpeech(settings, t);
  const voice = useVoiceInput({ text, onTextChange: changeText, textarea });
  const running = run?.status === 'accepted' || run?.status === 'running';
  const skillInput = text.trimStart();
  const skills = !dismissedSkills && !submitting && voice.state === 'idle' &&
    skillInput.startsWith('/') && !/\s/.test(skillInput)
    ? skillCommands.filter(skill => `${skillCommandPrefix}${skill.name}`.startsWith(skillInput))
    : [];
  const canSend =
    (text.trim() || clips.length || quotes.length) &&
    model &&
    !delivering &&
    voice.state === 'idle' &&
    (!clips.length || supportsImages);
  const sendLabel = t(running || queue.length ? 'conversations.queueMessage' : 'conversations.sendMessage');

  function openModelSettings() {
    openSettings('models');
  }

  function changeText(value: string) {
    setText(value);
    setSkillIndex(null);
    setDismissedSkills(false);
  }

  function chooseSkill(skill: SkillCommand) {
    changeText(`${skillCommandPrefix}${skill.name} `);
    textarea.current?.focus();
  }

  const voiceLabel =
    voice.state === 'recording'
      ? t('speech.recordingTime', {value0: clock(voice.elapsed)})
      : voice.state === 'permission'
        ? t('speech.permissionPending')
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

  async function runAction(action: () => Promise<unknown>) {
    setSubmitting(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function send() {
    if (submitting || !canSend) return;
    onSend({
      id: crypto.randomUUID(),
      text: text.trim() || (quotes.length ? t('conversations.explainQuote') : t('conversations.explainImage')),
      model,
      thinkingLevel,
      reading,
      clips,
      quotes,
      queueIfBusy: true,
    });
    changeText('');
    onClipsChange([]);
    onQuotesChange([]);
  }

  return (
    <div className="composer-area">
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
      {!!queue.length && <section className="composer-queue" aria-label={t('conversations.queuedMessages')}>
        <div className="composer-queue-heading">
          <span role="status">{t(running ? 'conversations.queuedMessages' : 'conversations.queuePaused')} · {queue.length}</span>
          {!running && <button className="text-action" type="button" disabled={submitting || !connected}
            onClick={() => void runAction(() => requestJson(`${url}/queue`, { method: 'POST' }))}>
            {t('conversations.resumeQueue')}
          </button>}
        </div>
        <ol>
          {queue.map((item, index) => <li key={item.id}>
            <span title={item.text}>{item.text}</span>
            <button className="icon-button" type="button" disabled={submitting || !connected}
              aria-label={t('conversations.removeQueued', { value0: index + 1 })}
              onClick={() => void runAction(() => requestJson(`${url}/queue?id=${item.id}`, { method: 'DELETE' }))}>
              <X size={16} />
            </button>
          </li>)}
        </ol>
      </section>}
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
        {reading && (
          <div className="reading-context" title={reading.path} aria-label={t('files.current')}>
            <BookOpen size={14} aria-hidden="true" />
            <span>{reading.path.split('/').pop()}</span>
            {reading.page && <small>{t('files.pageNumber', {value0: reading.page})}</small>}
          </div>
        )}
        {skills.length > 0 && <div className="composer-skills" id={skillListId} role="listbox" aria-label={t('conversations.skills')}>
          {skills.map((skill, index) => (
            <button key={skill.name} type="button" role="option" id={`${skillListId}-${index}`}
              aria-selected={index === skillIndex} onClick={() => chooseSkill(skill)}>
              <code>{skillCommandPrefix}{skill.name}</code>
              <span>{skill.description}</span>
            </button>
          ))}
        </div>}
        <textarea
          ref={textarea}
          aria-label={t('conversations.message')}
          aria-autocomplete="list"
          aria-controls={skills.length ? skillListId : undefined}
          aria-activedescendant={skills.length && skillIndex !== null ? `${skillListId}-${skillIndex}` : undefined}
          value={text}
          onChange={(event) => changeText(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (skills.length && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
              if (event.key === 'Escape') {
                event.preventDefault();
                setDismissedSkills(true);
                setSkillIndex(null);
                return;
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const down = event.key === 'ArrowDown';
                const next = skillIndex === null ? (down ? 0 : skills.length - 1)
                  : (skillIndex + (down ? 1 : -1) + skills.length) % skills.length;
                setSkillIndex(next);
                return;
              }
              const exact = skills.some(skill => skillInput === `${skillCommandPrefix}${skill.name}`);
              if (event.key === 'Tab' || (event.key === 'Enter' && (skillIndex !== null || !exact))) {
                event.preventDefault();
                chooseSkill(skills[skillIndex ?? 0]);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
              event.preventDefault();
              send();
            }
          }}
          maxLength={100000}
        />
        {voice.pending && (
          <div className="composer-voice-preview" title={voice.pending} aria-live="polite">
            {voice.pending}
          </div>
        )}
        <div className="composer-bottom">
          {modelControl}
          <div className="voice-control">
            {voice.state === 'recording' && <span className="voice-time" role="status" aria-label={voiceLabel}>
              {voice.connecting && <LoaderCircle size={12} className="tool-spinner" aria-label={t('speech.connecting')} />}
              {clock(voice.elapsed)}
            </span>}
            <button
              className={clsx('icon-button voice-button', {
                'is-recording': voice.state === 'recording',
                'is-busy': voice.state === 'permission' || voice.state === 'finishing',
              })}
              aria-label={voiceLabel}
              title={voiceLabel}
              onClick={toggleVoice}
            >
              {voice.state === 'permission' ||
              voice.state === 'finishing' ? (
                <LoaderCircle size={17} className="tool-spinner" />
              ) : voice.state === 'recording' ? (
                <Square size={15} fill="currentColor" />
              ) : (
                <Mic size={17} />
              )}
            </button>
            {(voice.state === 'recording' || voice.state === 'finishing') && (
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
          {running && (
            <button
              className="send-button stop"
              aria-label={t('conversations.stopAnswer')}
              title={t('conversations.stopAnswer')}
              disabled={submitting}
              onClick={() => void runAction(() => requestJson(`${url}/stop`, {
                method: 'POST',
                body: JSON.stringify({ id: run.id }),
              }))}
            >
              <Square size={14} fill="currentColor" />
              <span>{t('common.stop')}</span>
            </button>
          )}
          <button
            className="send-button"
            aria-label={sendLabel}
            title={sendLabel}
            disabled={submitting || !canSend}
            onClick={send}
          >
            {running || queue.length ? <ListEnd size={19} /> : <ArrowUp size={19} />}
          </button>
        </div>
      </div>
    </div>
  );
}

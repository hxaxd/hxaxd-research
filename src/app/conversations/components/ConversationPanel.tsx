'use client';

import { useTranslations } from 'use-intl';

import { useState, type Dispatch, type SetStateAction } from 'react';

import type { ImageClip, ReadingContext, TextQuote } from '@/app/files/schema';
import { ModelSettingsButton } from '@/app/models/components/ModelSettingsButton';
import type { ConfiguredModel, ThinkingLevel } from '@/app/models/schema';
import { ChoiceSelect } from '@/shared/ui/ChoiceSelect';

import type { Conversation } from '../schema';
import { ConversationComposer } from './ConversationComposer';
import { ConversationMessages } from './ConversationMessages';
import { useConversationStream } from './use-conversation-stream';

export function ConversationPanel({
  workspaceId,
  conversation,
  models,
  model,
  onModelChange,
  reading,
  clips,
  onClipsChange,
  quotes,
  onQuotesChange,
  onOpenQuote,
}: {
  workspaceId: string;
  conversation: Conversation;
  models: ConfiguredModel[];
  model: string;
  onModelChange: (id: string) => void;
  reading: ReadingContext | null;
  clips: ImageClip[];
  onClipsChange: Dispatch<SetStateAction<ImageClip[]>>;
  quotes: TextQuote[];
  onQuotesChange: Dispatch<SetStateAction<TextQuote[]>>;
  onOpenQuote: (quote: TextQuote) => void;
}) {
  const t = useTranslations();
  const [preferences, setPreferences] = useState<Record<string, ThinkingLevel>>(() =>
    typeof window === 'undefined' ? {} : JSON.parse(localStorage.getItem('research-thinking-levels') ?? '{}'));
  const levels = models.find(item => item.id === model)?.thinkingLevels ?? [];
  const thinking = levels.includes(preferences[model]) ? preferences[model] : levels.includes('medium') ? 'medium' : levels[0];
  const thinkingNames = { off: t('models.thinkingOff'), minimal: t('models.thinkingMinimal'), low: t('models.thinkingLow'), medium: t('models.thinkingMedium'), high: t('models.thinkingHigh'), xhigh: t('models.thinkingXhigh'), max: t('models.thinkingMax') };
  const url = `/api/workspaces/${workspaceId}/conversations/${conversation.id}`;
  const { snapshot, connected, error } = useConversationStream(url);
  const running =
    snapshot?.run?.status === 'accepted' || snapshot?.run?.status === 'running';
  return (
    <>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <ConversationMessages snapshot={snapshot} onOpenQuote={onOpenQuote} />
      <div className="model-toolbar">
        <span
          className="connection-indicator"
          role="status"
          aria-label={connected ? t('conversations.connected') : t('conversations.connecting')}
          title={connected ? t('conversations.connected') : t('conversations.connecting')}
        >
          <span className={`status-dot${connected ? ' connected' : ''}`} />
        </span>
        <span className="model-label">{t('models.model')}</span>
        <ChoiceSelect
          label={t('models.select')}
          value={model}
          items={models.map((model) => ({ ...model, detail: model.provider }))}
          onChange={onModelChange}
          disabled={running || !models.length}
          placeholder={models.length ? t('models.select') : t('models.none')}
        />
        {levels.length > 1 && <ChoiceSelect label={t('models.thinking')} value={thinking ?? ''} disabled={running}
          items={levels.map(id => ({ id, name: t('models.thinkingValue', {value0: thinkingNames[id]}) }))}
          onChange={value => { const next = { ...preferences, [model]: value as ThinkingLevel }; setPreferences(next); localStorage.setItem('research-thinking-levels', JSON.stringify(next)); }} />}
        <ModelSettingsButton />
      </div>
      <ConversationComposer
        url={url}
        model={model}
        thinkingLevel={thinking}
        run={snapshot?.run ?? null}
        reading={reading}
        connected={connected}
        clips={clips}
        onClipsChange={onClipsChange}
        quotes={quotes}
        onQuotesChange={onQuotesChange}
        supportsImages={models.find(item => item.id === model)?.input.includes('image') ?? false}
      />
    </>
  );
}

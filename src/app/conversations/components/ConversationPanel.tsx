'use client';

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
  const [preferences, setPreferences] = useState<Record<string, ThinkingLevel>>(() =>
    typeof window === 'undefined' ? {} : JSON.parse(localStorage.getItem('research-thinking-levels') ?? '{}'));
  const levels = models.find(item => item.id === model)?.thinkingLevels ?? [];
  const thinking = levels.includes(preferences[model]) ? preferences[model] : levels.includes('medium') ? 'medium' : levels[0];
  const thinkingNames = { off: '关闭', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
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
          aria-label={connected ? '对话已连接' : '正在连接对话'}
          title={connected ? '对话已连接' : '正在连接对话'}
        >
          <span className={`status-dot${connected ? ' connected' : ''}`} />
        </span>
        <span className="model-label">模型</span>
        <ChoiceSelect
          label="选择模型"
          value={model}
          items={models.map((model) => ({ ...model, detail: model.provider }))}
          onChange={onModelChange}
          disabled={running || !models.length}
          placeholder={models.length ? '选择模型' : '暂无可用模型'}
        />
        {levels.length > 1 && <ChoiceSelect label="推理强度" value={thinking ?? ''} disabled={running}
          items={levels.map(id => ({ id, name: `推理 · ${thinkingNames[id]}` }))}
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

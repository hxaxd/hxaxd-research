'use client';

import '../conversations.css';


import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import type { ImageClip, ReadingContext } from '@/app/files/schema';
import { ModelSelector } from '@/app/models/components/ModelSelector';
import type { ConfiguredModel, ThinkingLevel } from '@/app/models/schema';

import type { AssistantQuote, Conversation, ConversationQuote } from '../schema';
import type { SkillCommand } from '../skill-command';
import { ConversationComposer } from './ConversationComposer';
import { ConversationMessages } from './ConversationMessages';
import { useConversationStream } from './use-conversation-stream';
import type { useMessageDelivery } from './use-message-delivery';

export function ConversationPanel({
  workspaceId,
  conversation,
  delivery,
  skillCommands,
  models,
  model,
  onModelChange,
  reading,
  clips,
  onClipsChange,
  quotes,
  onQuotesChange,
  onQuote,
  onOpenDocument,
}: {
  workspaceId: string;
  conversation: Conversation;
  delivery: ReturnType<typeof useMessageDelivery>;
  skillCommands: SkillCommand[];
  models: ConfiguredModel[];
  model: string;
  onModelChange: (id: string) => void;
  reading: ReadingContext | null;
  clips: ImageClip[];
  onClipsChange: Dispatch<SetStateAction<ImageClip[]>>;
  quotes: ConversationQuote[];
  onQuotesChange: Dispatch<SetStateAction<ConversationQuote[]>>;
  onQuote: (quote: AssistantQuote) => Promise<void>;
  onOpenDocument: (target: ReadingContext) => void;
}) {
  const [preferences, setPreferences] = useState<Record<string, ThinkingLevel>>(() =>
    typeof window === 'undefined' ? {} : JSON.parse(localStorage.getItem('research-thinking-levels') ?? '{}'));
  const selectedModel = models.find(item => item.id === model);
  const levels = selectedModel?.thinkingLevels ?? [];
  const thinking = levels.includes(preferences[model]) ? preferences[model] : levels.includes('medium') ? 'medium' : levels[0];
  const url = `/api/workspaces/${workspaceId}/conversations/${conversation.id}`;
  const { snapshot, connected, error } = useConversationStream(url);
  const { observe } = delivery;
  const outgoing = delivery.byUrl[url];
  useEffect(() => {
    if (snapshot && outgoing?.length) observe(url, outgoing, snapshot);
  }, [snapshot, observe, outgoing, url]);
  const running = snapshot?.run?.status === 'accepted' || snapshot?.run?.status === 'running';
  return (
    <>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <div className="conversation-history">
        <ConversationMessages snapshot={snapshot} outgoing={outgoing} workspaceId={workspaceId}
          onStopDelivery={input => delivery.stop(url, input)}
          onRetryDelivery={item => delivery.retry(url, item)}
          onDismissDelivery={id => delivery.dismiss(url, id)}
          onOpenDocument={onOpenDocument} onQuote={onQuote} url={url} />
      </div>
      <ConversationComposer
        url={url}
        skillCommands={skillCommands}
        model={model}
        thinkingLevel={thinking}
        run={snapshot?.run ?? null}
        queue={snapshot?.queue ?? []}
        reading={reading}
        connected={connected}
        delivering={outgoing?.some(item => item.status === 'sending' || item.status === 'retrying' || item.status === 'stopping') ?? false}
        onSend={input => delivery.send(url, input)}
        clips={clips}
        onClipsChange={onClipsChange}
        quotes={quotes}
        onQuotesChange={onQuotesChange}
        supportsImages={selectedModel?.input.includes('image') ?? false}
        modelControl={<ModelSelector models={models} model={model} onModelChange={onModelChange} thinking={thinking}
          connected={connected} disabled={running}
          onThinkingChange={value => {
            const next = { ...preferences, [model]: value };
            setPreferences(next);
            localStorage.setItem('research-thinking-levels', JSON.stringify(next));
          }} />}
      />
    </>
  );
}

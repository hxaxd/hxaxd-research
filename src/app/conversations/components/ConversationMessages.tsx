'use client';

import '../conversations.css';
import './ConversationMessages.css';


import { useTranslations } from 'use-intl';

import { MessageCircle } from 'lucide-react';
import { memo, useEffect, useRef } from 'react';

import { Markdown } from '@/shared/ui/Markdown';
import type { ReadingContext } from '@/app/files/schema';
import { resolveWorkspaceLink } from '@/app/files/workspace-link';

import type { ChatMessage, ConversationSnapshot } from '../schema';
import { ToolExecutionGroup } from './ToolExecutionMessage';
import { ImageAttachment } from './ImageAttachment';
import { QuestionMessage } from './QuestionMessage';

export const ConversationMessages = memo(function ConversationMessages({ snapshot, workspaceId, onOpenDocument, url }: {
  snapshot: ConversationSnapshot | null;
  workspaceId: string;
  onOpenDocument: (target: ReadingContext) => void;
  url: string;
}) {
  const t = useTranslations();
  const end = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const messages = snapshot?.messages ?? [];
  const blocks: (ChatMessage | ChatMessage[])[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && !message.text.trim()) continue;
    const previous = blocks.at(-1);
    if (message.role === 'tool' && !message.question) {
      if (Array.isArray(previous)) previous.push(message);
      else blocks.push([message]);
    } else blocks.push(message);
  }
  const status = snapshot?.run?.status;
  const running = status === 'accepted' || status === 'running';
  const last = messages.at(-1);
  const streamingId = running && last?.role === 'assistant' ? last.id : null;
  useEffect(() => {
    if (following.current) end.current?.scrollIntoView({ block: 'end' });
  }, [snapshot?.revision]);
  return (
    <div
      className="conversation-messages"
      onScroll={(event) => {
        const el = event.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      }}
    >
      {!messages.length && (
        <div className="chat-empty">
          <MessageCircle size={26} strokeWidth={1.3} />
          <h3>{t('conversations.empty')}</h3>
        </div>
      )}
      {blocks.map((message) =>
          Array.isArray(message) ? (
            <ToolExecutionGroup key={message[0].id} messages={message} />
          ) : message.question ? (
            <QuestionMessage key={message.id} question={message.question} url={url} />
          ) : (
            <article className={`chat-message ${message.role}`} key={message.id}
              aria-label={message.role === 'user' ? t('conversations.you') : t('conversations.assistant')}>
              {!!message.images?.length && <div className="message-images">{message.images.map((image, index) => (
                <ImageAttachment key={index} src={image.url} label={t('conversations.imageNumber', {value0: index + 1})} />
              ))}</div>}
              {!!message.quotes?.length && <div className="message-quotes" aria-label={t('conversations.quotedText')}>
                {message.quotes.map((quote, index) => <button className="quote-card" key={index} onClick={() => onOpenDocument(quote)}>
                  <small>{quote.path}{quote.page ? t('files.pageSuffix', {value0: quote.page}) : ''}{quote.mode === 'source' ? t('files.sourceSuffix') : ''}</small>
                  <blockquote>{quote.text}</blockquote>
                </button>)}
              </div>}
              <div className="markdown">
                <Markdown
                  components={{
                    a: ({ href, children }) => {
                      // Workspace files open in the reader; everything else keeps normal browser behavior.
                      const target = href ? resolveWorkspaceLink(href, workspaceId) : null;
                      return <a
                        href={href}
                        title={target?.path}
                        target={target ? undefined : '_blank'}
                        rel={target ? undefined : 'noopener noreferrer'}
                        onClick={event => {
                          const link = resolveWorkspaceLink(event.currentTarget.getAttribute('href') ?? '', workspaceId, window.location.origin);
                          if (!link) return;
                          event.preventDefault();
                          onOpenDocument(link);
                        }}
                      >{children}</a>;
                    },
                  }}
                  streaming={message.role === 'assistant' && message.id === streamingId}
                >{message.text || '…'}</Markdown>
              </div>
            </article>
          ),
        )}
      {running && (
        <div className="run-status" role="status">
          <span className="status-dot running" />
          {messages.some(message => message.question && message.question.answer === undefined)
            ? t('conversations.waitingAnswer')
            : status === 'accepted' ? t('conversations.preparing') : t('conversations.responding')}
        </div>
      )}
      {status === 'cancelled' && (
        <p className="run-notice">{t('conversations.cancelled')}</p>
      )}
      {status === 'failed' && !snapshot?.error && (
        <p role="alert" className="error-message">
          {t('conversations.failed')}
        </p>
      )}
      {snapshot?.error && (
        <p role="alert" className="error-message">
          {snapshot.error}
        </p>
      )}
      <div ref={end} />
    </div>
  );
});

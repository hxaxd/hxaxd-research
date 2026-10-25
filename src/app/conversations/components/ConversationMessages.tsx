'use client';

import { useTranslations } from 'use-intl';

import { Bot, MessageCircle, UserRound } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Markdown } from '@/shared/ui/Markdown';
import type { TextQuote } from '@/app/files/schema';

import type { ConversationSnapshot } from '../schema';
import { ToolExecutionMessage } from './ToolExecutionMessage';
import { ImageAttachment } from './ImageAttachment';

export function ConversationMessages({ snapshot, onOpenQuote }: {
  snapshot: ConversationSnapshot | null;
  onOpenQuote: (quote: TextQuote) => void;
}) {
  const t = useTranslations();
  const end = useRef<HTMLDivElement>(null);
  const following = useRef(true);
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
      {!snapshot?.messages.length && (
        <div className="chat-empty">
          <MessageCircle size={26} strokeWidth={1.3} />
          <h3>{t('conversations.empty')}</h3>
        </div>
      )}
      {snapshot?.messages
        .filter((message) => message.role !== 'assistant' || message.text.trim())
        .map((message) =>
          message.role === 'tool' ? (
            <ToolExecutionMessage key={message.id} message={message} />
          ) : (
            <article className={`chat-message ${message.role}`} key={message.id}>
              <div className="message-author">
                <span className="author-avatar">
                  {message.role === 'user' ? (
                    <UserRound size={13} aria-hidden="true" />
                  ) : (
                    <Bot size={14} aria-hidden="true" />
                  )}
                </span>
                {message.role === 'user' ? t('conversations.you') : t('conversations.assistant')}
              </div>
              {!!message.images?.length && <div className="message-images">{message.images.map((image, index) => (
                <ImageAttachment key={index} src={image.url} label={t('conversations.imageNumber', {value0: index + 1})} />
              ))}</div>}
              {!!message.quotes?.length && <div className="message-quotes" aria-label={t('conversations.quotedText')}>
                {message.quotes.map((quote, index) => <button className="quote-card" key={index} onClick={() => onOpenQuote(quote)}>
                  <small>{quote.path}{quote.page ? t('files.pageSuffix', {value0: quote.page}) : ''}{quote.mode === 'source' ? t('files.sourceSuffix') : ''}</small>
                  <blockquote>{quote.text}</blockquote>
                </button>)}
              </div>}
              <div className="markdown">
                <Markdown
                  components={{
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                    ),
                  }}
                >{message.text || '…'}</Markdown>
              </div>
            </article>
          ),
        )}
      {(snapshot?.run?.status === 'accepted' || snapshot?.run?.status === 'running') && (
        <div className="run-status" role="status">
          <span className="status-dot running" />
          {snapshot.run.status === 'accepted' ? t('conversations.preparing') : t('conversations.responding')}
        </div>
      )}
      {snapshot?.run?.status === 'cancelled' && (
        <p className="run-notice">{t('conversations.cancelled')}</p>
      )}
      {snapshot?.run?.status === 'failed' && !snapshot.error && (
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
}

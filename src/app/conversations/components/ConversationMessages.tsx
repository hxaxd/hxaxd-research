'use client';

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
          <h3>把问题交给材料</h3>
          <p>打开材料，询问它的核心观点、推导过程，或与你的研究有什么联系。</p>
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
                {message.role === 'user' ? '你' : '研究助手'}
              </div>
              {!!message.images?.length && <div className="message-images">{message.images.map((image, index) => (
                <ImageAttachment key={index} src={image.url} label={`截图 ${index + 1}`} />
              ))}</div>}
              {!!message.quotes?.length && <div className="message-quotes" aria-label="引用原文">
                {message.quotes.map((quote, index) => <button className="quote-card" key={index} onClick={() => onOpenQuote(quote)}>
                  <small>{quote.path}{quote.page ? ` · 第 ${quote.page} 页` : ''}{quote.mode === 'source' ? ' · 源码' : ''}</small>
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
          {snapshot.run.status === 'accepted' ? '正在准备回答…' : '正在回答，可随时停止'}
        </div>
      )}
      {snapshot?.run?.status === 'cancelled' && (
        <p className="run-notice">回答已停止，已生成的内容保留。</p>
      )}
      {snapshot?.run?.status === 'failed' && !snapshot.error && (
        <p role="alert" className="error-message">
          上次回答未完成，请检查模型配置或本地服务日志后重试。
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

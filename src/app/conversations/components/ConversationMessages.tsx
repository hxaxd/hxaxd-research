'use client';

import '../conversations.css';
import './ConversationMessages.css';


import { useTranslations } from 'use-intl';

import { MessageCircle } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';

import { Markdown } from '@/shared/ui/Markdown';
import type { ReadingContext } from '@/app/files/schema';
import { resolveWorkspaceLink } from '@/app/files/workspace-link';

import type { AssistantQuote, ChatMessage, ConversationSnapshot, SendMessage } from '../schema';
import type { Delivery } from './use-message-delivery';
import { ToolExecutionGroup } from './ToolExecutionMessage';
import { ImageAttachment } from './ImageAttachment';
import { QuestionMessage } from './QuestionMessage';
import { QuoteSelectionActions } from './QuoteSelectionActions';

const deliveryLabels = {
  sending: 'conversations.sending',
  retrying: 'conversations.connectionRetry',
  accepted: 'conversations.preparing',
  stopping: 'conversations.stoppingSend',
  stopped: 'conversations.sendStopped',
  failed: 'conversations.sendFailed',
} as const;

export const ConversationMessages = memo(function ConversationMessages({
  snapshot, outgoing, workspaceId, onStopDelivery, onRetryDelivery, onDismissDelivery, onOpenDocument, onQuote, url,
}: {
  snapshot: ConversationSnapshot | null;
  outgoing?: Delivery[];
  workspaceId: string;
  onStopDelivery: (input: SendMessage) => void;
  onRetryDelivery: (item: Delivery) => void;
  onDismissDelivery: (id: string) => void;
  onOpenDocument: (target: ReadingContext) => void;
  onQuote: (quote: AssistantQuote) => Promise<void>;
  url: string;
}) {
  const t = useTranslations();
  const end = useRef<HTMLDivElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [selection, setSelection] = useState<AssistantQuote | null>(null);
  const [dismissedRun, setDismissedRun] = useState<string | null>(null);
  const messages = snapshot?.messages ?? [];
  const pending = outgoing?.filter(({ input }) =>
    !messages.some(message => message.id === input.id) && !snapshot?.queue.some(message => message.id === input.id)) ?? [];
  const deliveries = new Map(pending.map(item => [item.input.id, item]));
  const blocks: (ChatMessage | ChatMessage[])[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && !message.text.trim()) continue;
    const previous = blocks.at(-1);
    if (message.role === 'tool' && !message.question) {
      if (Array.isArray(previous)) previous.push(message);
      else blocks.push([message]);
    } else blocks.push(message);
  }
  for (const { input } of pending) {
    blocks.push({
      id: input.id,
      role: 'user',
      text: input.text,
      quotes: input.quotes,
      images: input.clips?.map(({ data }) => ({ url: `data:image/png;base64,${data}` })),
    });
  }
  const status = snapshot?.run?.status;
  const showRunNotice = snapshot?.run?.id !== dismissedRun && !pending.some(item => item.input.id === snapshot?.run?.id);
  const running = status === 'accepted' || status === 'running';
  const last = messages.at(-1);
  const streamingId = running && last?.role === 'assistant' ? last.id : null;
  useEffect(() => {
    if (following.current) end.current?.scrollIntoView({ block: 'end' });
  }, [snapshot?.revision, outgoing]);
  useEffect(() => {
    function updateSelection() {
      const selected = document.getSelection();
      const text = selected?.toString().trim();
      const node = selected?.rangeCount ? selected.getRangeAt(0).commonAncestorContainer : null;
      const parent = node instanceof Element ? node : node?.parentElement;
      const reply = parent?.closest<HTMLElement>('[data-reply-id]');
      const messageId = reply?.dataset.replyId;
      setSelection(text && messageId && reply && history.current?.contains(reply) ? { text, messageId } : null);
    }
    document.addEventListener('selectionchange', updateSelection);
    document.addEventListener('pointerup', updateSelection);
    return () => {
      document.removeEventListener('selectionchange', updateSelection);
      document.removeEventListener('pointerup', updateSelection);
    };
  }, []);

  function jumpToReply(messageId: string) {
    const reply = history.current?.querySelector<HTMLElement>(`[data-reply-id="${CSS.escape(messageId)}"]`);
    if (!reply) return;
    following.current = false;
    reply.focus({ preventScroll: true });
    reply.scrollIntoView({ block: 'center' });
  }

  return <>
    <div
      className="conversation-messages"
      ref={history}
      onScroll={(event) => {
        const el = event.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      }}
    >
      {!blocks.length && (
        <div className="chat-empty">
          <MessageCircle size={26} strokeWidth={1.3} />
          <h3>{t('conversations.empty')}</h3>
        </div>
      )}
      {blocks.map((message) => {
        const delivery = Array.isArray(message) ? undefined : deliveries.get(message.id);
        const deliveryError = delivery?.error ??
          (delivery?.status === 'failed' && delivery.input.id === snapshot?.run?.id ? snapshot.error : null);
        return Array.isArray(message) ? (
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
                {message.quotes.map((quote, index) => <button type="button" className="quote-card" key={index}
                  onClick={() => 'messageId' in quote ? jumpToReply(quote.messageId) : onOpenDocument(quote)}>
                  <small>{'messageId' in quote ? t('conversations.assistant') : <>
                    {quote.path}{quote.page ? t('files.pageSuffix', {value0: quote.page}) : ''}{quote.mode === 'source' ? t('files.sourceSuffix') : ''}
                  </>}</small>
                  <blockquote>{quote.text}</blockquote>
                </button>)}
              </div>}
              <div className="markdown" tabIndex={message.role === 'assistant' ? -1 : undefined}
                data-reply-id={message.role === 'assistant' && !message.id.startsWith('live:') ? message.id : undefined}>
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
              {delivery && <div className="message-delivery">
                <span role={delivery.status === 'failed' ? 'alert' : 'status'}>
                  {t(deliveryLabels[delivery.status])}{deliveryError ? ` · ${deliveryError}` : ''}
                </span>
                {(delivery.status === 'sending' || delivery.status === 'retrying' || delivery.status === 'accepted') &&
                  <button type="button" className="text-action" onClick={() => onStopDelivery(delivery.input)}>
                    {t('common.stop')}
                  </button>}
                {(delivery.status === 'failed' || delivery.status === 'stopped') && (
                  <div className="message-delivery-actions">
                    <button type="button" className="text-action" onClick={() => onRetryDelivery(delivery)}>
                      {t('conversations.resendMessage')}
                    </button>
                    <button type="button" className="text-action" onClick={() => {
                      if (snapshot?.run?.id === delivery.input.id) setDismissedRun(delivery.input.id);
                      onDismissDelivery(delivery.input.id);
                    }}>
                      {t('conversations.dismissDelivery')}
                    </button>
                  </div>
                )}
              </div>}
            </article>
          );
        })}
      {running && !pending.some(item => item.input.id === snapshot?.run?.id) && (
        <div className="run-status" role="status">
          <span className="status-dot running" />
          {snapshot?.run?.retrying ? t('conversations.modelConnectionRetry')
            : messages.some(message => message.question && message.question.answer === undefined)
              ? t('conversations.waitingAnswer')
              : status === 'accepted' ? t('conversations.preparing') : t('conversations.responding')}
        </div>
      )}
      {showRunNotice && status === 'cancelled' && (
        <p className="run-notice">{t('conversations.cancelled')}</p>
      )}
      {showRunNotice && status === 'failed' && !snapshot?.error && (
        <p role="alert" className="error-message">
          {t('conversations.failed')}
        </p>
      )}
      {showRunNotice && snapshot?.error && (
        <p role="alert" className="error-message">
          {snapshot.error}
        </p>
      )}
      <div ref={end} />
    </div>
    {selection && <QuoteSelectionActions key={selection.text} text={selection.text} onClear={() => setSelection(null)}
      onAttach={async () => { await onQuote(selection); document.getSelection()?.removeAllRanges(); setSelection(null); }} />}
  </>;
});

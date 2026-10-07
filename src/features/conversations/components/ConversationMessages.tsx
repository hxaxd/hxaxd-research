'use client';
import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageCircle } from 'lucide-react';
import type { ConversationSnapshot } from '../conversation-schema';
import { ToolExecutionMessage } from './ToolExecutionMessage';
export function ConversationMessages({ snapshot }: { snapshot: ConversationSnapshot | null }) {
  const end = useRef<HTMLDivElement>(null), following = useRef(true);
  useEffect(() => { if (following.current) end.current?.scrollIntoView({ block: 'end' }); }, [snapshot?.revision]);
  return <div className="conversation-messages" onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
    {!snapshot?.messages.length && <div className="chat-empty"><MessageCircle size={26} strokeWidth={1.3} /><h3>一起读，一起想</h3><p>直接提问，或先把左侧材料加入对话。</p></div>}
    {snapshot?.messages.filter(message => message.role !== 'assistant' || message.text.trim()).map(message => message.role === 'tool' ? <ToolExecutionMessage key={message.id} message={message} /> : <article className={`chat-message ${message.role}`} key={message.id}><div className="message-author">{message.role === 'user' ? '你' : '助手'}</div><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text || '…'}</ReactMarkdown></div></article>)}
    {snapshot?.run?.status === 'interrupted' && <p className="preview-notice">上次回答因应用退出而中断。已保存的内容保留；再次发送会启动新回答。</p>}
    {snapshot?.run?.status === 'failed' && !snapshot.error && <p role="alert" className="error-message">上次回答未完成，请检查模型配置或本地服务日志后重试。</p>}
    {snapshot?.error && <p role="alert" className="error-message">{snapshot.error}</p>}
    <div ref={end} />
  </div>;
}

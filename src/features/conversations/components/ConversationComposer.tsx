'use client';
import { useRef, useState } from 'react';
import { ArrowUp, Square, X, Paperclip } from 'lucide-react';
import { requestJson } from '@/shared/http/request-json';
import type { MaterialReference } from '@/features/files/file-schema';
import type { ConversationRun } from '../conversation-schema';
export function ConversationComposer({ url, model, run, materials, onRemove, onSent, connected }: { url: string; model: string; run: ConversationRun | null; materials: MaterialReference[]; onRemove: (path: string) => void; onSent: () => void; connected: boolean }) {
  const [text, setText] = useState(''), [submitting, setSubmitting] = useState(false), [error, setError] = useState('');
  const submission = useRef<{ id: string; content: string } | null>(null);
  const running = run?.status === 'accepted' || run?.status === 'running';
  async function send() {
    if (running || submitting || !text.trim() || !model || !connected) return;
    const content = JSON.stringify({ text: text.trim(), model, materials });
    if (!submission.current || submission.current.content !== content) submission.current = { id: crypto.randomUUID(), content };
    setSubmitting(true); setError('');
    try { await requestJson(`${url}/messages`, { method: 'POST', body: JSON.stringify({ id: submission.current.id, ...JSON.parse(content) }) }); setText(''); submission.current = null; onSent(); }
    catch (error) { setError(error instanceof Error ? error.message : '发送失败'); }
    finally { setSubmitting(false); }
  }
  return <div className="composer-area">
    {!!materials.length && <div className="material-chips">{materials.map(material => <span className="material-chip" key={material.path} title={material.path}><Paperclip size={12} /><span>{material.path.split('/').pop()}</span><button aria-label={`移除引用 ${material.path.split('/').pop()}`} onClick={() => onRemove(material.path)}><X size={12} /></button></span>)}</div>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {!model && <p className="model-notice">配置模型后即可开始对话。材料阅读仍可使用。</p>}
    <div className="composer"><textarea aria-label="对话消息" placeholder="问一个问题，或描述你想完成的修改…" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} maxLength={100000} />
      <div className="composer-bottom"><span>{connected ? 'Enter 发送 · Shift + Enter 换行' : '正在连接…'}</span>{running ? <button className="send-button stop" aria-label="停止回答" disabled={submitting} onClick={async () => { setSubmitting(true); setError(''); try { await requestJson(`${url}/stop`, { method: 'POST', body: JSON.stringify({ id: run.id }) }); } catch (error) { setError(error instanceof Error ? error.message : '停止失败'); } finally { setSubmitting(false); } }}><Square size={14} fill="currentColor" /></button> : <button className="send-button" aria-label="发送消息" disabled={submitting || !text.trim() || !model || !connected} onClick={() => void send()}><ArrowUp size={19} /></button>}</div>
    </div>
  </div>;
}

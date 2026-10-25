'use client';

import { ArrowUpRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { publishSpeechSettings, useSpeechSettings } from '@/features/models/use-speech-settings';
import type { SpeechTestResult } from '@/features/speech/schema';
import { requestJson } from '@/shared/http/request-json';
import type { Authorization, ModelConnection, ModelConnectionInput, ProviderSettings, SpeechConnection, SpeechConnectionInput, SpeechSettings } from '../schema';
import { ConnectionForm } from './ConnectionForm';

const authorizationUrl = '/api/model-providers/openai/authorization';
type Section = 'text' | 'speech';
type Editor = { kind: 'text'; connection?: ModelConnection } | { kind: 'speech'; connection?: SpeechConnection };
function pending(value: Authorization | null | undefined) {
  return Boolean(value && ['starting', 'waiting', 'exchanging'].includes(value.status));
}

export function ModelSettings({ onModelsChanged }: { onModelsChanged: () => Promise<void> }) {
  const { settings: speech, error: speechError, refresh: refreshSpeech } = useSpeechSettings();
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [callback, setCallback] = useState('');
  const [authSection, setAuthSection] = useState<Section>('text');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [editingChatgpt, setEditingChatgpt] = useState(false);
  const [chatgptModel, setChatgptModel] = useState('');
  const popup = useRef<Window | null>(null);
  const completed = useRef<string | null>(null);
  const authorization = settings?.authorization;
  const attemptId = authorization?.id;
  const waiting = pending(authorization);
  const openai = settings?.providers.find(provider => provider.id === 'openai');
  const connected = Boolean(openai?.subscription);

  useEffect(() => { if (speech) setChatgptModel(speech.chatgpt.model); }, [speech]);
  useEffect(() => {
    if (authorization?.url && popup.current) { popup.current.location.href = authorization.url; popup.current = null; }
    else if (authorization && !pending(authorization)) { popup.current?.close(); popup.current = null; }
  }, [authorization]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await requestJson<ProviderSettings>('/api/model-providers', { signal: controller.signal });
        setSettings(next);
        if (next.authorization?.status === 'connected' && completed.current !== next.authorization.id) {
          completed.current = next.authorization.id;
          await refreshSpeech();
          await onModelsChanged();
        }
        if (pending(next.authorization)) timer = setTimeout(poll, 800);
      } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [waiting, attemptId, onModelsChanged, refreshSpeech]);
  useEffect(() => {
    if (!waiting || !attemptId) return;
    const id = attemptId;
    return () => { void requestJson(authorizationUrl, { method: 'DELETE', body: JSON.stringify({ id }) }).catch(() => undefined); };
  }, [waiting, attemptId]);

  async function act(operation: () => Promise<void>) {
    setBusy(true); setError('');
    try { await operation(); } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  function connect(section: Section) {
    setAuthSection(section); setCallback('');
    popup.current = window.open('about:blank', '_blank');
    if (popup.current) popup.current.opener = null;
    void act(async () => {
      try { const next = await requestJson<Authorization>(authorizationUrl, {
        method: 'POST', body: JSON.stringify({ id: crypto.randomUUID() }),
      }); setSettings(current => current && { ...current, authorization: next }); }
      catch (error) { popup.current?.close(); popup.current = null; throw error; }
    });
  }
  async function disconnect() {
    setSettings(await requestJson<ProviderSettings>('/api/model-providers/openai', { method: 'DELETE' }));
    await refreshSpeech(); await onModelsChanged();
  }
  async function selectSpeech(activeId: string) {
    const next = await requestJson<SpeechSettings>('/api/speech', { method: 'PATCH', body: JSON.stringify({ activeId }) });
    publishSpeechSettings(next);
  }
  async function saveText(value: ModelConnectionInput, connection?: ModelConnection) {
    const next = await requestJson<ProviderSettings>(connection ? '/api/model-providers/connections/' + connection.id : '/api/model-providers/connections', {
      method: connection ? 'PATCH' : 'POST', body: JSON.stringify(value),
    });
    setSettings(next); setEditor(null); await onModelsChanged();
  }
  async function saveSpeech(value: SpeechConnectionInput, connection?: SpeechConnection) {
    const next = await requestJson<SpeechSettings>(connection ? '/api/speech/connections/' + connection.id : '/api/speech/connections', {
      method: connection ? 'PATCH' : 'POST', body: JSON.stringify(value),
    });
    setEditor(null); publishSpeechSettings(next);
  }
  async function remove(section: Section, id: string) {
    if (section === 'text') {
      setSettings(await requestJson<ProviderSettings>('/api/model-providers/connections/' + id, { method: 'DELETE' }));
      await onModelsChanged();
    } else {
      publishSpeechSettings(await requestJson<SpeechSettings>('/api/speech/connections/' + id, { method: 'DELETE' }));
    }
    setDeleting(null);
  }
  async function testSpeech(connectionId: string) {
    setTesting(connectionId);
    try { const result = await requestJson<SpeechTestResult>('/api/speech/test', { method: 'POST', body: JSON.stringify({ connectionId }) });
      setTestResults(current => ({ ...current, [connectionId]: result })); }
    catch (error) { setTestResults(current => ({ ...current, [connectionId]: { ok: false, message: (error as Error).message } })); }
    finally { setTesting(null); }
  }
  function authPanel(section: Section) {
    if (authSection !== section) return null;
    return <>
      {waiting && <div className="provider-authorization">
        <p role="status">{authorization?.status === 'exchanging' ? '正在连接…' : '等待授权…'}</p>
        <div className="provider-actions">{authorization?.url && <a className="button secondary" href={authorization.url} target="_blank" rel="noreferrer">打开授权页面<ArrowUpRight size={14} /></a>}
          <button className="button secondary" disabled={busy} onClick={() => void act(async () => {
            const next = await requestJson<Authorization>(authorizationUrl, { method: 'DELETE', body: JSON.stringify({ id: authorization!.id }) });
            setSettings(current => current && { ...current, authorization: next }); popup.current?.close(); popup.current = null;
          })}>取消</button></div>
        {authorization?.manualInput && <details className="provider-manual"><summary>粘贴回调地址</summary>
          <form onSubmit={event => { event.preventDefault(); void act(async () => {
            const next = await requestJson<Authorization>(authorizationUrl + '/callback', { method: 'POST', body: JSON.stringify({ id: authorization!.id, url: callback }) });
            setSettings(current => current && { ...current, authorization: next }); setCallback('');
          }); }}><label className="field-label" htmlFor="chatgpt-callback">授权回调地址</label>
            <input id="chatgpt-callback" type="url" value={callback} onChange={event => setCallback(event.target.value)} required autoComplete="off" spellCheck={false} />
            <button className="button secondary" disabled={busy || !callback.trim()}>完成连接</button></form></details>}
      </div>}
      {authorization?.error && <p className="error-message" role="alert">{authorization.error}</p>}
    </>;
  }
  function chatgpt(section: Section) {
    return <div className={'connection-row' + (section === 'speech' && speech?.activeId === 'chatgpt' ? ' is-active' : '')}>
      <div className="connection-row-main">
        {section === 'speech' && <input type="radio" name="speech-source" aria-label="使用 ChatGPT 语音" checked={speech?.activeId === 'chatgpt'} disabled={busy || !connected} onChange={() => void act(() => selectSpeech('chatgpt'))} />}
        <div className="connection-row-title"><strong>ChatGPT</strong><small>{connected ? (section === 'speech' ? speech?.chatgpt.model : '已连接') : '未连接'}</small></div>
        <div className="connection-row-actions">
          <button className="text-action" disabled={busy || waiting} onClick={() => connect(section)}>{connected ? '重新连接' : '连接'}</button>
          {section === 'speech' && connected && <><button className="text-action" disabled={busy || testing !== null} onClick={() => void testSpeech('chatgpt')}>{testing === 'chatgpt' ? '测试中…' : '测试'}</button>
            <button className="icon-button" aria-label="编辑 ChatGPT 转写模型" onClick={() => setEditingChatgpt(value => !value)}><Pencil size={16} /></button></>}
          {connected && <button className="text-action danger" disabled={busy || waiting} onClick={() => void act(disconnect)}>断开</button>}
        </div>
      </div>
      {section === 'speech' && editingChatgpt && <form className="connection-inline-form" onSubmit={event => { event.preventDefault(); void act(async () => {
        const next = await requestJson<SpeechSettings>('/api/speech/chatgpt', { method: 'PATCH', body: JSON.stringify({ model: chatgptModel.trim() }) });
        setEditingChatgpt(false); publishSpeechSettings(next);
      }); }}><label className="field-label" htmlFor="chatgpt-speech-model">转写模型</label><input id="chatgpt-speech-model" value={chatgptModel} onChange={event => setChatgptModel(event.target.value)} required /><button className="button secondary" disabled={busy}>保存</button></form>}
      {section === 'speech' && testResults.chatgpt && <p className={testResults.chatgpt.ok ? 'connection-result' : 'error-message'} role="status">{testResults.chatgpt.message}</p>}
      {authPanel(section)}
    </div>;
  }
  function deleteButton(section: Section, id: string) {
    const confirming = deleting === section + ':' + id;
    return <>{confirming ? <><button className="text-action danger" disabled={busy} onClick={() => void act(() => remove(section, id))}>确认删除</button>
      <button className="text-action" onClick={() => setDeleting(null)}>取消</button></> : <button className="icon-button danger" aria-label="删除服务" disabled={busy} onClick={() => setDeleting(section + ':' + id)}><Trash2 size={16} /></button>}</>;
  }
  return <div className="model-settings">
    {error && <p className="error-message" role="alert">{error}</p>}
    {speechError && <p className="error-message" role="alert">{speechError}</p>}
    <section className="model-section" aria-labelledby="model-section-text">
      <div className="connection-section-heading"><h3 id="model-section-text">文字</h3><button className="text-action" onClick={() => setEditor({ kind: 'text' })}><Plus size={15} />添加服务</button></div>
      {!settings ? <p role="status" className="muted">正在读取…</p> : <>
        {chatgpt('text')}
        {settings.connections.map(connection => <div className="connection-row" key={connection.id}>
          <div className="connection-row-main"><div className="connection-row-title"><strong>{connection.name}</strong><small>{connection.models.length} 个模型</small></div>
            <div className="connection-row-actions"><button className="icon-button" aria-label={'编辑 ' + connection.name} disabled={busy} onClick={() => setEditor({ kind: 'text', connection })}><Pencil size={16} /></button>{deleteButton('text', connection.id)}</div>
          </div>
          <p className="connection-model-names">{connection.models.map(model => model.name).join(' · ')}</p>
        </div>)}
        {settings.providers.filter(provider => provider.id !== 'openai' && !settings.connections.some(connection => connection.id === provider.id)).map(provider => <div className="connection-row" key={provider.id}><div className="connection-row-main"><strong>{provider.name}</strong><span className="muted">已连接</span></div></div>)}
      </>}
      {editor?.kind === 'text' && <ConnectionForm key={editor.connection?.id ?? 'new-text'} kind="text" connection={editor.connection} onCancel={() => setEditor(null)} onSave={value => saveText(value, editor.connection)} />}
    </section>
    <section className="model-section" aria-labelledby="model-section-speech">
      <div className="connection-section-heading"><h3 id="model-section-speech">语音</h3><button className="text-action" onClick={() => setEditor({ kind: 'speech' })}><Plus size={15} />添加服务</button></div>
      {speech && settings && <>{chatgpt('speech')}{speech.connections.map(connection => <div className={'connection-row' + (speech.activeId === connection.id ? ' is-active' : '')} key={connection.id}>
        <div className="connection-row-main"><input type="radio" name="speech-source" aria-label={'使用 ' + connection.name} checked={speech.activeId === connection.id} disabled={busy} onChange={() => void act(() => selectSpeech(connection.id))} />
          <div className="connection-row-title"><strong>{connection.name}</strong><small>{connection.model} · {connection.protocol === 'realtime' ? '实时转写' : '录音后转写'}</small></div>
          <div className="connection-row-actions"><button className="text-action" disabled={busy || testing !== null} onClick={() => void testSpeech(connection.id)}>{testing === connection.id ? '测试中…' : '测试'}</button>
            <button className="icon-button" aria-label={'编辑 ' + connection.name} disabled={busy} onClick={() => setEditor({ kind: 'speech', connection })}><Pencil size={16} /></button>{deleteButton('speech', connection.id)}</div>
        </div>
        {testResults[connection.id] && <p className={testResults[connection.id].ok ? 'connection-result' : 'error-message'} role="status">{testResults[connection.id].message}</p>}
      </div>)}</>}
      {editor?.kind === 'speech' && <ConnectionForm key={editor.connection?.id ?? 'new-speech'} kind="speech" connection={editor.connection} onCancel={() => setEditor(null)} onSave={value => saveSpeech(value, editor.connection)} />}
    </section>
  </div>;
}

'use client';

import '../models.css';
import './ModelSettings.css';


import { useTranslations } from 'use-intl';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { publishSpeechSettings, useSpeechSettings } from '@/app/models/use-speech-settings';
import type { SpeechTestResult } from '@/app/speech/schema';
import { requestJson } from '@/shared/http/request-json';
import type { ModelConnection, ModelConnectionInput, ProviderSettings, SpeechConnection, SpeechConnectionInput, SpeechSettings } from '../schema';
import { AuthorizationForm } from './AuthorizationForm';
import { ConnectionForm } from './ConnectionForm';

type Section = 'text' | 'speech';
type Editor =
  | { kind: Section; method: 'choose' }
  | { kind: Section; method: 'authorization'; providerId?: string }
  | { kind: 'text'; method: 'api'; connection?: ModelConnection }
  | { kind: 'speech'; method: 'api'; connection?: SpeechConnection };

export function ModelSettings({ onModelsChanged }: { onModelsChanged: () => Promise<void> }) {
  const t = useTranslations();
  const { settings: speech, error: speechError, refresh: refreshSpeech } = useSpeechSettings();
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [editingChatgpt, setEditingChatgpt] = useState(false);
  const [chatgptModel, setChatgptModel] = useState('');

  useEffect(() => { if (speech) setChatgptModel(speech.chatgpt.model); }, [speech]);
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<ProviderSettings>('/api/model-providers', { signal: controller.signal })
      .then(setSettings).catch((error: Error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, []);

  const authorized = useCallback(async (next: ProviderSettings) => {
    setSettings(next);
    await refreshSpeech();
    await onModelsChanged();
    setEditor(null);
  }, [refreshSpeech, onModelsChanged]);

  async function act(operation: () => Promise<void>) {
    setBusy(true); setError('');
    try { await operation(); } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function disconnect(providerId: string) {
    setSettings(await requestJson<ProviderSettings>('/api/model-providers/' + providerId, { method: 'DELETE' }));
    setEditingChatgpt(false);
    setTestResults({});
    await refreshSpeech(); await onModelsChanged();
  }
  async function selectSpeech(activeId: string) {
    publishSpeechSettings(await requestJson<SpeechSettings>('/api/speech', { method: 'PATCH', body: JSON.stringify({ activeId }) }));
  }
  async function saveText(value: ModelConnectionInput, connection?: ModelConnection) {
    setSettings(await requestJson<ProviderSettings>(connection ? '/api/model-providers/connections/' + connection.id : '/api/model-providers/connections', {
      method: connection ? 'PATCH' : 'POST', body: JSON.stringify(value),
    }));
    setEditor(null); await onModelsChanged();
  }
  async function saveSpeech(value: SpeechConnectionInput, connection?: SpeechConnection) {
    publishSpeechSettings(await requestJson<SpeechSettings>(connection ? '/api/speech/connections/' + connection.id : '/api/speech/connections', {
      method: connection ? 'PATCH' : 'POST', body: JSON.stringify(value),
    }));
    setEditor(null);
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
    try {
      const result = await requestJson<SpeechTestResult>('/api/speech/test', { method: 'POST', body: JSON.stringify({ connectionId }) });
      setTestResults(current => ({ ...current, [connectionId]: result }));
    } catch (error) { setTestResults(current => ({ ...current, [connectionId]: { ok: false, message: (error as Error).message } })); }
    finally { setTesting(null); }
  }
  function deleteButton(section: Section, id: string) {
    const confirming = deleting === section + ':' + id;
    return confirming ? <>
      <button className="text-action danger" disabled={busy} onClick={() => void act(() => remove(section, id))}>{t('models.confirmDelete')}</button>
      <button className="text-action" onClick={() => setDeleting(null)}>{t('common.cancel')}</button>
    </> : <button className="icon-button danger" aria-label={t('models.deleteConnection')} disabled={busy} onClick={() => setDeleting(section + ':' + id)}><Trash2 size={16} /></button>;
  }
  function connectionEditor(section: Section) {
    if (!settings || editor?.kind !== section) return null;
    if (editor.method === 'choose') return <div className="connection-form">
      <div className="connection-form-heading"><strong>{t('models.addConnection')}</strong>
        <button className="icon-button" aria-label={t('common.close')} onClick={() => setEditor(null)}><X size={17} /></button>
      </div>
      <div className="connection-methods">
        <button className="button secondary" onClick={() => setEditor({ kind: section, method: 'api' })}>{t('models.apiConnection')}</button>
        <button className="button secondary" onClick={() => setEditor({ kind: section, method: 'authorization' })}>{t('models.addAuthorization')}</button>
      </div>
    </div>;
    if (editor.method === 'authorization') return <AuthorizationForm
      providers={settings.authorizationProviders} initialProviderId={editor.providerId}
      initialAuthorization={settings.authorization} onConnected={authorized} onCancel={() => setEditor(null)} />;
    return editor.kind === 'text'
      ? <ConnectionForm key={editor.connection?.id ?? 'new-text'} kind="text" connection={editor.connection} onCancel={() => setEditor(null)} onSave={value => saveText(value, editor.connection)} />
      : <ConnectionForm key={editor.connection?.id ?? 'new-speech'} kind="speech" connection={editor.connection} onCancel={() => setEditor(null)} onSave={value => saveSpeech(value, editor.connection)} />;
  }
  function authorizationActions(providerId: string, section: Section) {
    return <>
      <button className="text-action" disabled={busy} onClick={() => setEditor({ kind: section, method: 'authorization', providerId })}>{t('common.reconnect')}</button>
      <button className="text-action danger" disabled={busy} onClick={() => void act(() => disconnect(providerId))}>{t('common.disconnect')}</button>
    </>;
  }

  return <div className="model-settings">
    {error && <p className="error-message" role="alert">{error}</p>}
    {speechError && <p className="error-message" role="alert">{speechError}</p>}
    <section className="model-section" aria-labelledby="model-section-text">
      <div className="connection-section-heading"><h3 id="model-section-text">{t('models.text')}</h3>
        <button className="text-action" disabled={!settings || busy} onClick={() => setEditor({ kind: 'text', method: 'choose' })}><Plus size={15} />{t('models.addConnection')}</button>
      </div>
      {!settings ? <p role="status" className="muted">{t('common.loading')}</p> : <>
        {settings.providers.filter(provider => !settings.connections.some(connection => connection.id === provider.id)).map(provider => <div className="connection-row" key={provider.id}>
          <div className="connection-row-main">
            <div className="connection-row-title"><strong>{(provider.subscription && settings.authorizationProviders.find(item => item.id === provider.id)?.name) || provider.name}</strong></div>
            {provider.canDisconnect && <div className="connection-row-actions">{authorizationActions(provider.id, 'text')}</div>}
          </div>
        </div>)}
        {settings.connections.map(connection => <div className="connection-row" key={connection.id}>
          <div className="connection-row-main"><div className="connection-row-title"><strong>{connection.name}</strong></div>
            <div className="connection-row-actions">
              <button className="icon-button" aria-label={t('common.editItem', { value0: connection.name })} disabled={busy} onClick={() => setEditor({ kind: 'text', method: 'api', connection })}><Pencil size={16} /></button>
              {deleteButton('text', connection.id)}
            </div>
          </div>
          <p className="connection-model-names">{connection.models.map(model => model.name).join(' · ')}</p>
        </div>)}
        {!settings.providers.length && !settings.connections.length && <p className="connection-empty">{t('models.noConnections')}</p>}
      </>}
      {connectionEditor('text')}
    </section>
    <section className="model-section" aria-labelledby="model-section-speech">
      <div className="connection-section-heading"><h3 id="model-section-speech">{t('speech.title')}</h3>
        <button className="text-action" disabled={!settings || busy} onClick={() => setEditor({ kind: 'speech', method: 'choose' })}><Plus size={15} />{t('models.addConnection')}</button>
      </div>
      {!speech ? <p role="status" className="muted">{t('common.loading')}</p> : <>
        {speech.chatgpt.connected && <div className={'connection-row' + (speech.activeId === 'chatgpt' ? ' is-active' : '')}>
          <div className="connection-row-main">
            <label className="connection-source"><input type="radio" name="speech-source" aria-label={t('speech.useChatgpt')} checked={speech.activeId === 'chatgpt'} disabled={busy} onChange={() => void act(() => selectSpeech('chatgpt'))} />
              <span className="connection-row-title"><strong>ChatGPT</strong><small>{speech.chatgpt.model}</small></span>
            </label>
            <div className="connection-row-actions">
              <button className="text-action" disabled={busy || testing !== null} onClick={() => void testSpeech('chatgpt')}>{testing === 'chatgpt' ? t('models.testing') : t('models.test')}</button>
              <button className="icon-button" aria-label={t('speech.editChatgptModel')} onClick={() => setEditingChatgpt(value => !value)}><Pencil size={16} /></button>
              {authorizationActions('openai', 'speech')}
            </div>
          </div>
          {editingChatgpt && <form className="connection-inline-form" onSubmit={event => { event.preventDefault(); void act(async () => {
            publishSpeechSettings(await requestJson<SpeechSettings>('/api/speech/chatgpt', { method: 'PATCH', body: JSON.stringify({ model: chatgptModel.trim() }) }));
            setEditingChatgpt(false);
          }); }}>
            <label className="field-label" htmlFor="chatgpt-speech-model">{t('speech.model')}</label>
            <input id="chatgpt-speech-model" value={chatgptModel} onChange={event => setChatgptModel(event.target.value)} required />
            <button className="button secondary" disabled={busy}>{t('common.save')}</button>
          </form>}
          {testResults.chatgpt && <p className={testResults.chatgpt.ok ? 'connection-result' : 'error-message'} role="status">{testResults.chatgpt.message}</p>}
        </div>}
        {speech.connections.map(connection => <div className={'connection-row' + (speech.activeId === connection.id ? ' is-active' : '')} key={connection.id}>
          <div className="connection-row-main">
            <label className="connection-source"><input type="radio" name="speech-source" aria-label={t('common.useItem', { value0: connection.name })} checked={speech.activeId === connection.id} disabled={busy} onChange={() => void act(() => selectSpeech(connection.id))} />
              <span className="connection-row-title"><strong>{connection.name}</strong><small>{connection.model} · {connection.protocol === 'realtime' ? t('speech.realtime') : t('speech.file')}</small></span>
            </label>
            <div className="connection-row-actions">
              <button className="text-action" disabled={busy || testing !== null} onClick={() => void testSpeech(connection.id)}>{testing === connection.id ? t('models.testing') : t('models.test')}</button>
              <button className="icon-button" aria-label={t('common.editItem', { value0: connection.name })} disabled={busy} onClick={() => setEditor({ kind: 'speech', method: 'api', connection })}><Pencil size={16} /></button>
              {deleteButton('speech', connection.id)}
            </div>
          </div>
          {testResults[connection.id] && <p className={testResults[connection.id].ok ? 'connection-result' : 'error-message'} role="status">{testResults[connection.id].message}</p>}
        </div>)}
        {!speech.chatgpt.connected && !speech.connections.length && <p className="connection-empty">{t('models.noConnections')}</p>}
      </>}
      {connectionEditor('speech')}
    </section>
  </div>;
}

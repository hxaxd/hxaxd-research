'use client';

import { useFormatter, useTranslations } from 'use-intl';

import { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { ChoiceSelect } from '@/shared/ui/ChoiceSelect';
import { requestJson } from '@/shared/http/request-json';
import type { DiscoveredModel, ModelConnection, ModelConnectionInput, SpeechConnection, SpeechConnectionInput, SpeechProtocol } from '../schema';

type Props = { onCancel: () => void } & (
  | { kind: 'text'; connection?: ModelConnection; onSave: (value: ModelConnectionInput) => Promise<void> }
  | { kind: 'speech'; connection?: SpeechConnection; onSave: (value: SpeechConnectionInput) => Promise<void> }
);

export function ConnectionForm(props: Props) {
  const t = useTranslations();
  const format = useFormatter();
  const apis = [
    { id: 'openai-completions', name: t('models.openaiCompatible') }, { id: 'openai-responses', name: 'OpenAI Responses' },
    { id: 'anthropic-messages', name: 'Anthropic' }, { id: 'google-generative-ai', name: 'Gemini' },
  ];
  const prefix = useId();
  const [name, setName] = useState(props.connection?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(props.connection?.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [api, setApi] = useState(props.kind === 'text' ? props.connection?.api ?? 'openai-completions' : 'openai-completions');
  const [protocol, setProtocol] = useState<SpeechProtocol>(props.kind === 'speech' ? props.connection?.protocol ?? 'realtime' : 'realtime');
  const [models, setModels] = useState<DiscoveredModel[]>(props.kind === 'text' ? props.connection?.models ?? [] : []);
  const [model, setModel] = useState(props.kind === 'speech' ? props.connection?.model ?? '' : '');
  const [available, setAvailable] = useState<DiscoveredModel[]>([]);
  const [manualId, setManualId] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function discover() {
    setLoading(true);
    setError('');
    try {
      const result = await requestJson<{ models: DiscoveredModel[] }>('/api/model-providers/discover', {
        method: 'POST', body: JSON.stringify({ baseUrl: baseUrl.trim(), key, clearKey, api,
          ...(props.kind === 'text' && props.connection ? { connectionId: props.connection.id } : {}),
          ...(props.kind === 'speech' && props.connection ? { speechConnectionId: props.connection.id } : {}) }),
      });
      setAvailable(result.models);
      if (!result.models.length) setError(t('models.discoveryEmpty'));
    } catch (error) { setError((error as Error).message); }
    finally { setLoading(false); }
  }

  function select(item: DiscoveredModel) {
    if (props.kind === 'speech') setModel(item.id);
    else setModels(current => current.some(model => model.id === item.id)
      ? current.filter(model => model.id !== item.id) : [...current, item]);
  }

  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const common = { name: name.trim() || new URL(baseUrl).hostname, baseUrl: baseUrl.trim(), key, clearKey };
      if (props.kind === 'text') await props.onSave({ ...common, api: api as ModelConnectionInput['api'], models: models.map(item => ({ id: item.id, reset: true,
        ...(item.customized ? { contextWindow: item.contextWindow, maxTokens: item.maxTokens, vision: item.vision, reasoning: item.reasoning } : {}),
      })) });
      else await props.onSave({ ...common, protocol, model: model.trim() });
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <form className="connection-form" onSubmit={save}>
      <div className="connection-form-heading"><strong>{props.connection ? t('models.editConnection') : t('models.addConnection')}</strong>
        <button type="button" className="icon-button" aria-label={t('models.cancelEdit')} onClick={props.onCancel} disabled={busy}><X size={17} /></button>
      </div>
      <label className="field-label" htmlFor={`${prefix}-url`}>{t('models.baseUrl')}</label>
      <input id={`${prefix}-url`} type="url" value={baseUrl} required placeholder="https://api.example.com/v1" spellCheck={false}
        onChange={event => { setBaseUrl(event.target.value); setAvailable([]); }} />
      <label className="field-label" htmlFor={`${prefix}-key`}>{t('models.apiKey')}</label>
      <input id={`${prefix}-key`} type="password" value={key} autoComplete="off"
        placeholder={props.connection ? t('models.keepKey') : t('models.optionalKey')} onChange={event => setKey(event.target.value)} />
      {props.kind === 'speech' && <div className="preview-modes" role="group" aria-label={t('speech.protocol')}>
        <button type="button" aria-pressed={protocol === 'realtime'} onClick={() => setProtocol('realtime')}>{t('speech.realtime')}</button>
        <button type="button" aria-pressed={protocol === 'file'} onClick={() => setProtocol('file')}>{t('speech.file')}</button>
      </div>}
      <div className="connection-model-heading"><label className="field-label" htmlFor={`${prefix}-model`}>{t('models.model')}</label>
        <button type="button" className="text-action" disabled={loading || !baseUrl.trim()} onClick={() => void discover()}>
          {loading ? t('common.loading') : t('models.discover')}</button>
      </div>
      {props.kind === 'speech' ? <input id={`${prefix}-model`} value={model} list={`${prefix}-models`} required placeholder={t('models.modelId')} spellCheck={false}
        onChange={event => setModel(event.target.value)} /> : <div className="connection-model-add">
        <input id={`${prefix}-model`} value={manualId} list={`${prefix}-models`} placeholder={t('models.modelId')} spellCheck={false}
          onChange={event => setManualId(event.target.value)} />
        <button type="button" className="icon-button" aria-label={t('models.addModel')} disabled={!manualId.trim()}
          onClick={() => { const id = manualId.trim(); if (!models.some(model => model.id === id))
            setModels(current => [...current, available.find(model => model.id === id) ?? { id, name: id, recognized: false }]); setManualId(''); }}><Plus size={17} /></button>
      </div>}
      <datalist id={`${prefix}-models`}>{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>
      {available.length > 0 && <div className="connection-model-list" role="group" aria-label={t('models.available')}>
        {available.map(item => <button type="button" key={item.id} className="connection-model-option"
          aria-pressed={props.kind === 'text' ? models.some(model => model.id === item.id) : model === item.id} onClick={() => select(item)}>
          <span>{item.name}</span><small>{item.recognized ? t('models.summary', {value0: item.contextWindow === undefined ? '—' : format.number(item.contextWindow), value1: item.vision ? t('models.imageSuffix') : '', value2: item.reasoning ? t('models.reasoningSuffix') : ''}) : item.id}</small>
        </button>)}
      </div>}
      {props.kind === 'text' && models.map(item => <div className="connection-chosen-model" key={item.id}>
        <div><strong>{item.id}</strong><button type="button" className="icon-button" aria-label={t('common.removeItem', {value0: item.id})}
          onClick={() => setModels(current => current.filter(model => model.id !== item.id))}><X size={14} /></button></div>
        <details><summary>{item.customized ? t('models.customized') : item.recognized ? t('models.editCapabilities') : t('models.addCapabilities')}</summary>
          <div className="connection-model-parameters">
            <label>{t('models.contextWindow')}<input type="number" min="1" value={item.contextWindow ?? ''} placeholder={t('models.defaultValue')}
              onChange={event => setModels(current => current.map(model => model.id === item.id ? { ...model, customized: true, contextWindow: event.target.value ? Number(event.target.value) : undefined } : model))} /></label>
            <label>{t('models.outputLimit')}<input type="number" min="1" value={item.maxTokens ?? ''} placeholder={t('models.defaultValue')}
              onChange={event => setModels(current => current.map(model => model.id === item.id ? { ...model, customized: true, maxTokens: event.target.value ? Number(event.target.value) : undefined } : model))} /></label>
            {(['vision', 'reasoning'] as const).map(capability => <label key={capability}>{capability === 'vision' ? t('models.vision') : t('models.reasoning')}
              <ChoiceSelect label={capability === 'vision' ? t('models.vision') : t('models.reasoning')}
                value={item[capability] === undefined ? 'auto' : String(item[capability])}
                items={[{ id: 'auto', name: t('common.auto') }, { id: 'true', name: t('common.supported') }, { id: 'false', name: t('common.unsupported') }]}
                onChange={value => setModels(current => current.map(model => model.id === item.id
                  ? { ...model, customized: true, [capability]: value === 'auto' ? undefined : value === 'true' } : model))} />
            </label>)}
            <button type="button" className="text-action" onClick={() => setModels(current => current.map(model => model.id === item.id
              ? { ...model, contextWindow: undefined, maxTokens: undefined, vision: undefined, reasoning: undefined, ...model.automatic, customized: false } : model))}>{t('models.resetCapabilities')}</button>
          </div>
        </details>
      </div>)}
      <details className="connection-options"><summary>{t('models.connectionOptions')}</summary>
        <label className="field-label" htmlFor={`${prefix}-name`}>{t('common.name')}</label>
        <input id={`${prefix}-name`} value={name} maxLength={160} placeholder={t('models.nameDefault')} onChange={event => setName(event.target.value)} />
        {props.kind === 'text' && <><label className="field-label">{t('models.api')}</label><ChoiceSelect label={t('models.api')} value={api} items={apis} onChange={setApi} /></>}
        {props.connection && <label className="connection-check"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />{t('models.clearKey')}</label>}
      </details>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="connection-form-actions"><button className="button primary" disabled={busy || (props.kind === 'text' && !models.length)}>{busy ? t('common.saving') : t('common.save')}</button>
        <button type="button" className="button secondary" disabled={busy} onClick={props.onCancel}>{t('common.cancel')}</button></div>
    </form>
  );
}

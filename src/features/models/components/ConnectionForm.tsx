'use client';

import { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { ChoiceSelect } from '@/shared/ui/ChoiceSelect';
import { requestJson } from '@/shared/http/request-json';
import type { DiscoveredModel, ModelConnection, ModelConnectionInput, SpeechConnection, SpeechConnectionInput, SpeechProtocol } from '../schema';

type Props = { onCancel: () => void } & (
  | { kind: 'text'; connection?: ModelConnection; onSave: (value: ModelConnectionInput) => Promise<void> }
  | { kind: 'speech'; connection?: SpeechConnection; onSave: (value: SpeechConnectionInput) => Promise<void> }
);

const apis = [
  { id: 'openai-completions', name: 'OpenAI 兼容' }, { id: 'openai-responses', name: 'OpenAI Responses' },
  { id: 'anthropic-messages', name: 'Anthropic' }, { id: 'google-generative-ai', name: 'Gemini' },
];

export function ConnectionForm(props: Props) {
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
      if (!result.models.length) setError('没有返回模型，请直接填写模型 ID');
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
      <div className="connection-form-heading"><strong>{props.connection ? '编辑服务' : '添加服务'}</strong>
        <button type="button" className="icon-button" aria-label="取消编辑" onClick={props.onCancel} disabled={busy}><X size={17} /></button>
      </div>
      <label className="field-label" htmlFor={`${prefix}-url`}>服务地址</label>
      <input id={`${prefix}-url`} type="url" value={baseUrl} required placeholder="https://api.example.com/v1" spellCheck={false}
        onChange={event => { setBaseUrl(event.target.value); setAvailable([]); }} />
      <label className="field-label" htmlFor={`${prefix}-key`}>API 密钥</label>
      <input id={`${prefix}-key`} type="password" value={key} autoComplete="off"
        placeholder={props.connection ? '留空保留已保存的密钥' : '本地服务可留空'} onChange={event => setKey(event.target.value)} />
      {props.kind === 'speech' && <div className="preview-modes" role="group" aria-label="转写方式">
        <button type="button" aria-pressed={protocol === 'realtime'} onClick={() => setProtocol('realtime')}>实时转写</button>
        <button type="button" aria-pressed={protocol === 'file'} onClick={() => setProtocol('file')}>录音后转写</button>
      </div>}
      <div className="connection-model-heading"><label className="field-label" htmlFor={`${prefix}-model`}>模型</label>
        <button type="button" className="text-action" disabled={loading || !baseUrl.trim()} onClick={() => void discover()}>
          {loading ? '读取中…' : '读取模型'}</button>
      </div>
      {props.kind === 'speech' ? <input id={`${prefix}-model`} value={model} list={`${prefix}-models`} required placeholder="模型 ID" spellCheck={false}
        onChange={event => setModel(event.target.value)} /> : <div className="connection-model-add">
        <input id={`${prefix}-model`} value={manualId} list={`${prefix}-models`} placeholder="输入模型 ID" spellCheck={false}
          onChange={event => setManualId(event.target.value)} />
        <button type="button" className="icon-button" aria-label="添加模型" disabled={!manualId.trim()}
          onClick={() => { const id = manualId.trim(); if (!models.some(model => model.id === id))
            setModels(current => [...current, available.find(model => model.id === id) ?? { id, name: id, recognized: false }]); setManualId(''); }}><Plus size={17} /></button>
      </div>}
      <datalist id={`${prefix}-models`}>{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>
      {available.length > 0 && <div className="connection-model-list" role="group" aria-label="可用模型">
        {available.map(item => <button type="button" key={item.id} className="connection-model-option"
          aria-pressed={props.kind === 'text' ? models.some(model => model.id === item.id) : model === item.id} onClick={() => select(item)}>
          <span>{item.name}</span><small>{item.recognized ? `${item.contextWindow?.toLocaleString()} 上下文${item.vision ? ' · 图片' : ''}${item.reasoning ? ' · 推理' : ''}` : item.id}</small>
        </button>)}
      </div>}
      {props.kind === 'text' && models.map(item => <div className="connection-chosen-model" key={item.id}>
        <div><strong>{item.id}</strong><button type="button" className="icon-button" aria-label={`移除 ${item.id}`}
          onClick={() => setModels(current => current.filter(model => model.id !== item.id))}><X size={14} /></button></div>
        <details><summary>{item.customized ? '已修正模型信息' : item.recognized ? '修正模型信息' : '补充模型信息'}</summary>
          <div className="connection-model-parameters">
            <label>上下文窗口<input type="number" min="1" value={item.contextWindow ?? ''} placeholder="使用默认值"
              onChange={event => setModels(current => current.map(model => model.id === item.id ? { ...model, customized: true, contextWindow: event.target.value ? Number(event.target.value) : undefined } : model))} /></label>
            <label>模型输出上限<input type="number" min="1" value={item.maxTokens ?? ''} placeholder="使用默认值"
              onChange={event => setModels(current => current.map(model => model.id === item.id ? { ...model, customized: true, maxTokens: event.target.value ? Number(event.target.value) : undefined } : model))} /></label>
            {(['vision', 'reasoning'] as const).map(capability => <label key={capability}>{capability === 'vision' ? '图片输入' : '推理能力'}
              <ChoiceSelect label={capability === 'vision' ? '图片输入' : '推理能力'}
                value={item[capability] === undefined ? 'auto' : String(item[capability])}
                items={[{ id: 'auto', name: '自动' }, { id: 'true', name: '支持' }, { id: 'false', name: '不支持' }]}
                onChange={value => setModels(current => current.map(model => model.id === item.id
                  ? { ...model, customized: true, [capability]: value === 'auto' ? undefined : value === 'true' } : model))} />
            </label>)}
            <button type="button" className="text-action" onClick={() => setModels(current => current.map(model => model.id === item.id
              ? { ...model, contextWindow: undefined, maxTokens: undefined, vision: undefined, reasoning: undefined, ...model.automatic, customized: false } : model))}>恢复自动</button>
          </div>
        </details>
      </div>)}
      <details className="connection-options"><summary>连接选项</summary>
        <label className="field-label" htmlFor={`${prefix}-name`}>名称</label>
        <input id={`${prefix}-name`} value={name} maxLength={160} placeholder="默认使用服务地址" onChange={event => setName(event.target.value)} />
        {props.kind === 'text' && <><label className="field-label">接口类型</label><ChoiceSelect label="接口类型" value={api} items={apis} onChange={setApi} /></>}
        {props.connection && <label className="connection-check"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />清除已保存的密钥</label>}
      </details>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="connection-form-actions"><button className="button primary" disabled={busy || (props.kind === 'text' && !models.length)}>{busy ? '保存中…' : '保存'}</button>
        <button type="button" className="button secondary" disabled={busy} onClick={props.onCancel}>取消</button></div>
    </form>
  );
}

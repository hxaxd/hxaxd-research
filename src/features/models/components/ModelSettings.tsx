'use client';

import { ArrowUpRight, Check, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { notifySpeechChanged, useSpeechSettings } from '@/features/speech/use-speech-settings';
import type {
  SpeechConnection,
  SpeechProtocol,
  SpeechSettings,
  SpeechTestResult,
} from '@/features/speech/schema';
import { requestJson } from '@/shared/http/request-json';

import type { Authorization, ProviderSettings } from '../schema';

const authorizationUrl = '/api/model-providers/openai/authorization';

const protocolNames: Record<SpeechProtocol, string> = {
  realtime: '实时转写',
  file: '结束后转写',
};

function pending(authorization: Authorization | null | undefined) {
  return (
    authorization &&
    ['starting', 'waiting', 'exchanging'].includes(authorization.status)
  );
}

type SpeechForm = {
  id: string | null;
  name: string;
  protocol: SpeechProtocol;
  baseUrl: string;
  model: string;
  key: string;
  clearKey: boolean;
};

function emptySpeechForm(): SpeechForm {
  return {
    id: null,
    name: '',
    protocol: 'realtime',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-live-transcribe',
    key: '',
    clearKey: false,
  };
}

function editSpeechForm(connection: SpeechConnection): SpeechForm {
  return {
    id: connection.id,
    name: connection.name,
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    model: connection.model,
    key: '',
    clearKey: false,
  };
}

export function ModelSettings({
  onModelsChanged,
}: {
  onModelsChanged: () => Promise<void>;
}) {
  const { settings: speech, error: speechError, refresh: refreshSpeech } =
    useSpeechSettings();
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [callback, setCallback] = useState('');
  const [form, setForm] = useState<SpeechForm | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [tests, setTests] = useState<
    Record<string, { tone: 'ok' | 'error'; message: string }>
  >({});
  const [chatgptModel, setChatgptModel] = useState('');
  const popup = useRef<Window | null>(null);
  const completed = useRef<string | null>(null);
  const pendingId = useRef<string | null>(null);
  const authorization = settings?.authorization;
  const waiting = Boolean(pending(authorization));
  const attemptId = authorization?.id;

  useEffect(() => {
    if (speech) setChatgptModel(speech.chatgpt.model);
  }, [speech]);

  useEffect(() => {
    if (authorization?.url && popup.current) {
      popup.current.location.href = authorization.url;
      popup.current = null;
    } else if (authorization && !pending(authorization)) {
      popup.current?.close();
      popup.current = null;
    }
  }, [authorization]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await requestJson<ProviderSettings>('/api/model-providers', {
          signal: controller.signal,
        });
        setSettings(next);
        if (
          next.authorization?.status === 'connected' &&
          completed.current !== next.authorization.id
        ) {
          completed.current = next.authorization.id;
          notifySpeechChanged();
          await onModelsChanged();
        }
        if (pending(next.authorization)) timer = setTimeout(poll, 800);
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [waiting, attemptId, onModelsChanged]);

  useEffect(() => {
    pendingId.current = waiting ? (authorization?.id ?? null) : null;
    return () => {
      const id = pendingId.current;
      if (!id) return;
      void requestJson<Authorization>(authorizationUrl, {
        method: 'DELETE',
        body: JSON.stringify({ id }),
      }).catch(() => undefined);
    };
  }, [waiting, authorization?.id]);

  async function act(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const next = await requestJson<Authorization>(authorizationUrl, {
      method: 'DELETE',
      body: JSON.stringify({ id: authorization!.id }),
    });
    setSettings((current) => current && { ...current, authorization: next });
    popup.current?.close();
    popup.current = null;
  }

  function connect() {
    popup.current = window.open('about:blank', '_blank');
    if (popup.current) popup.current.opener = null;
    setCallback('');
    void act(async () => {
      try {
        const next = await requestJson<Authorization>(authorizationUrl, {
          method: 'POST',
          body: JSON.stringify({ id: crypto.randomUUID() }),
        });
        setSettings((current) => current && { ...current, authorization: next });
      } catch (error) {
        popup.current?.close();
        popup.current = null;
        throw error;
      }
    });
  }

  async function submitCallback() {
    const next = await requestJson<Authorization>(
      `${authorizationUrl}/callback`,
      {
        method: 'POST',
        body: JSON.stringify({ id: authorization!.id, url: callback }),
      },
    );
    setCallback('');
    setSettings((current) => current && { ...current, authorization: next });
  }

  async function disconnect() {
    const next = await requestJson<ProviderSettings>(
      '/api/model-providers/openai',
      { method: 'DELETE' },
    );
    setSettings(next);
    notifySpeechChanged();
    await onModelsChanged();
  }

  async function selectSpeech(activeId: string) {
    await act(async () => {
      await requestJson<SpeechSettings>('/api/speech', {
        method: 'PATCH',
        body: JSON.stringify({ activeId }),
      });
      notifySpeechChanged();
      await refreshSpeech();
    });
  }

  async function saveSpeech() {
    if (!form) return;
    await act(async () => {
      const body = {
        name: form.name.trim(),
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        ...(form.key.trim() ? { key: form.key.trim() } : {}),
        ...(form.clearKey ? { clearKey: true } : {}),
      };
      if (form.id) {
        await requestJson<SpeechSettings>(
          `/api/speech/connections/${form.id}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
      } else {
        await requestJson<SpeechSettings>('/api/speech/connections', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      setForm(null);
      notifySpeechChanged();
      await refreshSpeech();
    });
  }

  async function removeSpeech(id: string) {
    await act(async () => {
      await requestJson<SpeechSettings>(`/api/speech/connections/${id}`, {
        method: 'DELETE',
      });
      if (form?.id === id) setForm(null);
      setDeleting(null);
      notifySpeechChanged();
      await refreshSpeech();
    });
  }

  async function saveChatgptModel() {
    await act(async () => {
      await requestJson<SpeechSettings>('/api/speech/chatgpt', {
        method: 'PATCH',
        body: JSON.stringify({ model: chatgptModel.trim() }),
      });
      notifySpeechChanged();
      await refreshSpeech();
    });
  }

  async function testSpeech(connectionId: string) {
    setTesting(connectionId);
    setTests((current) => ({
      ...current,
      [connectionId]: { tone: 'ok', message: '正在测试…' },
    }));
    try {
      const result = await requestJson<SpeechTestResult>('/api/speech/test', {
        method: 'POST',
        body: JSON.stringify({ connectionId }),
      });
      setTests((current) => ({
        ...current,
        [connectionId]: { tone: 'ok', message: result.message },
      }));
    } catch (error) {
      setTests((current) => ({
        ...current,
        [connectionId]: { tone: 'error', message: (error as Error).message },
      }));
    } finally {
      setTesting(null);
    }
  }

  const openai = settings?.providers.find(
    (provider) => provider.id === 'openai',
  );
  const chatgptTest = tests.chatgpt;

  return (
    <div className="model-settings">
      {speechError && !speech && (
        <p className="error-message" role="alert">
          {speechError}
        </p>
      )}
      <section className="model-section" aria-labelledby="model-section-chat">
        <div className="model-section-heading">
          <h3 id="model-section-chat">对话模型</h3>
          <p>连接模型服务，供工作区中的对话使用。</p>
        </div>
        {!settings && !error && (
          <p role="status" className="provider-note">
            正在读取连接…
          </p>
        )}
        {settings && (
          <>
            <div className="provider-card" id="openai-provider">
              <div className="provider-heading">
                <div>
                  <h3>OpenAI</h3>
                  <p>ChatGPT 订阅</p>
                </div>
                <span
                  className={`provider-state${openai?.subscription ? ' is-connected' : ''}`}
                >
                  {openai?.subscription && <Check size={13} />}
                  {openai?.subscription
                    ? '已连接 ChatGPT'
                    : openai?.connected
                      ? '已配置接口密钥'
                      : '未连接'}
                </span>
              </div>
              <p className="provider-note">
                通过浏览器授权使用符合条件的 ChatGPT 订阅额度。
              </p>
              {waiting ? (
                <div className="provider-authorization">
                  <p role="status">
                    {authorization?.status === 'exchanging'
                      ? '正在完成连接…'
                      : '等待在浏览器中完成授权…'}
                  </p>
                  <div className="provider-actions">
                    {authorization?.url && (
                      <a
                        className="button secondary"
                        href={authorization.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        打开授权页面
                        <ArrowUpRight size={14} />
                      </a>
                    )}
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void act(cancel)}
                    >
                      取消授权
                    </button>
                  </div>
                  {authorization?.manualInput && (
                    <details className="provider-manual">
                      <summary>授权完成后没有返回？</summary>
                      <p>
                        复制浏览器最后跳转的完整地址，粘贴到下方继续连接。地址以
                        http://127.0.0.1 开头，包含 /auth/callback。
                      </p>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          void act(submitCallback);
                        }}
                      >
                        <label className="field-label" htmlFor="chatgpt-callback">
                          授权回调地址
                        </label>
                        <input
                          id="chatgpt-callback"
                          type="url"
                          value={callback}
                          onChange={(event) => setCallback(event.target.value)}
                          maxLength={16384}
                          autoComplete="off"
                          spellCheck={false}
                          required
                        />
                        <button
                          className="button secondary"
                          disabled={busy || !callback.trim()}
                        >
                          完成连接
                        </button>
                      </form>
                    </details>
                  )}
                </div>
              ) : (
                <div className="provider-actions">
                  <button
                    className="button primary"
                    onClick={connect}
                    disabled={busy}
                  >
                    {openai?.subscription ? '重新连接 ChatGPT' : '用 ChatGPT 登录'}
                    <ArrowUpRight size={14} />
                  </button>
                  {openai?.canDisconnect && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void act(disconnect)}
                    >
                      断开连接
                    </button>
                  )}
                </div>
              )}
              {authorization?.status === 'cancelled' && (
                <p className="provider-note" role="status">
                  已取消授权
                </p>
              )}
              {authorization?.error && (
                <p className="error-message" role="alert">
                  连接失败：{authorization.error}
                </p>
              )}
            </div>
            {settings.providers
              .filter((provider) => provider.id !== 'openai')
              .map((provider) => (
                <div className="configured-provider" key={provider.id}>
                  <span>{provider.name}</span>
                  <span className="provider-state is-connected">
                    {provider.subscription ? '已连接订阅' : '已配置'}
                  </span>
                </div>
              ))}
            <div className="provider-footer model-actions">
              <button
                className="button secondary"
                disabled={busy || waiting}
                onClick={() => void act(onModelsChanged)}
              >
                刷新模型
              </button>
            </div>
          </>
        )}
      </section>

      <section className="model-section" aria-labelledby="model-section-speech">
        <div className="model-section-heading">
          <h3 id="model-section-speech">语音输入</h3>
          <p>把说话转成可编辑的草稿；只插入文字，不自动发送。</p>
        </div>
        {!speech ? (
          !speechError && (
            <p role="status" className="provider-note">
              正在读取语音设置…
            </p>
          )
        ) : (
          <>
            <div
              className={`speech-card${speech.activeId === 'chatgpt' ? ' is-active' : ''}`}
            >
              <label className="speech-select">
                <input
                  type="radio"
                  name="speech-active"
                  value="chatgpt"
                  checked={speech.activeId === 'chatgpt'}
                  onChange={() => void selectSpeech('chatgpt')}
                  disabled={busy}
                />
                <span>
                  <strong>ChatGPT 授权</strong>
                  <small>
                    {speech.chatgpt.connected
                      ? `实时转写 · ${speech.chatgpt.model}`
                      : '尚未连接 ChatGPT 授权'}
                  </small>
                </span>
              </label>
              <div className="speech-actions">
                {!speech.chatgpt.connected && (
                  <button
                    className="text-action"
                    onClick={() =>
                      document
                        .getElementById('openai-provider')
                        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    }
                  >
                    连接 ChatGPT
                  </button>
                )}
                <button
                  className="text-action"
                  disabled={busy || testing === 'chatgpt' || !speech.chatgpt.connected}
                  onClick={() => void testSpeech('chatgpt')}
                >
                  {testing === 'chatgpt' ? '测试中…' : '测试'}
                </button>
              </div>
              <div className="speech-model">
                <label className="field-label" htmlFor="chatgpt-speech-model">
                  转写模型
                </label>
                <input
                  id="chatgpt-speech-model"
                  value={chatgptModel}
                  maxLength={200}
                  onChange={(event) => setChatgptModel(event.target.value)}
                  spellCheck={false}
                />
                <button
                  className="button secondary"
                  disabled={
                    busy ||
                    !chatgptModel.trim() ||
                    chatgptModel.trim() === speech.chatgpt.model
                  }
                  onClick={() => void saveChatgptModel()}
                >
                  保存模型
                </button>
              </div>
              {chatgptTest && (
                <p
                  className={`speech-test ${chatgptTest.tone}`}
                  role={chatgptTest.tone === 'error' ? 'alert' : 'status'}
                >
                  {chatgptTest.message}
                </p>
              )}
            </div>

            {speech.connections.map((connection) => (
              <div
                className={`speech-card${speech.activeId === connection.id ? ' is-active' : ''}`}
                key={connection.id}
              >
                <label className="speech-select">
                  <input
                    type="radio"
                    name="speech-active"
                    value={connection.id}
                    checked={speech.activeId === connection.id}
                    onChange={() => void selectSpeech(connection.id)}
                    disabled={busy}
                  />
                  <span>
                    <strong>{connection.name}</strong>
                    <small>
                      {protocolNames[connection.protocol]} · {connection.model}
                    </small>
                    <small className="speech-address">
                      {connection.baseUrl} · {connection.hasKey ? '已保存密钥' : '无密钥'}
                    </small>
                  </span>
                </label>
                <div className="speech-actions">
                  <button
                    className="text-action"
                    disabled={busy || testing === connection.id}
                    onClick={() => void testSpeech(connection.id)}
                  >
                    {testing === connection.id ? '测试中…' : '测试'}
                  </button>
                  <button
                    className="text-action"
                    disabled={busy}
                    onClick={() => {
                      setForm(editSpeechForm(connection));
                      setDeleting(null);
                    }}
                  >
                    编辑
                  </button>
                  {deleting === connection.id ? (
                    <>
                      <button
                        className="text-action danger"
                        disabled={busy}
                        onClick={() => void removeSpeech(connection.id)}
                      >
                        确认删除
                      </button>
                      <button
                        className="text-action"
                        disabled={busy}
                        onClick={() => setDeleting(null)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      className="text-action"
                      disabled={busy}
                      aria-label={`删除 ${connection.name}`}
                      onClick={() => setDeleting(connection.id)}
                    >
                      <Trash2 size={13} />
                      删除
                    </button>
                  )}
                </div>
                {tests[connection.id] && (
                  <p
                    className={`speech-test ${tests[connection.id].tone}`}
                    role={tests[connection.id].tone === 'error' ? 'alert' : 'status'}
                  >
                    {tests[connection.id].message}
                  </p>
                )}
              </div>
            ))}

            {form ? (
              <form
                className="speech-form"
                aria-label={form.id ? '编辑语音服务' : '添加语音服务'}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveSpeech();
                }}
              >
                <div className="speech-form-heading">
                  <strong>{form.id ? '编辑语音服务' : '添加语音服务'}</strong>
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => setForm(null)}
                  >
                    取消
                  </button>
                </div>
                <label className="field-label" htmlFor="speech-name">
                  名称
                </label>
                <input
                  id="speech-name"
                  value={form.name}
                  required
                  maxLength={80}
                  onChange={(event) =>
                    setForm((current) => current && { ...current, name: event.target.value })
                  }
                />
                <label className="field-label" htmlFor="speech-protocol">
                  连接协议
                </label>
                <select
                  id="speech-protocol"
                  value={form.protocol}
                  onChange={(event) =>
                    setForm(
                      (current) =>
                        current && {
                          ...current,
                          protocol: event.target.value as SpeechProtocol,
                        },
                    )
                  }
                >
                  <option value="realtime">实时转写（WebRTC）</option>
                  <option value="file">结束后转写（文件转写）</option>
                </select>
                <p className="speech-hint">
                  实时转写适合边说边看文字；结束后转写在停止录音后才返回整段文字。
                </p>
                <label className="field-label" htmlFor="speech-url">
                  接口地址
                </label>
                <input
                  id="speech-url"
                  type="url"
                  value={form.baseUrl}
                  required
                  maxLength={2048}
                  spellCheck={false}
                  placeholder="https://api.openai.com/v1"
                  onChange={(event) =>
                    setForm((current) => current && { ...current, baseUrl: event.target.value })
                  }
                />
                <label className="field-label" htmlFor="speech-model">
                  模型 ID
                </label>
                <input
                  id="speech-model"
                  value={form.model}
                  required
                  maxLength={200}
                  spellCheck={false}
                  placeholder={
                    form.protocol === 'realtime' ? 'gpt-live-transcribe' : 'whisper-1'
                  }
                  onChange={(event) =>
                    setForm((current) => current && { ...current, model: event.target.value })
                  }
                />
                <label className="field-label" htmlFor="speech-key">
                  API 密钥
                </label>
                <input
                  id="speech-key"
                  type="password"
                  value={form.key}
                  maxLength={4096}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    form.id
                      ? '已保存的密钥不会回显，留空保持不变'
                      : '本地服务可留空'
                  }
                  onChange={(event) =>
                    setForm((current) => current && { ...current, key: event.target.value })
                  }
                />
                {form.id && (
                  <label className="speech-key-clear">
                    <input
                      type="checkbox"
                      checked={form.clearKey}
                      onChange={(event) =>
                        setForm(
                          (current) =>
                            current && { ...current, clearKey: event.target.checked },
                        )
                      }
                    />
                    清除已保存的密钥
                  </label>
                )}
                <div className="speech-form-actions">
                  <button className="button primary" disabled={busy}>
                    {form.id ? '保存修改' : '添加连接'}
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setForm(null)}
                  >
                    取消
                  </button>
                </div>
              </form>
            ) : (
              <button
                className="button secondary speech-add"
                onClick={() => {
                  setForm(emptySpeechForm());
                  setDeleting(null);
                }}
              >
                <Plus size={14} />
                添加语音服务
              </button>
            )}
            <p className="provider-storage-note">
              密钥只保存在本机，读取设置时不会回传。录音默认不写入磁盘。
            </p>
          </>
        )}
      </section>

      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

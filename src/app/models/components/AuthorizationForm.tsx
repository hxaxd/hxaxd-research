'use client';

import '../models.css';
import './AuthorizationForm.css';


import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { ArrowUpRight, X } from 'lucide-react';
import { ChoiceSelect } from '@/shared/ui/ChoiceSelect';
import { requestJson } from '@/shared/http/request-json';
import type { Authorization, ProviderSettings } from '../schema';

function pending(authorization: Authorization | null) {
  return authorization !== null && ['starting', 'waiting', 'exchanging'].includes(authorization.status);
}

export function AuthorizationForm({ providers, initialProviderId, initialAuthorization, onConnected, onCancel }: {
  providers: ProviderSettings['authorizationProviders'];
  initialProviderId?: string;
  initialAuthorization: Authorization | null;
  onConnected: (settings: ProviderSettings) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const [providerId, setProviderId] = useState(initialProviderId ?? providers[0]?.id ?? '');
  const [authorization, setAuthorization] = useState(initialAuthorization);
  const [callback, setCallback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useRef(initialAuthorization);
  const popup = useRef<Window | null>(null);
  const provider = providers.find(provider => provider.id === providerId);
  const waiting = pending(authorization);
  const url = authorization?.url;
  const authorizationUrl = `/api/model-providers/${providerId}/authorization`;

  function update(next: Authorization) {
    current.current = next;
    setAuthorization(next);
  }

  useEffect(() => {
    if (!waiting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await requestJson<ProviderSettings>('/api/model-providers', { signal: controller.signal });
        const authorization = next.authorization!;
        update(authorization);
        if (authorization.status === 'connected') await onConnected(next);
        else if (pending(authorization)) timer = setTimeout(poll, 800);
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      }
    }
    timer = setTimeout(poll, 500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [waiting, onConnected]);

  useEffect(() => {
    if (url && popup.current) popup.current.location.href = url;
  }, [url]);

  useEffect(() => {
    if (!waiting) { popup.current?.close(); popup.current = null; }
  }, [waiting]);

  useEffect(() => () => {
    const authorization = current.current;
    if (pending(authorization)) void requestJson(`/api/model-providers/${authorization!.providerId}/authorization`, {
      method: 'DELETE', body: JSON.stringify({ id: authorization!.id }),
    }).catch(() => undefined);
    popup.current?.close();
  }, []);

  async function act(operation: () => Promise<void>) {
    setBusy(true); setError('');
    try { await operation(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  function connect() {
    popup.current = window.open('about:blank', '_blank');
    if (popup.current) popup.current.opener = null;
    void act(async () => {
      try {
        update(await requestJson<Authorization>(authorizationUrl, {
          method: 'POST', body: JSON.stringify({ id: crypto.randomUUID() }),
        }));
      } catch (error) { popup.current?.close(); popup.current = null; throw error; }
    });
  }

  async function close() {
    if (waiting) update(await requestJson<Authorization>(authorizationUrl, {
      method: 'DELETE', body: JSON.stringify({ id: authorization!.id }),
    }));
    onCancel();
  }

  return <div className="connection-form">
    <div className="connection-form-heading">
      <strong>{t('models.addAuthorization')}</strong>
      <button className="icon-button" aria-label={t('common.close')} disabled={busy} onClick={() => void act(close)}><X size={17} /></button>
    </div>
    <ChoiceSelect label={t('models.authorizationProvider')} value={providerId} items={providers} disabled={busy || waiting}
      onChange={id => { setProviderId(id); setAuthorization(null); setCallback(''); setError(''); }} />
    {provider && <div className="authorization-capabilities">
      <p>{t('models.authorizationAdds')}</p>
      <ul>{provider.capabilities.map(capability => <li key={capability}>{provider.name} · {t(capability === 'text' ? 'models.text' : 'speech.title')}</li>)}</ul>
    </div>}
    {waiting ? <div className="provider-authorization">
      <p role="status">{authorization?.status === 'exchanging' ? t('common.connecting') : t('models.authorizationPending')}</p>
      <div className="provider-actions">
        {authorization?.url && <a className="button secondary" href={authorization.url} target="_blank" rel="noreferrer">{t('models.openAuthorization')}<ArrowUpRight size={14} /></a>}
        <button className="button secondary" disabled={busy} onClick={() => void act(close)}>{t('common.cancel')}</button>
      </div>
      {authorization?.manualInput && <details className="provider-manual">
        <summary>{t('models.pasteCallback')}</summary>
        <form onSubmit={event => { event.preventDefault(); void act(async () => {
          update(await requestJson<Authorization>(authorizationUrl + '/callback', {
            method: 'POST', body: JSON.stringify({ id: authorization!.id, url: callback }),
          }));
          setCallback('');
        }); }}>
          <label className="field-label" htmlFor="authorization-callback">{t('models.callbackUrl')}</label>
          <input id="authorization-callback" type="url" value={callback} onChange={event => setCallback(event.target.value)} required autoComplete="off" spellCheck={false} />
          <button className="button secondary" disabled={busy || !callback.trim()}>{t('models.completeConnection')}</button>
        </form>
      </details>}
    </div> : <button className="button primary" disabled={busy || !provider} onClick={connect}>{busy ? t('common.connecting') : t('models.authorizeAndAdd')}</button>}
    {(error || authorization?.error) && <p className="error-message" role="alert">{error || authorization?.error}</p>}
  </div>;
}

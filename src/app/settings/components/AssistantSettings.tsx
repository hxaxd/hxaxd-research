'use client';

import './AssistantSettings.css';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';

import type { AssistantPrompt } from '@/app/settings/assistant-prompt';
import { requestJson } from '@/shared/http/request-json';

const promptUrl = '/api/settings/assistant-prompt';

export function AssistantSettings() {
  const t = useTranslations('settings');
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<AssistantPrompt>(promptUrl, { signal: controller.signal }).then(
      ({ prompt }) => {
        if (controller.signal.aborted) return;
        setSaved(prompt);
        setDraft(prompt);
      },
      (error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      },
    );
    return () => controller.abort();
  }, [loadAttempt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { prompt } = await requestJson<AssistantPrompt>(promptUrl, {
        method: 'PUT',
        body: JSON.stringify({ prompt: draft }),
      });
      setSaved(prompt);
      setDraft(prompt);
      setShowSaved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : t('promptSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="assistant-settings" aria-labelledby="assistant-settings-title">
      <h3 id="assistant-settings-title">{t('assistant')}</h3>
      {saved === null ? (
        error ? (
          <div className="assistant-settings-actions">
            <p role="alert">{error}</p>
            <button className="button secondary" type="button" onClick={() => {
              setError('');
              setLoadAttempt(attempt => attempt + 1);
            }}>{t('promptRetry')}</button>
          </div>
        ) : <p role="status">{t('promptLoading')}</p>
      ) : (
        <form className="assistant-prompt-form" onSubmit={save}>
          <label className="field-label" htmlFor="assistant-prompt">{t('additionalSystemPrompt')}</label>
          <textarea id="assistant-prompt" rows={9} value={draft} disabled={saving} onChange={event => {
            setDraft(event.target.value);
            setShowSaved(false);
            setError('');
          }} />
          <div className="assistant-settings-actions">
            <button className="button primary" type="submit" disabled={saving || draft === saved}>
              {t(saving ? 'promptSaving' : 'promptSave')}
            </button>
            {error && <p role="alert">{error}</p>}
            {showSaved && <p role="status">{t('promptSaved')}</p>}
          </div>
        </form>
      )}
    </section>
  );
}

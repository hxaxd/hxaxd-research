'use client';

import './QuestionMessage.css';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { requestJson } from '@/shared/http/request-json';
import type { UserQuestion } from '../schema';

export function QuestionMessage({ question, url }: { question: UserQuestion; url: string }) {
  const t = useTranslations();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<string | null | undefined>();
  const [error, setError] = useState('');
  const answer = question.answer === undefined ? submitted : question.answer;

  async function submit(value: string | null) {
    setBusy(true);
    setError('');
    try {
      await requestJson(`${url}/answers`, { method: 'POST', body: JSON.stringify({ id: question.id, answer: value }) });
      setSubmitted(value);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="question-message" aria-label={t('tools.askUser')}>
    <h3>{question.prompt}</h3>
    {answer === undefined ? <>
      <div className="question-options">
        {question.options.map(option => <button key={option} disabled={busy} onClick={() => void submit(option)}>{option}</button>)}
      </div>
      <form onSubmit={event => { event.preventDefault(); if (text.trim()) void submit(text.trim()); }}>
        <textarea aria-label={t('conversations.customAnswer')} placeholder={t('conversations.customAnswer')}
          value={text} onChange={event => setText(event.target.value)} maxLength={10000} disabled={busy} rows={2} />
        <div className="question-actions">
          <button type="button" className="text-action" disabled={busy} onClick={() => void submit(null)}>{t('common.cancel')}</button>
          <button className="button secondary" disabled={busy || !text.trim()}>{t('conversations.submitAnswer')}</button>
        </div>
      </form>
    </> : <p className="question-answer">{answer ?? t('conversations.questionCancelled')}</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
  </section>;
}

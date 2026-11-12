'use client';

import './QuoteSelectionActions.css';

import { Quote, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { maxQuoteLength } from '@/app/files/schema';

export function QuoteSelectionActions({ text, onAttach, onClear }: {
  text: string;
  onAttach: () => Promise<void>;
  onClear: () => void;
}) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tooLong = text.length > maxQuoteLength;

  return <div className="selection-actions" role="group" aria-label={t('files.selection')}>
    <span title={text}>{tooLong ? t('errors.quoteLength') : error || text}</span>
    <button type="button" className="button" disabled={busy || tooLong}
      onPointerDown={event => event.preventDefault()} onClick={async () => {
        setBusy(true);
        setError('');
        try { await onAttach(); }
        catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
      }}><Quote size={16} aria-hidden="true" />{busy ? t('files.attaching') : t('files.quote')}</button>
    <button type="button" className="icon-button" aria-label={t('files.cancelQuote')}
      onPointerDown={event => event.preventDefault()} onClick={onClear}><X size={17} /></button>
  </div>;
}

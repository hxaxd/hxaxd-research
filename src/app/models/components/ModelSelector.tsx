'use client';

import './ModelSelector.css';

import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Search, Settings2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

import { openSettings } from '@/app/settings/components/open-settings';
import type { ConfiguredModel, ThinkingLevel } from '../schema';

export function ModelSelector({ models, model, onModelChange, thinking, onThinkingChange, connected, disabled }: {
  models: ConfiguredModel[];
  model: string;
  onModelChange: (id: string) => void;
  thinking?: ThinkingLevel;
  onThinkingChange: (value: ThinkingLevel) => void;
  connected: boolean;
  disabled: boolean;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const selected = models.find(item => item.id === model);
  const visible = models.filter(item => `${item.name} ${item.provider} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
  const names = {
    off: t('models.thinkingOff'), minimal: t('models.thinkingMinimal'), low: t('models.thinkingLow'),
    medium: t('models.thinkingMedium'), high: t('models.thinkingHigh'), xhigh: t('models.thinkingXhigh'), max: t('models.thinkingMax'),
  };

  return <Popover.Root open={open} onOpenChange={value => { setOpen(value); setQuery(''); }}>
    <Popover.Trigger className="model-selector-trigger" aria-label={t('models.select')}
      title={selected?.name ?? t('models.none')} disabled={disabled}>
      <span className="model-connection" data-connected={connected} role="status" aria-label={connected ? t('conversations.connected') : t('conversations.connecting')} />
      <span>{selected?.name ?? t('models.none')}</span><ChevronDown size={13} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content ref={panel} className="model-selector-panel menu-surface" side="top" align="start" sideOffset={10} collisionPadding={12}
        aria-label={t('models.select')} tabIndex={-1}
        onOpenAutoFocus={event => {
          if (window.matchMedia('(pointer: coarse)').matches) { event.preventDefault(); panel.current?.focus(); }
        }}>
        <label className="model-search">
          <Search size={16} aria-hidden="true" />
          <input value={query} onChange={event => setQuery(event.target.value)} aria-label={t('models.search')} placeholder={t('models.search')} />
        </label>
        <div className="model-options" role="group" aria-label={t('models.available')}>
          {visible.map(item => <button key={item.id} className="model-option" aria-pressed={model === item.id}
            onClick={() => onModelChange(item.id)}>
            <span><strong>{item.name}</strong><small>{item.provider}</small></span>
            {model === item.id && <Check size={16} aria-hidden="true" />}
          </button>)}
          {!visible.length && <p className="model-options-empty">{t(models.length ? 'models.noMatches' : 'models.none')}</p>}
        </div>
        {!!selected?.thinkingLevels.length && <fieldset className="model-thinking">
          <legend>{t('models.thinking')}</legend>
          <div>{selected.thinkingLevels.map(level => <label key={level}>
            <input type="radio" name="thinking-level" value={level} checked={thinking === level} onChange={() => onThinkingChange(level)} />
            <span>{names[level]}</span>
          </label>)}</div>
        </fieldset>}
        <button className="model-settings-link" onClick={() => { setOpen(false); openSettings('models'); }}>
          <Settings2 size={15} aria-hidden="true" />{t('models.settings')}
        </button>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

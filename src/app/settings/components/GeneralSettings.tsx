'use client';

import './GeneralSettings.css';


import { useId } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Minus, Plus, RotateCcw } from 'lucide-react';

import { useLocaleChange } from '@/app/i18n/LocaleProvider';
import { messages } from '@/shared/i18n/config.mjs';
import { ChoiceSelect } from '@/shared/ui/ChoiceSelect';
import { useAppearance } from './use-appearance';

function SizeControl({ label, value, min, max, step, unit, defaultValue, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: 'px' | '%';
  defaultValue: number;
  onChange: (value: number) => void;
}) {
  const t = useTranslations();
  const id = useId();
  return <div className="settings-row">
    <label htmlFor={id}>{label}</label>
    <div className="settings-size-control">
      <button className="icon-button" aria-label={t('settings.decrease', { value0: label })} disabled={value <= min} onClick={() => onChange(value - step)}><Minus size={16} /></button>
      <input id={id} type="range" min={min} max={max} step={step} value={value} aria-valuetext={`${value}${unit}`} onChange={event => onChange(Number(event.target.value))} />
      <button className="icon-button" aria-label={t('settings.increase', { value0: label })} disabled={value >= max} onClick={() => onChange(value + step)}><Plus size={16} /></button>
      <output htmlFor={id}>{value}{unit}</output>
      <button className="icon-button" aria-label={t('settings.reset', { value0: label })} title={t('settings.reset', { value0: label })} disabled={value === defaultValue} onClick={() => onChange(defaultValue)}><RotateCcw size={16} /></button>
    </div>
  </div>;
}

export function GeneralSettings() {
  const t = useTranslations();
  const locale = useLocale();
  const changeLocale = useLocaleChange();
  const appearance = useAppearance();
  return <section className="general-settings" aria-labelledby="general-settings-title">
    <h3 id="general-settings-title">{t('settings.general')}</h3>
    <div className="settings-row">
      <span>{t('settings.language')}</span>
      <ChoiceSelect label={t('settings.language')} value={locale}
        items={[{ id: 'zh-CN', name: t('settings.chinese') }, { id: 'en', name: t('settings.english') }]}
        onChange={value => changeLocale(value as keyof typeof messages)} />
    </div>
    <SizeControl label={t('settings.fontSize')} value={appearance.fontSize} min={12} max={22} step={1} unit="px" defaultValue={14} onChange={appearance.setFontSize} />
    <SizeControl label={t('settings.interfaceScale')} value={appearance.interfaceScale} min={75} max={150} step={5} unit="%" defaultValue={100} onChange={appearance.setInterfaceScale} />
  </section>;
}

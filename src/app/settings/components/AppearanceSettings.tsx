'use client';

import './AppearanceSettings.css';


import { useTranslations } from 'use-intl';

import {
  Braces,
  Check,
  Download,
  Monitor,
  Moon,
  Sun,
  Upload,
} from 'lucide-react';
import { useRef, useState, type CSSProperties } from 'react';

import {
  palettes,
  paletteTokens,
  type ColorMode,
  type ThemeSettings,
} from '../appearance';
import { useAppearance } from './use-appearance';

function CssEditor({
  mode,
  theme,
  onChange,
}: {
  mode: ColorMode;
  theme: ThemeSettings;
  onChange: (changes: Partial<ThemeSettings>) => void;
}) {
  const t = useTranslations();
  const [draft, setDraft] = useState(theme.css);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const label = mode === 'light' ? t('settings.lightCss') : t('settings.darkCss');

  function exportCss() {
    const palette = palettes.find((palette) => palette.id === theme.palette)!;
    const tokens = Object.entries(paletteTokens(palette))
      .map(([key, value]) => `  ${key}: ${value};`)
      .join('\n');
    const content = `:root {\n  color-scheme: ${mode};\n${tokens}\n}\n\n${theme.css}`;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/css' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `research-${mode}-${theme.palette}.css`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="css-settings">
      <label className="field-label" htmlFor={`theme-css-${mode}`}>
        {label}
      </label>
      <textarea
        id={`theme-css-${mode}`}
        className="css-editor"
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setError('');
        }}
        placeholder={
          ':root {\n  --accent: #a5b4fc;\n}\n\n.workbench { border-radius: 18px; }'
        }
      />
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        accept=".css,text/css"
        aria-label={t('settings.importCss', {value0: label})}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (file) {
            try {
              setDraft(await file.text());
              setError('');
            } catch (error) {
              setError(t('errors.readDetail', {value0: (error as Error).message}));
            }
          }
          event.target.value = '';
        }}
      />
      <div className="css-actions">
        <button
          className="button primary"
          onClick={() => {
            onChange({ css: draft });
            setError('');
          }}
        >
          {t('settings.applyCss')}
        </button>
        <button
          className="button secondary"
          onClick={() => {
            setDraft('');
            onChange({ css: '' });
            setError('');
          }}
        >
          {t('settings.clearCss')}
        </button>
        <span className="header-spacer" />
        <button
          className="button secondary"
          onClick={() => input.current!.click()}
        >
          <Upload size={14} />
          {t('common.import')}
        </button>
        <button className="button secondary" onClick={exportCss}>
          <Download size={14} />
          {t('settings.exportTheme')}
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PaletteOption({
  palette,
  selected,
  custom = false,
  onSelect,
}: {
  palette: (typeof palettes)[number];
  selected: boolean;
  custom?: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations();
  return (
    <label className="palette-option">
      <input
        type="radio"
        name={`${palette.mode}-palette`}
        value={custom ? 'custom' : palette.id}
        checked={selected}
        onChange={onSelect}
      />
      <span className="palette-card">
        <span
          className="palette-preview"
          aria-hidden="true"
          style={paletteTokens(palette) as CSSProperties}
        >
          <span className="preview-top">
            <i />
            <i />
            <i />
          </span>
          <span className="preview-sidebar">
            <i />
            <i />
            <i />
          </span>
          <span className="preview-document">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="preview-chat">
            <i />
            <i />
            <i />
            <b />
          </span>
          {custom && (
            <span className="preview-custom-icon">
              <Braces size={24} />
            </span>
          )}
        </span>
        <span className="palette-caption">
          <strong>{custom ? t('settings.customCss') : t(palette.name)}</strong>
          {selected && <Check size={14} aria-hidden="true" />}
        </span>
      </span>
    </label>
  );
}

function ThemeOptions({
  mode,
  theme,
  onChange,
}: {
  mode: ColorMode;
  theme: ThemeSettings;
  onChange: (changes: Partial<ThemeSettings>) => void;
}) {
  const t = useTranslations();
  const options = palettes.filter((palette) => palette.mode === mode);
  const current = options.find((palette) => palette.id === theme.palette)!;
  return (
    <fieldset className="appearance-section theme-options">
      <legend>{mode === 'light' ? t('settings.lightMode') : t('settings.darkMode')}</legend>
      <div className="palette-options">
        {options.map((palette) => (
          <PaletteOption
            key={palette.id}
            palette={palette}
            selected={!theme.custom && theme.palette === palette.id}
            onSelect={() => onChange({ palette: palette.id, custom: false })}
          />
        ))}
        <PaletteOption
          palette={current}
          selected={theme.custom}
          custom
          onSelect={() => onChange({ custom: true })}
        />
      </div>
      {theme.custom && (
        <CssEditor mode={mode} theme={theme} onChange={onChange} />
      )}
    </fieldset>
  );
}

export function AppearanceSettings() {
  const t = useTranslations();
  const appearance = useAppearance();
  return (
    <>
      <fieldset className="appearance-section">
        <legend>{t('settings.displayMode')}</legend>
        <div className="appearance-modes">
          {(
            [
              { id: 'system', name: t('settings.system'), icon: Monitor },
              { id: 'light', name: t('settings.light'), icon: Sun },
              { id: 'dark', name: t('settings.dark'), icon: Moon },
            ] as const
          ).map((mode) => (
            <label key={mode.id}>
              <input
                type="radio"
                name="appearance-mode"
                value={mode.id}
                checked={appearance.mode === mode.id}
                onChange={() => appearance.setMode(mode.id)}
              />
              <span>
                <mode.icon size={15} />
                {mode.name}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {(['light', 'dark'] as const).map((mode) => (
        <ThemeOptions
          key={mode}
          mode={mode}
          theme={appearance[mode]}
          onChange={(changes) => appearance.setTheme(mode, changes)}
        />
      ))}
    </>
  );
}

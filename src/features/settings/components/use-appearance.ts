'use client';

import { useSyncExternalStore } from 'react';

import {
  applyAppearance,
  type ColorMode,
  type ThemeSettings,
} from '../appearance';

function subscribe(listener: () => void) {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const sync = () => {
    applyAppearance();
    listener();
  };
  window.addEventListener('research-appearance', sync);
  window.addEventListener('storage', sync);
  media.addEventListener('change', sync);
  return () => {
    window.removeEventListener('research-appearance', sync);
    window.removeEventListener('storage', sync);
    media.removeEventListener('change', sync);
  };
}

function readTheme(mode: ColorMode): ThemeSettings {
  const prefix = mode === 'dark' ? 'research' : 'research-light';
  return {
    palette:
      localStorage.getItem(`${prefix}-palette`) ??
      (mode === 'dark' ? 'graphite' : 'paper'),
    custom: localStorage.getItem(`${prefix}-custom-active`) === 'true',
    css: localStorage.getItem(`${prefix}-custom-css`) ?? '',
  };
}

function snapshot() {
  return JSON.stringify({
    mode: localStorage.getItem('research-theme') ?? 'system',
    resolvedMode: document.documentElement.dataset.theme,
    light: readTheme('light'),
    dark: readTheme('dark'),
  });
}

const initialSnapshot = JSON.stringify({
  mode: 'system',
  resolvedMode: 'light',
  light: { palette: 'paper', custom: false, css: '' },
  dark: { palette: 'graphite', custom: false, css: '' },
});

export function useAppearance() {
  const saved = useSyncExternalStore(
    subscribe,
    snapshot,
    () => initialSnapshot,
  );
  const appearance = JSON.parse(saved) as {
    mode: 'system' | ColorMode;
    resolvedMode: ColorMode;
    light: ThemeSettings;
    dark: ThemeSettings;
  };
  function notify() {
    applyAppearance();
    window.dispatchEvent(new Event('research-appearance'));
  }
  function setMode(mode: typeof appearance.mode) {
    localStorage.setItem('research-theme', mode);
    notify();
  }
  function setTheme(mode: ColorMode, changes: Partial<ThemeSettings>) {
    const prefix = mode === 'dark' ? 'research' : 'research-light';
    if (changes.palette !== undefined)
      localStorage.setItem(`${prefix}-palette`, changes.palette);
    if (changes.custom !== undefined)
      localStorage.setItem(`${prefix}-custom-active`, String(changes.custom));
    if (changes.css !== undefined)
      localStorage.setItem(`${prefix}-custom-css`, changes.css);
    notify();
  }
  return { ...appearance, setMode, setTheme };
}

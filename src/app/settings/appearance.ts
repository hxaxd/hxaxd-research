export type ColorMode = 'light' | 'dark';
export type ThemeSettings = { palette: string; custom: boolean; css: string };

type Palette = {
  id: string; mode: ColorMode; name: string;
  base: string; panel: string; canvas: string; surface: string; text: string; muted: string;
  line: string; strong: string; accent: string; danger: string; dangerSurface: string;
};

// The first palette of each mode is its default and the fallback for unknown saved ids.
export const palettes: Palette[] = [
  { id: 'paper', mode: 'light', name: 'settings.paper', base: '#f5f6f8', panel: '#ffffff', canvas: '#eef0f3', surface: '#e8ebf0',
    text: '#1f2430', muted: '#5b6472', line: '#dde1e7', strong: '#a9b1bd', accent: '#3a5fc0', danger: '#b42d35', dangerSurface: '#fdeeee' },
  { id: 'parchment', mode: 'light', name: 'settings.parchment', base: '#f3efe6', panel: '#fbf9f4', canvas: '#ece6da', surface: '#e7e0d2',
    text: '#2c2620', muted: '#6b6155', line: '#ddd5c6', strong: '#b3a790', accent: '#9c4a2c', danger: '#a8322d', dangerSurface: '#f8e7e2' },
  { id: 'celadon', mode: 'light', name: 'settings.celadon', base: '#eef2f0', panel: '#fafcfb', canvas: '#e5ebe8', surface: '#dfe7e3',
    text: '#1f2a27', muted: '#56645f', line: '#d3ddd8', strong: '#9fb0a9', accent: '#2f6e60', danger: '#ac3a3a', dangerSurface: '#f7e8e6' },
  { id: 'graphite', mode: 'dark', name: 'settings.graphite', base: '#16181c', panel: '#1d2025', canvas: '#121417', surface: '#272b31',
    text: '#e4e7ec', muted: '#9aa1ac', line: '#30353d', strong: '#555c67', accent: '#8ab4f8', danger: '#f2a097', dangerSurface: '#3a2426' },
  { id: 'ink', mode: 'dark', name: 'settings.ink', base: '#0f1623', panel: '#151e2e', canvas: '#0b111b', surface: '#1f2a3d',
    text: '#dfe6f2', muted: '#93a1b8', line: '#273349', strong: '#4a5a75', accent: '#7fa7ff', danger: '#f19c9c', dangerSurface: '#3a2230' },
  { id: 'lamplight', mode: 'dark', name: 'settings.lamplight', base: '#1b1916', panel: '#22201c', canvas: '#161411', surface: '#2d2a25',
    text: '#e9e2d4', muted: '#a69d8c', line: '#38342d', strong: '#5f5749', accent: '#e0a463', danger: '#ee9a85', dangerSurface: '#3d2620' },
];

export function resolvePalette(mode: ColorMode, id: string | null) {
  const options = palettes.filter(palette => palette.mode === mode);
  return options.find(palette => palette.id === id) ?? options[0];
}

export function paletteTokens(palette: Palette) {
  return {
    '--ink': palette.text,
    '--muted': palette.muted,
    '--line': palette.line,
    '--paper': palette.panel,
    '--ground': palette.canvas,
    '--sidebar': palette.base,
    '--reader': palette.canvas,
    '--shell': palette.base,
    '--accent': palette.accent,
    '--accent-hover': `color-mix(in srgb, ${palette.accent} 85%, ${palette.mode === 'dark' ? 'white' : 'black'})`,
    '--soft': `color-mix(in srgb, ${palette.accent} 12%, ${palette.panel})`,
    '--hover': palette.surface,
    '--field': palette.surface,
    '--selection': `color-mix(in srgb, ${palette.accent} 35%, ${palette.panel})`,
    '--strong-line': palette.strong,
    '--user-message': palette.surface,
    '--composer': palette.surface,
    '--overlay': palette.mode === 'dark' ? '#0009' : '#14203566',
    '--danger': palette.danger,
    '--danger-soft': palette.dangerSurface,
    '--danger-line': `color-mix(in srgb, ${palette.danger} 40%, ${palette.panel})`,
    '--on-accent': palette.mode === 'dark' ? palette.base : '#fff',
    '--header-ink': 'var(--ink)',
    '--header-muted': 'var(--muted)',
    '--shadow':
      palette.mode === 'dark' ? '0 8px 30px #0003' : '0 8px 30px #1d2a3b0a',
    '--floating-shadow':
      palette.mode === 'dark'
        ? '0 16px 48px #0006, 0 2px 8px #0003'
        : '0 12px 40px #15203024, 0 2px 6px #15203010',
  };
}

function paletteRule(selector: string, palette: Palette) {
  const tokens = Object.entries(paletteTokens(palette)).map(([key, value]) => `${key}:${value}`).join(';');
  return `${selector}{color-scheme:${palette.mode};${tokens}}`;
}

// Mode-level rules come first so a removed or unknown palette id still gets that mode's default.
export const paletteStyles = `@layer research-theme {${[
  ...(['light', 'dark'] as const).map(mode => paletteRule(`:root[data-theme='${mode}']`, resolvePalette(mode, null))),
  ...palettes.map(palette => paletteRule(`:root[data-theme='${palette.mode}'][data-palette='${palette.id}']`, palette)),
].join('\n')}}`;

// Self-contained so the same function can run before hydration and on preference changes.
export function applyAppearance() {
  document.documentElement.style.setProperty('--font-size', `${localStorage.getItem('research-font-size') ?? 14}px`);
  document.documentElement.style.setProperty('--ui-scale', String(Number(localStorage.getItem('research-ui-scale') ?? 100) / 100));
  const mode = localStorage.getItem('research-theme') ?? 'system';
  document.documentElement.dataset.theme =
    mode === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode;
  document.documentElement.dataset.palette =
    localStorage.getItem(
      document.documentElement.dataset.theme === 'dark'
        ? 'research-palette'
        : 'research-light-palette',
    ) ??
    (document.documentElement.dataset.theme === 'dark' ? 'graphite' : 'paper');
  let style = document.getElementById('research-custom-css');
  if (!style) {
    style = document.createElement('style');
    style.id = 'research-custom-css';
    document.head.appendChild(style);
  }
  const prefix =
    document.documentElement.dataset.theme === 'dark'
      ? 'research'
      : 'research-light';
  style.textContent =
    localStorage.getItem(`${prefix}-custom-active`) === 'true'
      ? (localStorage.getItem(`${prefix}-custom-css`) ?? '')
      : '';
}

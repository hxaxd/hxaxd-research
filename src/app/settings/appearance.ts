export type ColorMode = 'light' | 'dark';
export type ThemeSettings = { palette: string; custom: boolean; css: string };

export const palettes = [
  {
    id: 'paper',
    mode: 'light',
    name: 'settings.paper',
    base: '#f6f8fa',
    panel: '#ffffff',
    canvas: '#f0f3f6',
    surface: '#eaeef2',
    text: '#1f2328',
    muted: '#59636e',
    line: '#d0d7de',
    strong: '#8c959f',
    accent: '#0969da',
    danger: '#cf222e',
    dangerSurface: '#ffebe9',
  },
  {
    id: 'snow',
    mode: 'light',
    name: 'settings.snow',
    base: '#e5e9f0',
    panel: '#eceff4',
    canvas: '#d8dee9',
    surface: '#d8dee9',
    text: '#2e3440',
    muted: '#4c566a',
    line: '#c1cad8',
    strong: '#81a1c1',
    accent: '#42648c',
    danger: '#a13e48',
    dangerSurface: '#f5e2e5',
  },
  {
    id: 'latte',
    mode: 'light',
    name: 'settings.latte',
    base: '#e6e9ef',
    panel: '#eff1f5',
    canvas: '#dce0e8',
    surface: '#dce0e8',
    text: '#4c4f69',
    muted: '#5c5f77',
    line: '#bcc0cc',
    strong: '#8c8fa1',
    accent: '#8839ef',
    danger: '#d20f39',
    dangerSurface: '#f9e2e8',
  },
  {
    id: 'graphite',
    mode: 'dark',
    name: 'settings.graphite',
    base: '#0d1117',
    panel: '#161b22',
    canvas: '#0d1117',
    surface: '#21262d',
    text: '#e6edf3',
    muted: '#9da7b3',
    line: '#30363d',
    strong: '#59636f',
    accent: '#79c0ff',
    danger: '#ffa198',
    dangerSurface: '#362125',
  },
  {
    id: 'nord',
    mode: 'dark',
    name: 'settings.nord',
    base: '#2e3440',
    panel: '#3b4252',
    canvas: '#2e3440',
    surface: '#434c5e',
    text: '#eceff4',
    muted: '#d8dee9',
    line: '#4c566a',
    strong: '#81a1c1',
    accent: '#88c0d0',
    danger: '#e5a0a7',
    dangerSurface: '#49343f',
  },
  {
    id: 'mocha',
    mode: 'dark',
    name: 'settings.mocha',
    base: '#181825',
    panel: '#1e1e2e',
    canvas: '#11111b',
    surface: '#313244',
    text: '#cdd6f4',
    muted: '#bac2de',
    line: '#45475a',
    strong: '#7f849c',
    accent: '#b4befe',
    danger: '#f38ba8',
    dangerSurface: '#432c3f',
  },
];

export function paletteTokens(palette: (typeof palettes)[number]) {
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

export const paletteStyles = `@layer research-theme {${palettes
  .map(
    (palette) =>
      `:root[data-theme='${palette.mode}'][data-palette='${palette.id}']{color-scheme:${palette.mode};${Object.entries(
        paletteTokens(palette),
      )
        .map(([key, value]) => `${key}:${value}`)
        .join(';')}}`,
  )
  .join('\n')}}`;

// Self-contained so the same function can run before hydration and on preference changes.
export function applyAppearance() {
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

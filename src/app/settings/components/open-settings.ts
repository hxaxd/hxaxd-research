'use client';

export type SettingsTab = 'appearance' | 'models';

export const settingsEvent = 'research-open-settings';

export function openSettings(tab: SettingsTab = 'appearance') {
  window.dispatchEvent(
    new CustomEvent(settingsEvent, { detail: { tab } }),
  );
}

'use client';

export type SettingsTab = 'general' | 'appearance' | 'models';

export const settingsEvent = 'research-open-settings';

export function openSettings(tab: SettingsTab = 'general') {
  window.dispatchEvent(
    new CustomEvent(settingsEvent, { detail: { tab } }),
  );
}

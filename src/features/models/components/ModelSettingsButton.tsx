'use client';

import { Settings2 } from 'lucide-react';

import { openSettings } from '@/features/settings/components/open-settings';

export function ModelSettingsButton({
  showLabel = false,
  disabled = false,
}: {
  showLabel?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={showLabel ? 'button secondary' : 'icon-button provider-trigger'}
      aria-label="模型设置"
      title="模型设置"
      disabled={disabled}
      onClick={() => openSettings('models')}
    >
      <Settings2 size={15} />
      {showLabel && '模型设置'}
    </button>
  );
}

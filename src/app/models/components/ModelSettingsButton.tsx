'use client';

import './ModelSettingsButton.css';


import { useTranslations } from 'use-intl';

import { Settings2 } from 'lucide-react';

import { openSettings } from '@/app/settings/components/open-settings';

export function ModelSettingsButton({
  showLabel = false,
  disabled = false,
}: {
  showLabel?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations();
  return (
    <button
      className={showLabel ? 'button secondary' : 'icon-button provider-trigger'}
      aria-label={t('models.settings')}
      title={t('models.settings')}
      disabled={disabled}
      onClick={() => openSettings('models')}
    >
      <Settings2 size={15} />
      {showLabel && t('models.settings')}
    </button>
  );
}

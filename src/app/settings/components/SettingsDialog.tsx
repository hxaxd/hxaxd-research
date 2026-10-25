'use client';

import './SettingsDialog.css';


import { useTranslations } from 'use-intl';

import * as Dialog from '@radix-ui/react-dialog';
import { Moon, Settings, Sun, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ModelSettings } from '@/app/models/components/ModelSettings';
import { notifyModelsChanged } from '@/app/models/components/model-events';
import { AppearanceSettings } from './AppearanceSettings';
import { GeneralSettings } from './GeneralSettings';
import { settingsEvent, type SettingsTab } from './open-settings';
import { useAppearance } from './use-appearance';

export function SettingsDialog() {
  const t = useTranslations();
  const appearance = useAppearance();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('general');
  const dark = appearance.resolvedMode === 'dark';

  const modelsChanged = useCallback(async () => {
    notifyModelsChanged();
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ tab?: SettingsTab }>).detail;
      setTab(detail?.tab ?? 'general');
      setOpen(true);
    };
    window.addEventListener(settingsEvent, onOpen);
    return () => window.removeEventListener(settingsEvent, onOpen);
  }, []);

  return (
    <>
      <button
        className="icon-button theme-toggle"
        aria-label={dark ? t('settings.switchLight') : t('settings.switchDark')}
        title={dark ? t('settings.switchLight') : t('settings.switchDark')}
        aria-pressed={dark}
        onClick={() => appearance.setMode(dark ? 'light' : 'dark')}
      >
        {dark ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <button
            className="icon-button"
            aria-label={t('settings.title')}
            title={t('settings.title')}
            onClick={() => setTab('general')}
          >
            <Settings size={18} />
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content settings-dialog" aria-describedby={undefined}>
            <div className="dialog-heading">
              <Dialog.Title>{t('settings.title')}</Dialog.Title>
              <Dialog.Close className="icon-button" aria-label={t('settings.close')}>
                <X size={18} />
              </Dialog.Close>
            </div>
            <div className="settings-layout">
              <nav className="settings-nav" aria-label={t('settings.categories')}>
                <button
                  type="button"
                  className={tab === 'general' ? 'is-active' : undefined}
                  aria-current={tab === 'general' ? 'page' : undefined}
                  onClick={() => setTab('general')}
                >
                  {t('settings.general')}
                </button>
                <button
                  type="button"
                  className={tab === 'appearance' ? 'is-active' : undefined}
                  aria-current={tab === 'appearance' ? 'page' : undefined}
                  onClick={() => setTab('appearance')}
                >
                  {t('settings.appearance')}
                </button>
                <button
                  type="button"
                  className={tab === 'models' ? 'is-active' : undefined}
                  aria-current={tab === 'models' ? 'page' : undefined}
                  onClick={() => setTab('models')}
                >
                  {t('models.model')}
                </button>
              </nav>
              <div className="settings-body" key={tab}>
                {tab === 'general' ? (
                  <GeneralSettings />
                ) : tab === 'appearance' ? (
                  <AppearanceSettings />
                ) : (
                  <ModelSettings onModelsChanged={modelsChanged} />
                )}
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

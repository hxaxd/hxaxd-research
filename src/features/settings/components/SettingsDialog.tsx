'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Moon, Settings, Sun, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ModelSettings } from '@/features/models/components/ModelSettings';
import { notifyModelsChanged } from '@/features/models/components/model-events';
import { AppearanceSettings } from './AppearanceSettings';
import { settingsEvent, type SettingsTab } from './open-settings';
import { useAppearance } from './use-appearance';

export function SettingsDialog() {
  const appearance = useAppearance();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('appearance');
  const dark = appearance.resolvedMode === 'dark';

  const modelsChanged = useCallback(async () => {
    notifyModelsChanged();
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ tab?: SettingsTab }>).detail;
      setTab(detail?.tab ?? 'appearance');
      setOpen(true);
    };
    window.addEventListener(settingsEvent, onOpen);
    return () => window.removeEventListener(settingsEvent, onOpen);
  }, []);

  return (
    <>
      <button
        className="icon-button theme-toggle"
        aria-label={dark ? '切换浅色模式' : '切换暗色模式'}
        title={dark ? '切换浅色模式' : '切换暗色模式'}
        aria-pressed={dark}
        onClick={() => appearance.setMode(dark ? 'light' : 'dark')}
      >
        {dark ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <button
            className="icon-button"
            aria-label="设置"
            title="设置"
            onClick={() => setTab('appearance')}
          >
            <Settings size={18} />
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content settings-dialog">
            <div className="dialog-heading">
              <Dialog.Title>设置</Dialog.Title>
              <Dialog.Close className="icon-button" aria-label="关闭设置">
                <X size={18} />
              </Dialog.Close>
            </div>
            <Dialog.Description className="visually-hidden">
              外观与模型设置
            </Dialog.Description>
            <div className="settings-layout">
              <nav className="settings-nav" aria-label="设置分类">
                <button
                  type="button"
                  className={tab === 'appearance' ? 'is-active' : undefined}
                  aria-current={tab === 'appearance' ? 'page' : undefined}
                  onClick={() => setTab('appearance')}
                >
                  外观
                </button>
                <button
                  type="button"
                  className={tab === 'models' ? 'is-active' : undefined}
                  aria-current={tab === 'models' ? 'page' : undefined}
                  onClick={() => setTab('models')}
                >
                  模型
                </button>
              </nav>
              <div className="settings-body" key={tab}>
                {tab === 'appearance' ? (
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

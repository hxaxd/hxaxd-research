'use client';

import * as Menu from '@radix-ui/react-dropdown-menu';
import { Download, RefreshCw } from 'lucide-react';
import { useTranslations } from 'use-intl';

export function FileMenuItems({ url, onReload, onDownload, downloadDisabled }: {
  url: string;
  onReload: () => void;
  onDownload?: () => void;
  downloadDisabled?: boolean;
}) {
  const t = useTranslations();
  const downloadLabel = <><Download size={16} aria-hidden="true" />{t('files.download')}</>;
  return <>
    <Menu.Item className="menu-item" onSelect={onReload}>
      <RefreshCw size={16} aria-hidden="true" />{t('files.reload')}
    </Menu.Item>
    {onDownload ? <Menu.Item className="menu-item" disabled={downloadDisabled} onSelect={onDownload}>
      {downloadLabel}
    </Menu.Item> : <Menu.Item className="menu-item" asChild>
      <a href={`${url}&download=1`}>{downloadLabel}</a>
    </Menu.Item>}
  </>;
}

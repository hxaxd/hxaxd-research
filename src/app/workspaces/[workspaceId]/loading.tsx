'use client';

import { useTranslations } from 'use-intl';

export default function Loading() {
  const t = useTranslations();
  return <div className="loading-screen">{t('workspaces.loading')}</div>;
}

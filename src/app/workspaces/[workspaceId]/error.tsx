'use client';

import { useTranslations } from 'use-intl';

export default function ErrorPage({ reset }: { reset: () => void }) {
  const t = useTranslations();
  return (
    <div className="loading-screen">
      <h2>{t('workspaces.unavailable')}</h2>
      <p>{t('workspaces.errorDescription')}</p>
      <button className="button primary" onClick={reset}>
        {t('common.reopen')}
      </button>
    </div>
  );
}

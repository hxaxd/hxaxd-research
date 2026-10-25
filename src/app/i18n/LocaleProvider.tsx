'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { IntlProvider } from 'use-intl';
import { localeCookie, messages } from '@/shared/i18n/config.mjs';

type Locale = keyof typeof messages;
const LocaleChange = createContext<(locale: Locale) => void>(null!);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const [current, setCurrent] = useState(locale);
  const router = useRouter();
  function change(next: Locale) {
    setCurrent(next);
    document.cookie = `${localeCookie}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.documentElement.lang = next;
    router.refresh();
  }
  return <LocaleChange.Provider value={change}>
    <IntlProvider locale={current} messages={messages[current]} timeZone="UTC">
      {children}
    </IntlProvider>
  </LocaleChange.Provider>;
}

export function useLocaleChange() { return useContext(LocaleChange); }

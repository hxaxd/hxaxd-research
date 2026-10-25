import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { applyAppearance, paletteStyles } from '@/app/settings/appearance';
import { localeCookie, resolveLocale, translator } from '@/shared/i18n/config.mjs';
import { LocaleProvider } from './i18n/LocaleProvider';

import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = translator(resolveLocale((await cookies()).get(localeCookie)?.value));
  return { title: 'hxaxd-research', description: t('app.description') };
}
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = resolveLocale((await cookies()).get(localeCookie)?.value);
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <style>{paletteStyles}</style>
        <script
          dangerouslySetInnerHTML={{
            __html: `(${applyAppearance.toString()})();`,
          }}
        />
      </head>
      <body><LocaleProvider locale={locale}>{children}</LocaleProvider></body>
    </html>
  );
}

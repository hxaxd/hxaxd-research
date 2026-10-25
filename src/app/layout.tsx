import type { Metadata } from 'next';
import { applyAppearance, paletteStyles } from '@/app/settings/appearance';

import './globals.css';

export const metadata: Metadata = {
  title: '科研工作台',
  description: '围绕论文、真实材料与 AI 对话的本地科研工作台。',
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <style>{paletteStyles}</style>
        <script
          dangerouslySetInnerHTML={{
            __html: `(${applyAppearance.toString()})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

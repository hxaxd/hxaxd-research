import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['better-sqlite3', '@earendil-works/pi-coding-agent', 'pdfjs-dist', 'busboy'],
  devIndicators: false,
};
export default config;

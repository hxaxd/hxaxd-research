import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['@earendil-works/pi-coding-agent', 'pdfjs-dist'],
  devIndicators: false,
};
export default config;

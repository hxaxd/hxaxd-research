import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
export default defineConfig([
  ...nextVitals, ...nextTypescript,
  globalIgnores(['.next/**', 'node_modules/**', '.local/**', 'backend/**', 'frontend/**', '.tools/**', 'public/pdf-assets/**', 'test-results/**', 'playwright-report/**', 'next-env.d.ts']),
  { files: ['src/features/files/components/ResourcePreview.tsx'], rules: { '@next/next/no-img-element': 'off' } },
]);

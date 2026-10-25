import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores(['.runtime/**', 'public/pdf-assets/**']),
  {
    files: ['src/app/files/components/ImagePreview.tsx', 'src/app/conversations/components/ImageAttachment.tsx'],
    rules: { '@next/next/no-img-element': 'off' },
  },
]);

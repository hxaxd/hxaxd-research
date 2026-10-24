import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores(['.runtime/**', 'public/pdf-assets/**']),
  {
    files: ['src/features/files/components/ImagePreview.tsx', 'src/features/conversations/components/ImageAttachment.tsx'],
    rules: { '@next/next/no-img-element': 'off' },
  },
]);

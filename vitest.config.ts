import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/server-only.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/api/**/*.test.ts', 'tests/commands/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    coverage: {
      include: [
        'src/app/api/**/*.ts',
        'src/server/**/*.{ts,mjs}',
        'src/features/**/server/**/*.ts',
        'src/features/**/schema.ts',
        'src/features/translation/runtime.ts',
        'src/shared/schema.ts',
        'src/shared/http/api-error.ts',
      ],
      exclude: ['src/features/conversations/server/tools/**', 'src/features/files/server/extract-pdf-text.ts'],
      reporter: ['text-summary', 'json', 'json-summary', 'html'],
      reportsDirectory: '.runtime/dev/coverage',
    },
  },
});

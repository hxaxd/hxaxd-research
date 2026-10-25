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
        'src/app/{config.mjs,install.mjs,runtime.ts}',
        'src/app/i18n/server.mjs',
        'src/app/**/server/**/*.ts',
        'src/app/**/schema.ts',
        'src/app/translation/runtime.ts',
        'src/app/workspaces/workspaces.ts',
        'src/shared/schema.ts',
        'src/shared/http/{api-error,event-stream}.ts',
        'src/shared/i18n/config.mjs',
      ],
      exclude: ['src/app/conversations/server/tools/**', 'src/app/files/server/extract-pdf-text.ts'],
      reporter: ['text-summary', 'json', 'json-summary', 'html'],
      reportsDirectory: '.runtime/dev/coverage',
    },
  },
});

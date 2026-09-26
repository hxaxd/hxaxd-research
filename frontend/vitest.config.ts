import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['ui-projects/tests/**/*.spec.ts', 'tests/**/*.spec.ts'],
    environment: 'node',
  },
})

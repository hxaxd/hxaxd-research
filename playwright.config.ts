import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { freePort } from './tests/free-port';
process.env.RESEARCH_E2E_DATA ??= path.resolve('.tools', 'e2e', randomUUID());
process.env.RESEARCH_E2E_PORT ??= String(await freePort());
const port = process.env.RESEARCH_E2E_PORT;
export default defineConfig({
  testDir: './tests/e2e', workers: 1, timeout: 45000, expect: { timeout: 10000 }, globalSetup: './tests/e2e/global-setup.ts',
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port ${port}`, url: `http://127.0.0.1:${port}/api/workspaces`, reuseExistingServer: false, timeout: 60000, env: { APP_DATA_DIR: process.env.RESEARCH_E2E_DATA } },
});

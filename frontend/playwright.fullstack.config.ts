import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "fullstack.spec.ts",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4174",
    channel: "chrome",
    colorScheme: "dark",
    hasTouch: true,
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 768, height: 1024 },
  },
  webServer: {
    command: "uv run --directory ../backend python -m tests.fullstack_server --port 4174",
    url: "http://127.0.0.1:4174/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

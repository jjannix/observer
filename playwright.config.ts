import { defineConfig } from "@playwright/test";

const port = Number(process.env.OBSERVER_E2E_PORT ?? 4318);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  },
  webServer: {
    command: `cross-env NODE_ENV=production OBSERVER_PORT=${port} OBSERVER_E2E=1 tsx src/server/main.ts`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});

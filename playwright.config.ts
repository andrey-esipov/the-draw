import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /draw-league\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  use: {
    actionTimeout: 10_000,
    baseURL: 'http://127.0.0.1:43175',
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    // Use the full Chromium binary in "headless=new" mode instead of the
    // stripped-down chrome-headless-shell (Playwright's default for
    // headless chromium runs). The headless-shell's software WebGL/GPU
    // compositing path stalls on synthetic click delivery in this sandbox;
    // the full-Chromium new-headless mode does not exhibit the stall.
    channel: 'chromium',
  },
  reporter: [['list']],
  webServer: {
    command: 'npx tsx scripts/e2e-draw-production-server.ts',
    url: 'http://127.0.0.1:43175/api/health',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});

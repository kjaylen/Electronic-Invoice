/**
 * Browser tests for the web app: npm run e2e
 *
 * Needs PostgreSQL (docker compose up -d db). Builds the web app, starts the
 * demo server on port 3100 with a fresh database, and drives a real browser.
 * On Windows it uses the installed Microsoft Edge; elsewhere Playwright's own
 * Chromium (npx playwright install chromium). Override with PW_CHANNEL.
 */

import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3100);
const channel = process.env.PW_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    ...(channel && { channel }),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...(channel && { channel }) }, testIgnore: /mobile/ },
    // Runs after the desktop tests, which set up the business it logs in to.
    { name: 'mobile', use: { ...devices['Pixel 7'], ...(channel && { channel }) }, testMatch: /mobile/, dependencies: ['desktop'] },
  ],
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning e2e/server.ts',
    url: `http://localhost:${port}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

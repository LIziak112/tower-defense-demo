import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4172';

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL,
    launchOptions: { executablePath: process.env.PW_CHROMIUM },
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4172 --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});

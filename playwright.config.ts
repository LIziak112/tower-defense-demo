import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173/';

// 只收 e2e 用例；vitest 单测（tests/runtime、tests/content）由 npm run test 负责
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  use: {
    baseURL,
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

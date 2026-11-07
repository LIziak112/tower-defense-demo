import { test, expect } from '@playwright/test';

test('gameplay screenshot', async ({ page }) => {
  await page.goto('http://localhost:4173/?skiplobby');
  await page.waitForSelector('#board', { state: 'visible' });
  // wait a bit for rendering
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'D3-playing-1280x720.png' });
  
  // Try to start wave
  const startBtn = await page.$('#start-wave');
  if (startBtn) await startBtn.click();
  
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'D3-wave-1280x720.png' });
});

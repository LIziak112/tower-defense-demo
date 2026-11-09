import { expect, test } from '@playwright/test';

test('places a tower and starts the first wave', async ({ page }) => {
  await page.goto('/?debug');
  const stats = page.locator('#hud .stats');
  await expect(stats).toContainText('金币 120');

  await page.locator('#board').click({ position: { x: 28, y: 28 } });
  await expect(stats).toContainText('金币 60');
  await expect(page.locator('#debug')).toContainText('towers=1');

  const startWave = page.locator('#start-wave');
  await startWave.click();
  await expect(startWave).toBeDisabled();
  await expect(page.locator('#debug')).toContainText(/enemies=[1-9]/);
});

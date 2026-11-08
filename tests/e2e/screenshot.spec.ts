import { test, expect, type Page } from '@playwright/test';

const GRID_W = 12, GRID_H = 9, TOWER_COST = 60;

async function gold(page: Page) {
  return Number(((await page.textContent('#hud')) ?? '').match(/金币 (\d+)/)![1]);
}
async function cell(page: Page, cx: number, cy: number) {
  const r = (await page.locator('#board').boundingBox())!;
  return { x: r.x + ((cx + 0.5) / GRID_W) * r.width, y: r.y + ((cy + 0.5) / GRID_H) * r.height };
}

for (const [w, h] of [[1280, 720], [1920, 1080], [390, 844]] as const) {
  test(`建塔并打完一波 @${w}x${h}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: w, height: h });
    await page.goto('?skiplobby');
    await page.waitForSelector('#board', { state: 'visible' });

    const g0 = await gold(page);
    const c = await cell(page, 1, 0);
    await page.mouse.click(c.x, c.y);
    await expect.poll(() => gold(page)).toBe(g0 - TOWER_COST);
    await page.screenshot({ path: `docs/screens/build-${w}x${h}.png` });

    await page.click('#start-wave');
    await expect(page.locator('#start-wave')).toBeDisabled();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `docs/screens/wave-${w}x${h}.png` });
    await expect(page.locator('#start-wave')).toBeEnabled({ timeout: 150_000 });
    await page.screenshot({ path: `docs/screens/wave-done-${w}x${h}.png` });

    expect(errors).toEqual([]);
  });
}

test('触控连续点触每次只建一座塔 @390x844', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto('?skiplobby&debug');
  await page.waitForSelector('#board', { state: 'visible' });
  const before = await gold(page);
  for (let i = 0; i < 10; i++) await page.keyboard.press('g');
  await expect.poll(() => gold(page)).toBeGreaterThan(before + 5 * TOWER_COST);
  let g = await gold(page);
  for (const cx of [1, 2, 3, 5, 6]) {
    const c = await cell(page, cx, 0);
    await page.touchscreen.tap(c.x, c.y);
    await expect.poll(() => gold(page)).toBe(g - TOWER_COST);
    g -= TOWER_COST;
  }
  await page.screenshot({ path: 'docs/screens/touch-repeat-390x844.png' });
  await ctx.close();
});

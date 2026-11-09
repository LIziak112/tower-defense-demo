import { expect, test, type Page } from '@playwright/test';

async function tile(page: Page, x: number, y: number) {
  const board = await page.locator('#board').boundingBox();
  if (!board) throw new Error('Board is hidden');
  return { x: board.x + (x + 0.5) * board.width / 12, y: board.y + (y + 0.5) * board.height / 9 };
}

test('tactical pause, five-state build, targeting, and wave countdown', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('?skiplobby');
  const board = page.locator('#board');
  const card = page.locator('button[data-tower="crossbow"]');
  await expect(board).toHaveAttribute('data-build-state', 'idle');
  await expect(board).toHaveCSS('cursor', 'default');
  const good = await tile(page, 1, 0);
  await page.mouse.click(good.x, good.y);
  expect(await page.evaluate(() => (window as any).__td.state.towers.length)).toBe(0);
  await expect(card).toHaveAttribute('aria-pressed', 'false');
  await card.click();
  await expect(board).toHaveAttribute('data-build-state', 'selected');
  await expect(board).toHaveCSS('cursor', 'crosshair');
  await page.keyboard.press('Space');
  await expect(page.locator('#td-pause')).toHaveAttribute('aria-pressed', 'true');
  const tick = await page.evaluate(() => (window as any).__td.state.tick);
  const blocked = await tile(page, 2, 1);
  await page.mouse.move(blocked.x, blocked.y);
  await expect(board).toHaveAttribute('data-build-state', 'invalid');
  await page.mouse.click(blocked.x, blocked.y);
  await expect(page.getByRole('status').filter({ hasText: '这里不能建塔' })).toBeVisible();
  await page.mouse.move(good.x, good.y);
  await expect(board).toHaveAttribute('data-build-state', 'valid');
  await page.evaluate(() => {
    let started = 0;
    document.addEventListener('click', () => { started = performance.now(); }, { capture: true, once: true });
    document.addEventListener('click', () => { (window as any).__buildResponse = performance.now() - started; }, { once: true });
  });
  await page.mouse.click(good.x, good.y);
  await expect(board).toHaveAttribute('data-build-state', 'confirmed');
  await expect(board).toHaveCSS('cursor', 'default');
  await expect(card).toHaveAttribute('aria-pressed', 'false');
  const responseMs = await page.evaluate(() => (window as any).__buildResponse as number);
  console.log('Build click handler', responseMs, 'ms');
  expect(responseMs).toBeLessThan(16);
  await page.mouse.click(good.x, good.y);
  await page.locator('#td-upgrade').click();
  await page.locator('[data-targeting="nearest"]').click();
  expect(await page.evaluate(() => {
    const { tick, towers } = (window as any).__td.state;
    return { tick, level: towers[0].level, targeting: towers[0].targeting };
  })).toEqual({ tick, level: 2, targeting: 'nearest' });
  await page.keyboard.press('Escape');
  await expect(board).toHaveAttribute('data-build-state', 'idle');
  await page.getByRole('button', { name: '3×', exact: true }).click();
  await page.keyboard.press('Space');
  await expect(page.locator('#td-pause')).toHaveAttribute('aria-pressed', 'false');
  const marker = page.locator('#td-wave-marker');
  await marker.hover();
  await expect(page.getByRole('tooltip')).toContainText('提前开波');
  await marker.click();
  await expect(marker).toBeHidden();
  await expect(page.locator('#start-wave')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('settings persist key bindings and render resolution', async ({ page }) => {
  await page.goto('?skiplobby');
  await page.locator('#td-settings').click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-action="pause"]').click();
  await page.keyboard.press('KeyK');
  await dialog.getByLabel('渲染分辨率').selectOption('1280x720');
  await dialog.getByRole('button', { name: '完成' }).click();
  await page.reload();
  await page.keyboard.press('KeyK');
  await expect(page.locator('#td-pause')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#board')).toHaveAttribute('height', '720');
});

test('edge snapping and card drag place once, right click cancels a pending drag', async ({ page }) => {
  await page.goto('?skiplobby');
  const board = page.locator('#board');
  const box = (await board.boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + x * box.width / 12, y: box.y + y * box.height / 9 });
  const card = page.locator('button[data-tower="crossbow"]');
  await card.click();
  const edge = at(2.5, 1.02);
  await page.mouse.move(edge.x, edge.y);
  await expect(board).toHaveAttribute('data-build-state', 'valid');
  await page.mouse.click(edge.x, edge.y);
  const cells = () => page.evaluate(() => (window as any).__td.state.towers.map((tower: any) => [tower.cx, tower.cy]));
  expect(await cells()).toEqual([[2, 0]]);
  async function dragTo(x: number, y: number) {
    const button = (await card.boundingBox())!, target = at(x + 0.5, y + 0.5);
    await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
  }
  await dragTo(3, 0);
  await page.mouse.up();
  expect(await cells()).toEqual([[2, 0], [3, 0]]);
  await dragTo(4, 0);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.mouse.up();
  await expect(board).toHaveAttribute('data-build-state', 'idle');
  expect(await cells()).toEqual([[2, 0], [3, 0]]);
});

test('zoom preserves the cell under the pointer and threats cancel fast forward', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('?skiplobby');
  await page.locator('button[data-tower="crossbow"]').click();
  const cell = await tile(page, 2, 0);
  await page.mouse.move(cell.x, cell.y);
  await page.mouse.wheel(0, -480);
  await page.waitForTimeout(100);
  await page.mouse.click(cell.x, cell.y);
  expect(await page.evaluate(() => {
    const t = (window as any).__td.state.towers[0];
    return t && [t.cx, t.cy];
  })).toEqual([2, 0]);
  await page.locator('#start-wave').click();
  await expect.poll(() => page.evaluate(() => (window as any).__td.state.enemies.length)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '3×', exact: true }).click();
  await page.evaluate(() => {
    const state = (window as any).__td.state;
    state.enemies[0].progress = Math.floor(state.path_len * 0.9);
  });
  await expect(page.getByRole('button', { name: '1×', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('150 enemies and 50 simultaneously firing towers stay within the tick budget', async ({ page }) => {
  await page.goto('?debug&stress&notactical');
  await expect.poll(() => page.evaluate(() => (window as any).__td?.state.enemies.length), { timeout: 15_000 }).toBe(150);
  expect(await page.evaluate(() => (window as any).__td.state.towers.length)).toBe(50);
  await page.evaluate(() => (window as any).__td.metrics.reset());
  await expect.poll(() => page.evaluate(() => (window as any).__td.metrics.read().tickMs.count), { timeout: 15_000 }).toBeGreaterThanOrEqual(120);
  const metrics = await page.evaluate(() => (window as any).__td.metrics.read());
  console.log('Stress benchmark', JSON.stringify(metrics));
  expect(metrics.maxAttacks).toBe(50);
  expect(metrics.tickMs.p95).toBeLessThan(8);
  expect(metrics.frameWorkMs.p95).toBeLessThan(8);
  expect(metrics.frameMs.p95).toBeLessThanOrEqual(1000 / 60);
});

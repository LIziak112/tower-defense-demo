import { test, expect, type Page, type Frame } from '@playwright/test';

// 模拟 Hikos 宿主（krowworker web/hikos/src/addons/arcade.js 的最小复刻）：同源页里一个 sandbox="allow-scripts" 的 iframe，
// 只认 e.source === frame.contentWindow，收到 td:ready 回 hikos:context；把游戏发来的消息记在 window.__msgs。
const HOST_PATH = '/__hikos-host.html';
const GAME_QUERY = 'v=1&skin=union-atlas-3d&accent=a72e25&bg=f2ebdd&ink=393e38&theme=day&lang=zh&skiplobby';
const HOST_HTML = `<!DOCTYPE html><html><body style="margin:0">
<div id="stage" style="width:960px;height:600px"><iframe id="game" sandbox="allow-scripts" referrerpolicy="strict-origin-when-cross-origin" style="width:100%;height:100%;border:0"></iframe></div>
<script>
  const frame = document.getElementById('game');
  window.__msgs = [];
  window.__send = (m) => frame.contentWindow.postMessage(m, '*');
  addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    window.__msgs.push(e.data);
    if (e.data && e.data.type === 'td:ready') window.__send({ type: 'hikos:context', v: 1, skin: 'union-atlas-3d', name: { zh: '共和国 · 工业沙盘', en: 'Union Industrial Atlas' }, accent: 'a72e25', bg: 'f2ebdd', ink: '393e38', theme: 'day', lang: 'zh', reducedMotion: false });
  });
  frame.src = './?${GAME_QUERY}';
</script></body></html>`;

async function openHost(page: Page): Promise<Frame> {
  await page.route(`**${HOST_PATH}`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HOST_HTML }));
  await page.goto(HOST_PATH);
  const el = await page.waitForSelector('#game');
  const game = (await el.contentFrame())!;
  expect(game).toBeTruthy();
  await game.waitForSelector('#board', { state: 'visible' });
  return game;
}
const msgs = (page: Page) => page.evaluate(() => (window as any).__msgs as { type: string; [k: string]: unknown }[]);
const types = async (page: Page) => (await msgs(page)).map((m) => m.type);
const tick = (game: Frame) => game.evaluate(() => (window as any).__td.state.tick as number);

test('嵌入：首帧后发 td:ready {v:1}，收到 hikos:context 后按宿主皮肤配色、报 td:state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const game = await openHost(page);

  await expect.poll(() => types(page), { timeout: 12_000 }).toContain('td:ready');
  const ready = (await msgs(page)).find((m) => m.type === 'td:ready')!;
  expect(ready.v).toBe(1);
  expect((await types(page)).filter((x) => x === 'td:ready')).toHaveLength(1);

  // 游戏侧确认是嵌入态、认出宿主源、吃到了 context（显示名只有 hikos:context 带）
  await expect.poll(() => game.evaluate(() => (window as any).__td.host.context.name?.zh)).toBe('共和国 · 工业沙盘');
  const host = await game.evaluate(() => (window as any).__td.host);
  expect(host.embedded).toBe(true);
  expect(host.origin).toBe(new URL(page.url()).origin);
  expect(host.context).toMatchObject({ skin: 'union-atlas-3d', accent: '#a72e25', bg: '#f2ebdd', ink: '#393e38', theme: 'day', lang: 'zh' });

  // 配色落到 CSS 变量与画布：accent / bg / ink 是宿主给的
  const vars = await game.evaluate(() => { const s = getComputedStyle(document.documentElement); return ['--td-accent', '--td-bg', '--td-ink'].map((k) => s.getPropertyValue(k).trim()); });
  expect(vars).toEqual(['#a72e25', '#f2ebdd', '#393e38']);
  await expect(game.locator('#theme-select')).toHaveCount(0);   // 嵌入时没有主题下拉
  await expect(game.locator('#td-exit')).toBeVisible();

  // skiplobby 直接进战局 → playing
  await expect.poll(() => types(page)).toContain('td:state');
  const states = (await msgs(page)).filter((m) => m.type === 'td:state').map((m) => m.state);
  expect(states[states.length - 1]).toBe('playing');
  await page.screenshot({ path: 'docs/screens/hikos-embed-union-atlas.png' });
  expect(errors).toEqual([]);
});

test('嵌入：hikos:visibility=false 冻结模拟并报 paused，true 后恢复；语言切换随 hikos:context 生效', async ({ page }) => {
  const game = await openHost(page);
  await expect.poll(() => types(page), { timeout: 12_000 }).toContain('td:ready');
  await game.click('#start-wave');
  await expect.poll(() => tick(game)).toBeGreaterThan(0);

  await page.evaluate(() => (window as any).__send({ type: 'hikos:visibility', visible: false }));
  await expect.poll(async () => (await msgs(page)).filter((m) => m.type === 'td:state').pop()?.state).toBe('paused');
  const t0 = await tick(game);
  await page.waitForTimeout(600);
  expect(await tick(game)).toBe(t0);   // 没有 tick 前进

  await page.evaluate(() => (window as any).__send({ type: 'hikos:visibility', visible: true }));
  await expect.poll(async () => (await msgs(page)).filter((m) => m.type === 'td:state').pop()?.state).toBe('playing');
  await expect.poll(() => tick(game)).toBeGreaterThan(t0);

  // 运行中切语言 / 皮肤：HUD 文案与配色跟着换（允许下一局生效的是精灵集，配色与文案即时）
  await page.evaluate(() => (window as any).__send({ type: 'hikos:context', v: 1, skin: 'gothic-cathedral-3d', accent: 'e4c596', bg: '182333', ink: 'e6e1da', theme: 'night', lang: 'en' }));
  await expect(game.locator('#hud')).toContainText('Gold');
  await expect.poll(() => game.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--td-accent').trim())).toBe('#e4c596');
  expect(await game.evaluate(() => document.documentElement.dataset.theme)).toBe('night');
  await page.screenshot({ path: 'docs/screens/hikos-embed-gothic-en.png' });
});

test('嵌入：点「退出」发 td:exit；宿主以外的消息不被当成宿主', async ({ page }) => {
  const game = await openHost(page);
  await expect.poll(() => types(page), { timeout: 12_000 }).toContain('td:ready');
  // 游戏自己给自己 postMessage（source 是自己不是 parent）：必须被忽略，lang 不变
  await game.evaluate(() => window.postMessage({ type: 'hikos:context', lang: 'en' }, '*'));
  await page.waitForTimeout(300);
  expect(await game.evaluate(() => (window as any).__td.host.context.lang)).toBe('zh');

  await game.click('#td-exit');
  await expect.poll(() => types(page)).toContain('td:exit');
});

test('独立打开（不在 iframe 里）：不发消息、保留主题下拉、?palette= 仍可选内置配色', async ({ page }) => {
  await page.goto('?skiplobby&palette=neon');
  await page.waitForSelector('#board', { state: 'visible' });
  const host = await page.evaluate(() => (window as any).__td.host);
  expect(host.embedded).toBe(false);
  expect(host.palette).toBe('neon');
  await expect(page.locator('#theme-select')).toHaveCount(1);
  await expect(page.locator('#td-exit')).toHaveCount(0);
});

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
  expect((await types(page))[0]).toBe('td:ready');   // §1.6：第一条出站消息必须是 td:ready

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
  await expect(game.locator('#hud')).toContainText('CP');
  await expect(game.locator('#hud')).toContainText('Base');
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

test('大厅 #25801：四款皮肤原生道路80%-100%/起终点原生建筑/车人小兵与清空闲散车流/全界面无溢出遮挡/去金币统一CP胜+10败-10真实结算', async ({ page }) => {
  const settleHostHtml = `<!DOCTYPE html><html><body style="margin:0">
<div id="stage" style="width:1440px;height:856px"><iframe id="game" sandbox="allow-scripts" referrerpolicy="strict-origin-when-cross-origin" style="width:100%;height:100%;border:0"></iframe></div>
<script>
  const frame = document.getElementById('game');
  window.__msgs = [];
  window.__wallet = { balanceCp: 1000, netCp: 0, wonCount: 0, lostCount: 0, settled: {} };
  window.__send = (m) => frame.contentWindow.postMessage(m, '*');
  addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    window.__msgs.push(m);
    if (m && m.type === 'td:ready') {
      window.__send({
        type: 'hikos:context', v: 1, skin: 'union-atlas-3d',
        name: { zh: '共和国 · 工业沙盘', en: 'Union Industrial Atlas' },
        accent: 'a72e25', bg: 'f2ebdd', ink: '393e38', theme: 'day', lang: 'zh',
        reducedMotion: false, insitu: true,
        wallet: { balanceCp: window.__wallet.balanceCp, netCp: 0, wonCount: 0, lostCount: 0 },
        map: {
          skin: 'union-atlas-3d', layout: 'river-grid', w: 1440, h: 856,
          azimuth: -0.38, pitch: 0.78, zoom: 1.0,
          center: { x: 748, y: 410 },
          home: { key: 'home', kind: 'landmark', label: '中央工业母星', x: 860, y: 460 },
          spawnBuilding: { key: 'channel:mother:west', kind: 'entity', label: '西翼工业厂房', x: 420, y: 290 },
          baseBuilding: { key: 'home', kind: 'landmark', label: '中央工业母星', x: 860, y: 460 },
          ambientTrafficCleared: true,
          landmarks: [{ key: 'home', kind: 'landmark', label: '中央工业母星', x: 860, y: 460 }],
          nodes: [{ key: 'channel:mother:west', kind: 'entity', label: '西翼工业厂房', x: 420, y: 290 }],
        },
      });
    } else if (m && m.type === 'td:settle:request') {
      const id = String(m.matchId || '');
      const outcome = m.outcome === 'lost' ? 'lost' : 'won';
      const deltaCp = outcome === 'won' ? 10 : -10;
      if (window.__wallet.settled[id]) {
        const prev = window.__wallet.settled[id];
        window.__send({ ...prev, idempotent: true, appliedCp: 0 });
      } else {
        window.__wallet.balanceCp = Math.max(0, window.__wallet.balanceCp + deltaCp);
        window.__wallet.netCp += deltaCp;
        if (outcome === 'won') window.__wallet.wonCount++; else window.__wallet.lostCount++;
        const rep = {
          type: 'hikos:settle:reply', v: 1, matchId: id, ok: true,
          outcome, deltaCp, appliedCp: deltaCp,
          balanceCp: window.__wallet.balanceCp,
          netCp: window.__wallet.netCp,
          wonCount: window.__wallet.wonCount,
          lostCount: window.__wallet.lostCount,
          idempotent: false,
        };
        window.__wallet.settled[id] = rep;
        window.__send(rep);
      }
    }
  });
  frame.src = './?v=1&skin=union-atlas-3d&accent=a72e25&bg=f2ebdd&ink=393e38&theme=day&lang=zh&debug=1';
</script></body></html>`;

  await page.setViewportSize({ width: 1440, height: 856 });
  await page.route('**/__settle-host.html', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: settleHostHtml }));
  await page.goto('/__settle-host.html');
  const el = await page.waitForSelector('#game');
  const game = (await el.contentFrame())!;
  await game.waitForSelector('#board', { state: 'visible' });

  const skins = [
    { skin: 'union-atlas-3d', layout: 'river-grid', accent: 'a72e25', bg: 'f2ebdd', ink: '393e38', theme: 'day', spawnLabel: '西翼工业厂房', baseLabel: '中央工业母星' },
    { skin: 'metropolis-riverside-3d', layout: 'district-grid', accent: '356d73', bg: 'e8ede7', ink: '354e52', theme: 'day', spawnLabel: '河岸北翼街坊', baseLabel: '河岸中枢大厦' },
    { skin: 'gothic-cathedral-3d', layout: 'concentric-town', accent: 'e4c596', bg: '182333', ink: 'e6e1da', theme: 'night', spawnLabel: '外环钟楼门', baseLabel: '圣堂主座' },
    { skin: 'harbor-district-3d', layout: 'quays', accent: '256e7c', bg: 'e0e9e7', ink: '254452', theme: 'day', spawnLabel: '外港栈桥亭', baseLabel: '海事总署灯塔' },
  ];

  for (const sk of skins) {
    await page.evaluate((s) => (window as any).__send({
      type: 'hikos:context', v: 1, skin: s.skin, accent: s.accent, bg: s.bg, ink: s.ink, theme: s.theme, lang: 'zh',
      insitu: true,
      map: {
        skin: s.skin, layout: s.layout, w: 1440, h: 856,
        azimuth: s.skin === 'gothic-cathedral-3d' ? -2.55 : -0.38, pitch: 0.78, zoom: 1.0,
        center: { x: 748, y: 410 },
        home: { key: 'home', kind: 'landmark', label: s.baseLabel, x: 860, y: 460 },
        spawnBuilding: { key: 'channel:mother:spawn', kind: 'entity', label: s.spawnLabel, x: 420, y: 290 },
        baseBuilding: { key: 'home', kind: 'landmark', label: s.baseLabel, x: 860, y: 460 },
        ambientTrafficCleared: true,
        landmarks: [{ key: 'home', kind: 'landmark', label: s.baseLabel, x: 860, y: 460 }],
        nodes: [{ key: 'channel:mother:spawn', kind: 'entity', label: s.spawnLabel, x: 420, y: 290 }],
      },
    }), sk);

    await expect.poll(() => game.evaluate(() => (window as any).__td.spatial?.roadPlan?.endBuilding?.label)).toBe(sk.baseLabel);
    const sp = await game.evaluate(() => {
      const s = (window as any).__td.spatial;
      const hud = document.getElementById('hud')!.getBoundingClientRect();
      const adv = document.getElementById('advisor')!.getBoundingClientRect();
      const lob = document.getElementById('lobby')!.getBoundingClientRect();
      return {
        nativeRatio: s.roadPlan.nativeRatio,
        bridgeRatio: s.roadPlan.bridgeRatio,
        startLabel: s.roadPlan.startBuilding.label,
        endLabel: s.roadPlan.endBuilding.label,
        ambientTrafficCleared: s.ambientTrafficCleared,
        enemyModels: s.enemyModels,
        hudRect: { top: hud.top, bottom: hud.bottom, left: hud.left, right: hud.right },
        advRect: { top: adv.top, bottom: adv.bottom, left: adv.left, right: adv.right },
        lobRect: { top: lob.top, bottom: lob.bottom, left: lob.left, right: lob.right },
        bodyText: document.body.innerText,
      };
    });
    expect(sp.nativeRatio).toBeGreaterThanOrEqual(0.8);
    expect(sp.nativeRatio).toBeLessThanOrEqual(1.0);
    expect(sp.bridgeRatio).toBeLessThanOrEqual(0.2);
    expect(sp.startLabel).toBe(sk.spawnLabel);
    expect(sp.endLabel).toBe(sk.baseLabel);
    expect(sp.ambientTrafficCleared).toBe(true);
    expect(sp.enemyModels.length).toBeGreaterThanOrEqual(1);
    expect(sp.enemyModels[0].vfx).toEqual(['auraRing', 'wakeTrail', 'battleCrest']);
    expect(sp.bodyText).not.toContain('金币');
    expect(sp.bodyText).toContain('CP');
    // 左右面板互不重叠、均在顶部 HUD 之下
    expect(sp.advRect.top).toBeGreaterThanOrEqual(sp.hudRect.bottom - 1);
    expect(sp.advRect.right).toBeLessThan(sp.lobRect.left);
  }

  // 验证胜利 +10 CP 与失败 -10 CP 真实结算及同局幂等防重
  await game.evaluate(() => (window as any).__td.settleNow('won'));
  await expect.poll(() => game.evaluate(() => (window as any).__td.cp.lastSettlement?.status)).toBe('settled');
  const winCp = await game.evaluate(() => (window as any).__td.cp);
  expect(winCp.lastSettlement).toMatchObject({ outcome: 'won', deltaCp: 10, appliedCp: 10, balanceCp: 1010, status: 'settled' });
  await expect(game.locator('#td-cp-settlement')).toContainText('结算 +10 CP · 账户 1010 CP');

  // 同一 matchId 重复请求宿主结算：宿主返回 idempotent: true, balanceCp 保持 1010 不重复加分
  const winMatchId = winCp.lastSettlement.matchId;
  await game.evaluate((mid) => window.parent.postMessage({ type: 'td:settle:request', v: 1, matchId: mid, outcome: 'won', deltaCp: 10 }, '*'), winMatchId);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).__wallet.balanceCp)).toBe(1010);

  // 重开一局并触发失败 -10 CP 结算：账户从 1010 CP 扣减为 1000 CP
  await game.click('#start-wave'); // restart
  await game.click('#td-direct-play');
  await game.evaluate(() => (window as any).__td.settleNow('lost'));
  await expect.poll(() => game.evaluate(() => (window as any).__td.cp.lastSettlement?.status)).toBe('settled');
  const lossCp = await game.evaluate(() => (window as any).__td.cp);
  expect(lossCp.lastSettlement).toMatchObject({ outcome: 'lost', deltaCp: -10, appliedCp: -10, balanceCp: 1000, status: 'settled' });
  await expect(game.locator('#td-cp-settlement')).toContainText('结算 -10 CP · 账户 1000 CP');
});

test('大厅 #26153：四款皮肤文化设定命名、专属攻防打击动效+减弱动态开关、战前参谋敕令三选一+兵种克制+路线分流+危机词缀', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 856 });
  const hostPageHtml = `<!DOCTYPE html><html><body style="margin:0">
<div id="stage" style="width:1440px;height:856px"><iframe id="game" sandbox="allow-scripts" referrerpolicy="strict-origin-when-cross-origin" style="width:100%;height:100%;border:0"></iframe></div>
<script>
  const frame = document.getElementById('game');
  window.__send = (m) => frame.contentWindow.postMessage(m, '*');
  frame.src = './?v=1&skin=union-atlas-3d&accent=a72e25&bg=f2ebdd&ink=393e38&theme=day&lang=zh&insitu=1&debug=1';
</script></body></html>`;

  await page.route('**/__cultural-vfx-host.html', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: hostPageHtml }));
  await page.goto('/__cultural-vfx-host.html');
  const el = await page.waitForSelector('#game');
  const game = (await el.contentFrame())!;
  await game.waitForSelector('#board', { state: 'visible' });

  const skinExpectations = [
    {
      skin: 'union-atlas-3d', accent: 'a72e25', bg: 'f2ebdd', ink: '393e38', theme: 'day',
      council: '星院参谋庭', advisor: '星院首席参谋', tower0: '脉冲棱镜塔', enemy0: '相位护盾巡逻机', style: 'prism_beam',
    },
    {
      skin: 'metropolis-riverside-3d', accent: '356d73', bg: 'e8ede7', ink: '354e52', theme: 'day',
      council: '市政防务调度中心', advisor: '市政智控调度总监', tower0: '电磁拦阻桩', enemy0: '磁盾巡检机器人', style: 'emp_arc',
    },
    {
      skin: 'gothic-cathedral-3d', accent: 'e4c596', bg: '182333', ink: 'e6e1da', theme: 'night',
      council: '圣堂守夜审判庭', advisor: '守夜大审判官', tower0: '圣光钟楼', enemy0: '黯影障壁食尸鬼', style: 'holy_lance',
    },
    {
      skin: 'harbor-district-3d', accent: '256e7c', bg: 'e0e9e7', ink: '254452', theme: 'day',
      council: '港务海事防卫局', advisor: '海事防卫总领航员', tower0: '防波堤速射炮', enemy0: '气垫护盾驳船', style: 'naval_shell',
    },
  ];

  for (const exp of skinExpectations) {
    await page.evaluate((s) => (window as any).__send({
      type: 'hikos:context', v: 1, skin: s.skin, accent: s.accent, bg: s.bg, ink: s.ink, theme: s.theme, lang: 'zh',
      reducedMotion: false, insitu: true,
      map: { skin: s.skin, layout: 'river-grid', w: 1440, h: 856, azimuth: -0.38, pitch: 0.78, zoom: 1.0 },
    }), exp);

    await expect(game.locator('#lobby-council-title')).toHaveText(exp.council);
    await expect(game.locator('#hud')).toContainText(exp.tower0);
    await expect(game.locator('#hud')).toContainText(exp.enemy0);

    const snap = await game.evaluate(() => ({
      cultural: (window as any).__td.cultural,
      vfx: (window as any).__td.vfx,
      tactics: (window as any).__td.tactics,
      splitCount: (window as any).__td.spatial?.roadPlan?.splitBranchSegments?.length ?? 0,
      bodyText: document.body.innerText,
    }));
    expect(snap.cultural.councilTitle).toBe(exp.council);
    expect(snap.cultural.advisorRole).toBe(exp.advisor);
    expect(snap.cultural.towers[0].name).toBe(exp.tower0);
    expect(snap.cultural.enemies[0].name).toBe(exp.enemy0);
    expect(snap.vfx.projectileStyle).toBe(exp.style);
    expect(snap.tactics.edicts).toHaveLength(3);
    expect(snap.tactics.affixes).toHaveLength(3);
    expect(snap.splitCount).toBeGreaterThanOrEqual(2);
    expect(snap.bodyText).not.toMatch(/弩车|投石车|步卒|轻骑/);
  }

  // 验证战前参谋敕令三选一与危机挑战词缀交互
  await game.click('#lobby-edicts button[data-edict="bounty_lure"]');
  await game.click('#lobby-affixes button[data-affix="emp_fog"]');
  await game.click('#lobby-affixes button[data-affix="vanguard_surge"]');
  await expect(game.locator('#td-crisis-rating')).toContainText('R2');
  const tacticsAfter = await game.evaluate(() => ({
    tactics: (window as any).__td.tactics,
    gold: (window as any).__td.state.gold,
  }));
  expect(tacticsAfter.tactics.selectedEdictId).toBe('bounty_lure');
  expect(tacticsAfter.tactics.activeAffixIds).toEqual(['emp_fog', 'vanguard_surge']);
  expect(tacticsAfter.gold).toBe(155); // 120 + 35 CP 诱敌补贴

  // 验证攻防打击动效（标准模式 vs 减弱动态模式）
  const vfxFull = await game.evaluate(() => {
    (window as any).__td.setReducedMotion(false);
    return (window as any).__td.triggerDemoCombatVfx();
  });
  expect(vfxFull.reducedMotion).toBe(false);
  expect(vfxFull.activeShots).toBeGreaterThan(0);
  expect(vfxFull.activePopups).toBeGreaterThan(0);
  expect(vfxFull.activeRipples).toBeGreaterThan(0);
  expect(vfxFull.screenShaking).toBe(true);
  expect(vfxFull.stats.shotsFired).toBeGreaterThan(0);
  expect(vfxFull.stats.screenShakes).toBeGreaterThan(0);

  // 切换减弱动态开关（#td-reduced-motion）：屏震与 Hit-stop 立即关闭
  await game.click('#td-reduced-motion');
  await expect(game.locator('#td-reduced-motion')).toHaveAttribute('data-reduced-motion', 'true');
  const shakesBeforeReduced = vfxFull.stats.screenShakes;
  const vfxReduced = await game.evaluate(() => (window as any).__td.triggerDemoCombatVfx());
  expect(vfxReduced.reducedMotion).toBe(true);
  expect(vfxReduced.screenShaking).toBe(false);
  expect(vfxReduced.hitStopping).toBe(false);
  expect(vfxReduced.stats.screenShakes).toBe(shakesBeforeReduced);
});

test('大厅 #26188 / #26210：顶栏避让与专属图标徽章、真实CP同步去990兜底、Retina DPR高清渲染、1000关战役与6兵种、环城路网拓扑及10局内存释放', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 856 });
  const hostHtml = `<!DOCTYPE html><html><body style="margin:0">
<div id="stage" style="width:1440px;height:856px"><iframe id="game" sandbox="allow-scripts" referrerpolicy="strict-origin-when-cross-origin" style="width:100%;height:100%;border:0"></iframe></div>
<script>
  const frame = document.getElementById('game');
  window.__send = (m) => frame.contentWindow.postMessage(m, '*');
  frame.src = './?v=1&skin=gothic-cathedral-3d&accent=e4c596&bg=182333&ink=e6e1da&theme=night&lang=zh&insitu=1&debug=1';
</script></body></html>`;

  await page.route('**/__campaign-host.html', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: hostHtml }));
  await page.goto('/__campaign-host.html');
  const el = await page.waitForSelector('#game');
  const game = (await el.contentFrame())!;
  await game.waitForSelector('#board', { state: 'visible' });

  // 推送真实大额钱包余额 933474663 CP 与同心环城地图
  await page.evaluate(() => (window as any).__send({
    type: 'hikos:context', v: 1, skin: 'gothic-cathedral-3d', accent: 'e4c596', bg: '182333', ink: 'e6e1da', theme: 'night', lang: 'zh',
    insitu: true,
    wallet: { balanceCp: 933474663, netCp: 0, wonCount: 0, lostCount: 0 },
    map: {
      skin: 'gothic-cathedral-3d', layout: 'concentric-town', w: 1440, h: 856,
      azimuth: -2.55, pitch: 0.65, zoom: 1.0,
      home: { key: 'home', kind: 'landmark', label: '圣堂主座', x: 740, y: 430 },
      spawnBuilding: { key: 'belfry', kind: 'entity', label: '外环钟楼门', x: 460, y: 290 },
      baseBuilding: { key: 'home', kind: 'landmark', label: '圣堂主座', x: 740, y: 430 },
      ambientTrafficCleared: true,
      landmarks: [{ key: 'home', kind: 'landmark', label: '圣堂主座', x: 740, y: 430 }],
      nodes: [{ key: 'belfry', kind: 'entity', label: '外环钟楼门', x: 460, y: 290 }],
    },
  }));

  await expect(game.locator('#td-campaign-level')).toContainText('1/1000');
  await expect(game.locator('#td-cp-settlement')).toContainText('933474663 CP');

  // 结算负局：验证真实余额 933474663 - 10 = 933474653 CP（绝不出现 990 CP）
  const lossSettle = await game.evaluate(() => (window as any).__td.settleNow('lost'));
  expect(lossSettle.balanceCp).toBe(933474653);
  await expect(game.locator('#td-cp-settlement')).toContainText('933474653 CP');
  await expect(game.locator('#td-cp-settlement')).not.toContainText('990 CP');

  // 推进到第 2 关战役：验证 6 种兵种、同心环城真实路网折点数 >= 12、终点锚定 home
  const st2 = await game.evaluate(() => (window as any).__td.startCampaignLevel(2, 'gothic-cathedral-3d'));
  expect(st2.level).toBe(2);
  expect(st2.maxLevel).toBe(1000);
  expect(st2.enemyTypes).toBeGreaterThanOrEqual(6);
  await expect(game.locator('#td-campaign-level')).toContainText('2/1000');

  const audit = await game.evaluate(() => ({
    spatial: (window as any).__td.spatial,
    balance: (window as any).__td.runBalanceAudit(),
    mem: (window as any).__td.runMemoryBenchmark(10),
    assets3d: (window as any).__td.assets3d,
  }));
  expect(audit.spatial.waypoints.length).toBeGreaterThanOrEqual(12);
  expect(audit.spatial.roadPlan.endBuilding.key).toBe('home');
  expect(audit.balance.stages).toHaveLength(3);
  expect(audit.balance.stages.every((s: any) => s.reasonablePlacement.result === 'won' && s.poorPlacement.result === 'lost')).toBe(true);
  expect(audit.mem.rounds).toBe(10);
  expect(audit.mem.allZeroAfterCleanup).toBe(true);
  expect(audit.assets3d).toHaveLength(4);
});

import { test, expect, type Page, type Frame } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 世界模式（大厅 #27514）端到端：假宿主把四款开放皮肤的**真实几何**（tests/fixtures/world，宿主 battle.map() 原样导出）发给游戏，
// 每次相机变化都推 hikos:camera（与 Hikos 三维引擎同一套正交相机几何），并按引擎原生算法响应 td:camera。
// 假宿主自己在 iframe 下面的画布上用同一个矩阵画出道路——截图里游戏描的路线 / 塔位 / 敌人（?fielddebug）必须压在这些道路上。
const HOST_PATH = '/__hikos-world-host.html';
const loadWorld = (skin: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/world/${skin}.world.json`, import.meta.url)), 'utf8'));

function hostHtml(skin: string, opts: { w?: number; h?: number; query?: string; span?: number } = {}): string {
  const w = opts.w ?? 1024, h = opts.h ?? 662;
  const query = opts.query ?? `v=1&skin=${skin}&accent=a72e25&bg=f2ebdd&ink=393e38&theme=day&lang=zh&skiplobby&fielddebug=1`;
  return `<!DOCTYPE html><html><body style="margin:0;background:#dfe6dc">
<div id="stage" style="position:relative;width:${w}px;height:${h}px;overflow:hidden">
  <canvas id="ground" width="${w}" height="${h}" style="position:absolute;inset:0"></canvas>
  <iframe id="game" sandbox="allow-scripts" referrerpolicy="strict-origin-when-cross-origin" style="position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent" allowtransparency="true"></iframe>
</div>
<script>
  const W = ${w}, H = ${h};
  const frame = document.getElementById('game'), ground = document.getElementById('ground'), g2 = ground.getContext('2d');
  window.__world = ${JSON.stringify(loadWorld(skin))};
  window.__msgs = [];
  window.__camSeq = 0;
  // 与 Hikos 三维引擎同一套相机状态：看点 / 方位角 / 俯仰 / 缩放；正交半高 = span / zoom
  window.__cam = { azimuth: -0.38, pitch: 0.78, zoom: 1, span: ${opts.span ?? 66.2}, focus: [0, 0, 0], minPitch: 0.52, maxPitch: 1.3, minZoom: 0.12, maxZoom: 12 };
  window.__matrix = () => {
    const c = window.__cam, a = c.azimuth, p = c.pitch, ppu = (H * c.zoom) / (2 * c.span), f = c.focus;
    const r = [Math.cos(a), 0, -Math.sin(a)], u = [-Math.sin(a) * Math.sin(p), Math.cos(p), -Math.cos(a) * Math.sin(p)];
    const dot = (v) => v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
    return { ppu, m: [ppu * r[0], ppu * r[1], ppu * r[2], W / 2 - ppu * dot(r), -ppu * u[0], -ppu * u[1], -ppu * u[2], H / 2 + ppu * dot(u), 0, 0, 1, 0, 0, 0, 0, 1] };
  };
  // 宿主自己的投影（不经过游戏）：断言用它当「地图上这一点在屏幕哪里」的真值
  window.__project = (x, y, z) => { const m = window.__matrix().m; return { x: m[0] * x + m[1] * y + m[2] * z + m[3], y: m[4] * x + m[5] * y + m[6] * z + m[7] }; };
  window.__send = (m) => frame.contentWindow.postMessage(m, '*');
  window.__drawGround = () => {
    g2.clearRect(0, 0, W, H);
    g2.lineCap = 'round'; g2.lineJoin = 'round';
    const ppu = window.__matrix().ppu;
    for (const w of window.__world.water || []) { g2.strokeStyle = '#9cc3d6'; g2.lineWidth = Math.max(1, w.w * ppu * 0.8); g2.beginPath(); w.pts.forEach((p, i) => { const q = window.__project(p[0], 0, p[1]); if (i) g2.lineTo(q.x, q.y); else g2.moveTo(q.x, q.y); }); g2.stroke(); }
    const trace = (r) => { g2.beginPath(); r.pts.forEach((p, i) => { const q = window.__project(p[0], p[1], p[2]); if (i) g2.lineTo(q.x, q.y); else g2.moveTo(q.x, q.y); }); g2.stroke(); };
    for (const r of window.__world.roads) { g2.strokeStyle = r.virtual ? 'rgba(120,120,120,.35)' : '#a9aba6'; g2.lineWidth = Math.max(1, r.w * ppu); trace(r); }
    g2.setLineDash([6, 6]);
    for (const r of window.__world.roads) { g2.strokeStyle = 'rgba(255,255,255,.75)'; g2.lineWidth = 1; trace(r); }
    g2.setLineDash([]);
    for (const p of window.__world.places) { const q = window.__project(p.x, 0, p.z); g2.fillStyle = p.kind === 'home' ? '#b5483a' : '#5d6f86'; g2.beginPath(); g2.arc(q.x, q.y, Math.max(2, p.r * ppu * 0.7), 0, Math.PI * 2); g2.fill(); }
  };
  window.__pushCamera = () => {
    const c = window.__cam, k = window.__matrix();
    window.__drawGround();
    window.__send({ type: 'hikos:camera', v: 1, seq: ++window.__camSeq, w: W, h: H, m: k.m, ppu: k.ppu, azimuth: c.azimuth, pitch: c.pitch, zoom: c.zoom });
  };
  window.__setCam = (patch) => { Object.assign(window.__cam, patch); window.__pushCamera(); };
  window.__context = (extra) => ({ type: 'hikos:context', v: 1, skin: '${skin}', name: { zh: '测试皮肤', en: 'Test skin' }, accent: 'a72e25', bg: 'f2ebdd', ink: '393e38', theme: 'day', lang: 'zh', insitu: true,
    advisor: { enabled: false, provider: null }, wallet: { balanceCp: 1000 },
    map: { skin: '${skin}', layout: window.__world.layout, w: W, h: H, azimuth: window.__cam.azimuth, pitch: window.__cam.pitch, zoom: window.__cam.zoom, world: window.__world }, ...(extra || {}) });
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    window.__msgs.push(m);
    if (!m || typeof m !== 'object') return;
    if (m.type === 'td:ready') { window.__send(window.__context()); window.__pushCamera(); }
    if (m.type === 'td:camera') {
      // 引擎原生的同一组算法（runtime.js 的指针 / 滚轮处理）
      const c = window.__cam;
      if (m.kind === 'rotate') { c.azimuth -= m.dx * 0.004; c.pitch = clamp(c.pitch + m.dy * 0.0032, c.minPitch, c.maxPitch); }
      else if (m.kind === 'pan') { const k = c.span * 2 / H / c.zoom; c.focus[0] += (-m.dx * Math.cos(c.azimuth) - m.dy * Math.sin(c.azimuth) / Math.sin(c.pitch)) * k; c.focus[2] += (m.dx * Math.sin(c.azimuth) - m.dy * Math.cos(c.azimuth) / Math.sin(c.pitch)) * k; }
      else if (m.kind === 'zoom') c.zoom = clamp(c.zoom * Math.exp(-clamp(m.dy, -100, 100) * 0.002), c.minZoom, c.maxZoom);
      else if (m.kind === 'pinch') c.zoom = clamp(c.zoom * clamp(m.scale, 0.2, 5), c.minZoom, c.maxZoom);
      else if (m.kind === 'reset') { c.azimuth = -0.38; c.pitch = 0.78; c.zoom = 1; c.focus = [0, 0, 0]; }
      else return;
      window.__pushCamera();
    }
  });
  window.__drawGround();
  frame.src = './?${query}';
</script></body></html>`;
}

async function openHost(page: Page, skin = 'union-atlas-3d', opts: Parameters<typeof hostHtml>[1] = {}): Promise<Frame> {
  await page.setViewportSize({ width: opts.w ?? 1024, height: opts.h ?? 662 });
  await page.route(`**${HOST_PATH}`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: hostHtml(skin, opts) }));
  await page.goto(HOST_PATH);
  const el = await page.waitForSelector('#game');
  const game = (await el.contentFrame())!;
  await game.waitForSelector('#board', { state: 'visible' });
  await expect.poll(() => fieldMsg(page), { timeout: 15_000 }).toBeTruthy();
  await expect.poll(() => game.evaluate(() => !!(window as any).__td.world?.camera)).toBe(true);
  return game;
}
type Msg = { type: string; [k: string]: any };
const msgs = (page: Page) => page.evaluate(() => (window as any).__msgs as Msg[]);
const fieldMsg = async (page: Page) => (await msgs(page)).filter((m) => m.type === 'td:field' && m.id).pop() ?? null;
const lastFrame = async (page: Page) => (await msgs(page)).filter((m) => m.type === 'td:frame').pop() ?? null;
const hostProject = (page: Page, x: number, y: number, z: number) => page.evaluate(([px, py, pz]) => (window as any).__project(px, py, pz), [x, y, z]);
const setCam = (page: Page, patch: Record<string, unknown>) => page.evaluate((p) => (window as any).__setCam(p), patch);
const world = (game: Frame) => game.evaluate(() => { const w = (window as any).__td.world; return w && { id: w.id, unit: w.unit, pads: w.pads, routes: w.routes, hoverPad: w.hoverPad, ringPad: w.ringPad, camera: w.camera, framesSent: w.framesSent }; });
/** 地图上一个塔位在页面上的位置：用宿主自己的矩阵算，不问游戏 */
async function padOnPage(page: Page, game: Frame, pad: number) {
  const w = await world(game);
  const p = w.pads[pad];
  return hostProject(page, p.x, p.y, p.z);
}
/** 游戏页面里这个像素上是不是画布（没被顶栏 / 军师卡 / 议事框盖住） */
const onBoard = (game: Frame, x: number, y: number) => game.evaluate(([px, py]) => document.elementFromPoint(px, py)?.id === 'board', [x, y]);
/** 找一个此刻在画面里、没被游戏界面盖住的空塔位 */
async function freePadInView(page: Page, game: Frame, taken: number[] = []) {
  const w = await world(game);
  const pts = await Promise.all(w.pads.map((p: any) => hostProject(page, p.x, p.y, p.z)));
  for (let i = 0; i < pts.length; i++) {
    if (taken.includes(i) || w.pads[i].occupied) continue;
    const q = pts[i];
    if (q.x < 12 || q.x > 1012 || q.y < 12 || q.y > 650) continue;
    if (!(await onBoard(game, q.x, q.y))) continue;
    return { pad: i, ...q };
  }
  throw new Error('no free pad in view');
}

/** 画面里一个离所有塔位都远、也不在游戏界面底下的空白点 */
async function emptySpot(page: Page, game: Frame) {
  const w = await world(game);
  const pts = await Promise.all(w.pads.map((p: any) => hostProject(page, p.x, p.y, p.z)));
  for (const c of [[1000, 640], [1000, 380], [660, 640], [340, 640], [1000, 200], [820, 520], [520, 300], [700, 420], [420, 560]]) {
    if (pts.every((q: { x: number; y: number }) => Math.hypot(q.x - c[0], q.y - c[1]) > 90) && (await onBoard(game, c[0], c[1]))) return { x: c[0], y: c[1] };
  }
  throw new Error('no empty spot');
}

test('世界模式握手：td:ready 之后发 td:field（真实道路上的路线与塔位，世界坐标），画布上不再有屏幕投影器', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const game = await openHost(page, 'union-atlas-3d', { query: 'v=1&skin=union-atlas-3d&accent=a72e25&bg=f2ebdd&ink=393e38&theme=day&lang=zh&skiplobby&debug=1' });
  const all = await msgs(page);
  expect(all[0].type).toBe('td:ready');
  const field = (await fieldMsg(page))!;
  const src = loadWorld('union-atlas-3d');
  expect(field.v).toBe(1);
  expect(field.skin).toBe('union-atlas-3d');
  expect(field.routes.length).toBeGreaterThanOrEqual(1);
  expect(field.pads.length).toBeGreaterThanOrEqual(8);
  // 路线上的每个折点都落在宿主给的某条真实道路上（入口引道除外）
  const onRoad = (x: number, z: number) => src.roads.some((r: any) => r.pts.some((_: any, i: number) => {
    if (!i) return false;
    const [ax, , az] = r.pts[i - 1], [bx, , bz] = r.pts[i], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    return Math.hypot(x - ax - dx * t, z - az - dz * t) <= r.w / 2 + 0.06;
  }));
  for (const r of field.routes) r.pts.forEach((p: number[], i: number) => {
    const approach = ((r.fl[i] ?? 0) & 1) !== 0 || ((r.fl[i - 1] ?? 0) & 1) !== 0;
    if (!approach) expect(onRoad(p[0], p[2]), `route pt ${i} (${p[0]}, ${p[2]})`).toBe(true);
  });
  expect(src.places.some((p: any) => p.key === field.base.key && p.kind === 'home')).toBe(true);
  expect(src.places.some((p: any) => p.key === field.spawn.key)).toBe(true);
  // 战场出现时请宿主把镜头对准它（一次）
  const focus = all.filter((m) => m.type === 'td:camera' && m.kind === 'frame');
  expect(focus).toHaveLength(1);
  expect(focus[0].maxX).toBeGreaterThan(focus[0].minX);
  expect(focus[0].insets.top).toBeGreaterThan(20);

  const sp = await game.evaluate(() => { const s = (window as any).__td.spatial; return { mode: s.mode, insitu: s.insitu, bg: s.canvasBg, hasRoadPlan: 'roadPlan' in s, slots: s.tacticalSlots.length }; });
  expect(sp).toMatchObject({ mode: 'world', insitu: true, bg: 'transparent', hasRoadPlan: false });
  expect(sp.slots).toBe(field.pads.length);
  // 每帧一条的相机消息不进调试日志（?debug=1 时游戏把收到的宿主消息记在 __msgs 里）
  const log = await game.evaluate(() => ((window as any).__msgs as any[]).map((m) => m.type));
  expect(log).toContain('hikos:context');
  expect(log).not.toContain('hikos:camera');
  expect(errors).toEqual([]);
});

test('点选跟着相机走：缩小 / 放大 / 转角度之后，点在地图上塔位所在的那个像素，建起来的就是那个塔位', async ({ page }) => {
  const game = await openHost(page);
  const field = (await fieldMsg(page))!;
  const mid = { x: field.pads.reduce((a: number, p: number[]) => a + p[0], 0) / field.pads.length, z: field.pads.reduce((a: number, p: number[]) => a + p[1], 0) / field.pads.length };
  const built: number[] = [];
  await game.evaluate(() => { (window as any).__td.state.gold = 900; });   // 四档镜头各建一座：先把军费给够
  const poses = [
    { name: '缩小', zoom: 0.62, azimuth: -0.38, pitch: 0.78, focus: [mid.x, 0, mid.z] },
    { name: '放大', zoom: 2.4, azimuth: -0.38, pitch: 0.78, focus: [field.pads[2][0], 0, field.pads[2][1]] },
    { name: '转角度', zoom: 1.3, azimuth: 1.25, pitch: 1.05, focus: [mid.x, 0, mid.z] },
    { name: '反向俯视', zoom: 1.0, azimuth: -2.6, pitch: 0.56, focus: [mid.x, 0, mid.z] },
  ];
  for (const pose of poses) {
    await setCam(page, pose);
    await expect.poll(async () => (await world(game)).camera.zoom).toBeCloseTo(pose.zoom, 5);
    const target = await freePadInView(page, game, built);
    // 游戏自己算出来的屏幕位置与宿主的投影一致（同一个矩阵）
    const fromGame = await game.evaluate((i) => (window as any).__td.world.padScreen(i), target.pad);
    expect(Math.hypot(fromGame.x - target.x, fromGame.y - target.y), `${pose.name} 塔位 ${target.pad}`).toBeLessThan(0.01);
    await page.mouse.move(target.x, target.y);
    await expect.poll(async () => (await lastFrame(page))?.pads[target.pad], { message: `${pose.name}：塔位 ${target.pad} 应高亮` }).toBe('1');
    await page.mouse.click(target.x, target.y);
    await expect.poll(async () => (await lastFrame(page))?.pads[target.pad], { message: `${pose.name}：塔位 ${target.pad} 应已建塔` }).toBe('4');
    built.push(target.pad);
    const fr = (await lastFrame(page))!;
    expect(fr.towers.map((t: number[]) => t[1]).sort((a: number, b: number) => a - b)).toEqual([...built].sort((a, b) => a - b));
  }
  // 点空白处不建塔
  await setCam(page, { zoom: 0.62, azimuth: -0.38, pitch: 0.78, focus: [mid.x, 0, mid.z] });
  const before = (await lastFrame(page))!.towers.length;
  const blank = await emptySpot(page, game);
  await page.mouse.click(blank.x, blank.y);
  await page.waitForTimeout(250);
  expect((await lastFrame(page))!.towers.length).toBe(before);
});

test('敌人贴着真实道路走：三档镜头下，td:frame 里的「路线 + 弧长」投到屏幕上，与游戏画跳字用的位置一致，且始终在路面上', async ({ page }) => {
  const game = await openHost(page);
  const field = (await fieldMsg(page))!;
  const src = loadWorld('union-atlas-3d');
  await game.evaluate(() => { (window as any).__td.triggerDemoCombatVfx(); (window as any).__td.setPaused(true); });
  await expect.poll(async () => (await lastFrame(page))?.enemies.length ?? 0).toBeGreaterThanOrEqual(6);
  const fr = (await lastFrame(page))!;
  expect(fr.towers.length).toBe(6);
  expect(fr.paused).toBe(true);
  // 沿路线取点（宿主拿到的就是这条折线）
  const at = (route: any, s: number) => {
    let left = Math.max(0, s);
    for (let i = 1; i < route.pts.length; i++) {
      const a = route.pts[i - 1], b = route.pts[i], l = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (left <= l || i === route.pts.length - 1) { const t = l > 1e-9 ? Math.min(1, left / l) : 0; return { x: a[0] + (b[0] - a[0]) * t, z: a[2] + (b[2] - a[2]) * t, approach: ((route.fl[i - 1] ?? 0) & 1) !== 0 }; }
      left -= l;
    }
    return { x: 0, z: 0, approach: true };
  };
  const roadDist = (x: number, z: number) => Math.min(...src.roads.map((r: any) => Math.min(...r.pts.slice(1).map((b: number[], i: number) => {
    const a = r.pts[i], dx = b[0] - a[0], dz = b[2] - a[2], l2 = dx * dx + dz * dz, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / l2));
    return Math.hypot(x - a[0] - dx * t, z - a[2] - dz * t) - r.w / 2;
  }))));
  for (const row of fr.enemies as number[][]) {
    const q = at(field.routes[row[2]], row[3]);
    if (!q.approach) expect(roadDist(q.x, q.z), `enemy ${row[0]} 离路面`).toBeLessThanOrEqual(0.06);
  }
  const shots: { name: string; cam: Record<string, unknown> }[] = [
    { name: '01-zoom-out', cam: { zoom: 0.55, azimuth: -0.38, pitch: 0.78, focus: [0, 0, 0] } },
    { name: '02-zoom-in', cam: { zoom: 2.2, azimuth: -0.38, pitch: 0.78, focus: [at(field.routes[0], field.routes[0].len * 0.45).x, 0, at(field.routes[0], field.routes[0].len * 0.45).z] } },
    { name: '03-rotated', cam: { zoom: 1.1, azimuth: 1.6, pitch: 1.1, focus: [0, 0, 0] } },
  ];
  for (const sh of shots) {
    await setCam(page, sh.cam);
    await expect.poll(async () => (await world(game)).camera.zoom).toBeCloseTo(sh.cam.zoom as number, 5);
    for (const row of fr.enemies as number[][]) {
      const fromGame = await game.evaluate((iid) => ({ s: (window as any).__td.world.enemyScreen(iid), w: (window as any).__td.world.enemyWorld(iid) }), row[0]);
      const fromHost = await hostProject(page, fromGame.w.x, fromGame.w.y, fromGame.w.z);
      expect(Math.hypot(fromGame.s.x - fromHost.x, fromGame.s.y - fromHost.y)).toBeLessThan(0.01);
      // 世界位置不随相机变：始终是路线上那一点
      const q = at(field.routes[row[2]], row[3]);
      expect(Math.hypot(fromGame.w.x - q.x, fromGame.w.z - q.z)).toBeLessThan(0.02);
    }
    await page.waitForTimeout(120);
    await page.screenshot({ path: `docs/screens/world-mode-${sh.name}.png` });
  }
});

test('宿主回了沿路高度剖面（hikos:ground 的 step / profile）：跳字的高度跟着剖面走，与宿主摆敌人的高度一致；不带剖面 / 剖面对不上时照旧按折点插值', async ({ page }) => {
  const game = await openHost(page, 'metropolis-riverside-3d');
  const field = (await fieldMsg(page))!;
  const STEP = 0.5, FLAT = 0.2;
  // 宿主那边的路线长度：按 td:field 里的折点逐段累加（arcade-field.js 的 buildRoute 就是这么算的）
  const lens: number[] = field.routes.map((r: any) => r.pts.slice(1).reduce((acc: number, p: number[], i: number) => acc + Math.hypot(p[0] - r.pts[i][0], p[2] - r.pts[i][2]), 0));
  // 一份有台阶的剖面：每 3.5 个单位抬高 / 落下 0.5，折点高度却全是平的——只看折点就完全看不见这些台阶
  const profile = lens.map((len) => Array.from({ length: Math.max(2, Math.ceil(len / STEP) + 1) }, (_, k) => Math.round((FLAT + (Math.floor(k / 7) % 2) * 0.5 + 0.01 * (k % 3)) * 1000) / 1000));
  // 宿主摆敌人的高度（arcade-field.js 的 along()）
  const hostY = (ri: number, s: number) => {
    const P = profile[ri], len = lens[ri], n = P.length, c = Math.max(0, Math.min(len, s)), i = Math.min(n - 2, Math.floor(c / STEP)), span = (i === n - 2 ? len - i * STEP : STEP) || STEP;
    return P[i] + (P[i + 1] - P[i]) * Math.max(0, Math.min(1, (c - i * STEP) / span));
  };
  const arcs = (len: number) => [...Array.from({ length: Math.floor(len / 0.3) + 1 }, (_, k) => k * 0.3), len];
  const gameYs = (ri: number) => game.evaluate(({ i, list }) => list.map((s) => (window as any).__td.world.routeWorld(i, s).y as number), { i: ri, list: arcs(lens[ri]) });
  const profiled = () => game.evaluate(() => (window as any).__td.world.profiled as boolean[]);
  const base = { type: 'hikos:ground', v: 1, field: field.id, pads: field.pads.map(() => FLAT), routes: field.routes.map((r: any) => r.pts.map(() => FLAT)) };

  // ① 旧宿主的回执（只有折点高度）：整条路线都是平的
  await page.evaluate((m) => (window as any).__send(m), base);
  await expect.poll(() => game.evaluate(() => !!(window as any).__td.world.ground)).toBe(true);
  expect(await profiled()).toEqual(field.routes.map(() => false));
  for (let ri = 0; ri < field.routes.length; ri++) for (const y of await gameYs(ri)) expect(y).toBeCloseTo(FLAT, 9);

  // ② 带剖面的回执：路线上每一处都是宿主的那个高度
  await page.evaluate((m) => (window as any).__send(m), { ...base, step: STEP, profile });
  await expect.poll(async () => (await profiled()).every(Boolean)).toBe(true);
  for (let ri = 0; ri < field.routes.length; ri++) {
    const ys = await gameYs(ri), list = arcs(lens[ri]);
    let worst = 0, lift = 0;
    ys.forEach((y, k) => { worst = Math.max(worst, Math.abs(y - hostY(ri, list[k]))); lift = Math.max(lift, y - FLAT); });
    expect(worst, `路线 ${ri} 与宿主的高度差`).toBeLessThan(1e-9);
    expect(lift, `路线 ${ri} 确实用上了剖面`).toBeGreaterThan(0.45);
  }

  // ③ 在场的敌人：游戏画跳字用的世界坐标，高度就是宿主把它摆在的高度；投到屏幕上是同一个像素
  await game.evaluate(() => { (window as any).__td.triggerDemoCombatVfx(); (window as any).__td.setPaused(true); });
  await expect.poll(async () => (await lastFrame(page))?.enemies.length ?? 0).toBeGreaterThanOrEqual(6);
  const fr = (await lastFrame(page))!;
  let raised = 0;
  for (const row of fr.enemies as number[][]) {
    const fromGame = await game.evaluate((iid) => ({ s: (window as any).__td.world.enemyScreen(iid), w: (window as any).__td.world.enemyWorld(iid) }), row[0]);
    const want = hostY(row[2], row[3]);
    expect(Math.abs(fromGame.w.y - want), `enemy ${row[0]} 高度`).toBeLessThan(0.02);   // 帧里的弧长取了两位小数，台阶斜面上差不出 0.02
    const onHost = await hostProject(page, fromGame.w.x, want, fromGame.w.z);
    expect(Math.hypot(fromGame.s.x - onHost.x, fromGame.s.y - onHost.y), `enemy ${row[0]} 屏幕位置`).toBeLessThan(0.5);
    if (want - FLAT > 0.3) raised++;
  }
  expect(raised, '至少有一个敌人站在台阶上（否则这条用例什么也没测到）').toBeGreaterThan(0);

  // ④ 剖面盖不住路线（少了几个样点）：不用它，退回折点插值；游戏照常运行
  await page.evaluate((m) => (window as any).__send(m), { ...base, step: STEP, profile: profile.map((p) => p.slice(0, -3)) });
  await expect.poll(async () => (await profiled()).some(Boolean)).toBe(false);
  for (let ri = 0; ri < field.routes.length; ri++) for (const y of await gameYs(ri)) expect(y).toBeCloseTo(FLAT, 9);
});

test('手势交还给地图相机：拖动 = 旋转、Shift 拖动 = 平移、滚轮 / 双指 = 缩放、双击空白 = 复位；拖动不建塔', async ({ page }) => {
  const game = await openHost(page);
  const cams = async () => (await msgs(page)).filter((m) => m.type === 'td:camera' && m.kind !== 'frame');
  const towers = async () => (await game.evaluate(() => (window as any).__td.state.towers.length)) as number;

  // 从一个塔位上按下、拖走：相机转了，塔没建
  const start = await freePadInView(page, game);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + 10, { steps: 4 });
  await page.mouse.move(start.x + 90, start.y + 30, { steps: 5 });
  await page.mouse.up();
  const rot = (await cams()).filter((m) => m.kind === 'rotate');
  expect(rot.length).toBeGreaterThan(1);
  expect(rot.reduce((a, m) => a + m.dx, 0)).toBeCloseTo(90, 5);
  expect(rot.reduce((a, m) => a + m.dy, 0)).toBeCloseTo(30, 5);
  await page.waitForTimeout(200);
  expect(await towers()).toBe(0);
  // 假宿主按引擎原生算法转了相机并推回 hikos:camera：游戏手里的方位角跟着变
  await expect.poll(async () => (await world(game)).camera.azimuth).toBeCloseTo(-0.38 - 90 * 0.004, 5);

  await page.keyboard.down('Shift');
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.mouse.move(650, 430, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const pan = (await cams()).filter((m) => m.kind === 'pan');
  expect(pan.reduce((a, m) => a + m.dx, 0)).toBeCloseTo(50, 5);

  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await cams()).filter((m) => m.kind === 'zoom').length).toBeGreaterThan(0);
  await expect.poll(async () => (await world(game)).camera.zoom).toBeGreaterThan(1);

  // 双指捏合（合成 pointer 事件）：只发 pinch，不建塔
  const zoomBefore = (await world(game)).camera.zoom;
  await game.evaluate(() => {
    const c = document.getElementById('board')!;
    const ev = (type: string, id: number, x: number, y: number) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true, cancelable: true }));
    ev('pointerdown', 11, 400, 300); ev('pointerdown', 12, 500, 300);
    ev('pointermove', 11, 380, 300); ev('pointermove', 12, 520, 300);
    ev('pointermove', 11, 350, 300); ev('pointermove', 12, 550, 300);
    ev('pointerup', 11, 350, 300); ev('pointerup', 12, 550, 300);
  });
  const pinch = (await cams()).filter((m) => m.kind === 'pinch');
  expect(pinch.length).toBeGreaterThan(0);
  expect(pinch.reduce((a, m) => a * m.scale, 1)).toBeCloseTo(2, 2);
  await expect.poll(async () => (await world(game)).camera.zoom).toBeCloseTo(zoomBefore * 2, 2);
  expect(await towers()).toBe(0);

  const blank = await emptySpot(page, game);
  await page.mouse.dblclick(blank.x, blank.y);
  await expect.poll(async () => (await cams()).filter((m) => m.kind === 'reset').length).toBe(1);
  await expect.poll(async () => (await world(game)).camera.zoom).toBeCloseTo(1, 6);
  expect(await towers()).toBe(0);
});

test('悬停与射程圈、建造期零流量、地图换了就在新战场上重新部署、宿主收回 world 就退回屏幕模式', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const game = await openHost(page);
  const field = (await fieldMsg(page))!;

  // 悬停：塔位高亮 + 当前选中塔的射程圈（世界单位）+ 铭牌
  const target = await freePadInView(page, game);
  await page.mouse.move(target.x, target.y);
  await expect.poll(async () => (await lastFrame(page))?.pads[target.pad]).toBe('1');
  let fr = (await lastFrame(page))!;
  expect(fr.ring[0]).toBe(target.pad);
  expect(fr.ring[1]).toBeCloseTo(field.towers[0].range, 1);
  expect(fr.tips.some((t: [number, string]) => t[0] === target.pad && t[1].includes('CP'))).toBe(true);
  const blank = await emptySpot(page, game);
  await page.mouse.move(blank.x, blank.y);
  await expect.poll(async () => (await lastFrame(page))?.ring).toBeNull();

  // 建造期没人动：不发新帧
  await page.waitForTimeout(300);
  const n0 = (await msgs(page)).filter((m) => m.type === 'td:frame').length;
  await page.waitForTimeout(700);
  expect((await msgs(page)).filter((m) => m.type === 'td:frame').length).toBe(n0);

  // 建一座塔，点它：射程圈开；再点：关
  await page.mouse.click(target.x, target.y);
  await expect.poll(async () => (await lastFrame(page))?.pads[target.pad]).toBe('4');
  await page.mouse.move(blank.x, blank.y);
  await expect.poll(async () => (await lastFrame(page))?.ring).toBeNull();
  await game.evaluate(([x, y]) => {
    const c = document.getElementById('board')!;
    for (const type of ['pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(type, { pointerId: 21, pointerType: 'touch', clientX: x, clientY: y, button: 0, bubbles: true }));
  }, [target.x, target.y]);
  await expect.poll(async () => (await lastFrame(page))?.ring?.[0]).toBe(target.pad);

  // 同一份地图再发一次：战场不动、塔还在
  await page.evaluate(() => (window as any).__send((window as any).__context()));
  await page.waitForTimeout(250);
  expect((await fieldMsg(page))!.id).toBe(field.id);
  expect(await game.evaluate(() => (window as any).__td.state.towers.length)).toBe(1);

  // 地图变了（整座城左右镜像）：新战场 id、本关重新部署
  await page.evaluate(() => {
    const w = (window as any).__world;
    (window as any).__world = {
      ...w, rev: 2,
      bounds: { ...w.bounds, minX: -w.bounds.maxX, maxX: -w.bounds.minX },
      roads: w.roads.map((r: any) => ({ ...r, pts: r.pts.map((p: number[]) => [-p[0], p[1], p[2]]) })),
      places: w.places.map((p: any) => ({ ...p, x: -p.x })),
      blocks: w.blocks.map((b: number[]) => [-b[0], b[1], b[2]]),
      water: (w.water || []).map((x: any) => ({ ...x, pts: x.pts.map((p: number[]) => [-p[0], p[1]]) })),
    };
    (window as any).__send((window as any).__context());
  });
  await expect.poll(async () => (await fieldMsg(page))!.id).not.toBe(field.id);
  await expect.poll(() => game.evaluate(() => (window as any).__td.state.towers.length)).toBe(0);
  expect((await msgs(page)).some((m) => m.type === 'td:restore')).toBe(true);

  // 宿主不再给 world：退回屏幕模式，并通知宿主收掉它画的战场
  await page.evaluate(() => { const c = (window as any).__context(); c.map.world = null; (window as any).__send(c); });
  await expect.poll(async () => (await msgs(page)).filter((m) => m.type === 'td:field').pop()?.id).toBeNull();
  await expect.poll(() => game.evaluate(() => (window as any).__td.world)).toBeNull();
  expect(await game.evaluate(() => 'roadPlan' in (window as any).__td.spatial)).toBe(true);
  expect(errors).toEqual([]);
});

for (const skin of ['metropolis-riverside-3d', 'gothic-cathedral-3d', 'harbor-district-3d']) {
  test(`其余皮肤 ${skin}：真实几何上排得出战场，演示局面的塔与敌人都在路线上，三档镜头截图`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const src = loadWorld(skin);
    const span = Math.max(src.bounds.maxX - src.bounds.minX, src.bounds.maxZ - src.bounds.minZ) * 0.42;
    const game = await openHost(page, skin, { span });
    const field = (await fieldMsg(page))!;
    expect(field.skin).toBe(skin);
    expect(field.pads.length).toBeGreaterThanOrEqual(4);
    await game.evaluate(() => { (window as any).__td.triggerDemoCombatVfx(); (window as any).__td.setPaused(true); });
    await expect.poll(async () => (await lastFrame(page))?.enemies.length ?? 0).toBeGreaterThanOrEqual(6);
    const fr = (await lastFrame(page))!;
    for (const row of fr.enemies as number[][]) {
      expect(row[3]).toBeGreaterThanOrEqual(0);
      expect(row[3]).toBeLessThanOrEqual(field.routes[row[2]].len + 0.01);
    }
    const cx = (src.bounds.minX + src.bounds.maxX) / 2, cz = (src.bounds.minZ + src.bounds.maxZ) / 2;
    for (const [name, cam] of [['01-zoom-out', { zoom: 0.7, azimuth: -0.38, pitch: 0.78, focus: [cx, 0, cz] }], ['02-zoom-in', { zoom: 2, azimuth: -0.38, pitch: 0.78, focus: [field.pads[1][0], 0, field.pads[1][1]] }], ['03-rotated', { zoom: 1.1, azimuth: 1.7, pitch: 1.1, focus: [cx, 0, cz] }]] as const) {
      await setCam(page, cam as Record<string, unknown>);
      await expect.poll(async () => (await world(game)).camera.zoom).toBeCloseTo(cam.zoom, 5);
      const p0 = await padOnPage(page, game, 0);
      const g0 = await game.evaluate(() => (window as any).__td.world.padScreen(0));
      expect(Math.hypot(p0.x - g0.x, p0.y - g0.y)).toBeLessThan(0.01);
      await page.waitForTimeout(120);
      await page.screenshot({ path: `docs/screens/world-mode-${skin}-${name}.png` });
    }
    expect(errors).toEqual([]);
  });
}

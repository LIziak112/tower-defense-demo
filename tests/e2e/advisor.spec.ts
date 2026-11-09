import { test, expect, type Page, type Frame } from '@playwright/test';

// 军师 E2E：独立页（本地模板 / HTTP 代理）与嵌入页（模拟 Hikos 宿主按脚本回包）。
// 宿主只做「代发」：收到 td:advisor:request 原样记下，按模式回 hikos:advisor:reply；不懂提示词、不改快照。
// 模式：ok = 立刻回合法建议；slow = 8 s 后才回（超过 6 s 截止）；bad = 下一波回不成形、波内回过期；off = context 里 advisor.enabled=false 且永不回。
type HostMode = 'ok' | 'slow' | 'bad' | 'off';
const HOST_PATH = '/__advisor-host.html';
const GAME_QUERY = 'v=1&skin=union-atlas-3d&accent=a72e25&bg=f2ebdd&ink=393e38&theme=day&lang=zh&skiplobby';
const hostHtml = (mode: HostMode) => `<!DOCTYPE html><html><body style="margin:0">
<div id="stage" style="width:960px;height:640px"><iframe id="game" sandbox="allow-scripts" referrerpolicy="strict-origin-when-cross-origin" style="width:100%;height:100%;border:0"></iframe></div>
<script>
  const MODE = ${JSON.stringify(mode)};
  const frame = document.getElementById('game');
  window.__msgs = []; window.__reqs = [];
  window.__send = (m) => frame.contentWindow.postMessage(m, '*');
  const advice = (req) => {
    const slot = (req.snapshot.slots || []).find((s) => s.open);
    return { v: 1, basedOn: req.stateVersion, say: '宿主军师在此', options: [
      { id: 'a', title: '宿主回包', why: '先把路口堵上。', risk: '金币见底。', moves: slot ? [{ slot: slot.id, tower: 'crossbow' }] : [] },
      { id: 'b', title: '攒一手', why: '留钱下波。', moves: [] } ],
      bet: { leaks: 0, line: '一只不漏。' } };
  };
  const reply = (req, payload, extra) => window.__send(Object.assign({ type: 'hikos:advisor:reply', v: 1, reqId: req.reqId, ok: true, payload, provider: 'mock-llm', latencyMs: 42 }, extra || {}));
  addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    window.__msgs.push(e.data);
    const m = e.data || {};
    if (m.type === 'td:ready') window.__send({ type: 'hikos:context', v: 1, skin: 'union-atlas-3d', accent: 'a72e25', bg: 'f2ebdd', ink: '393e38', theme: 'day', lang: 'zh', reducedMotion: false, advisor: { enabled: MODE !== 'off', provider: 'mock-llm' } });
    if (m.type !== 'td:advisor:request') return;
    window.__reqs.push(m);
    if (MODE === 'ok') reply(m, advice(m));
    else if (MODE === 'slow') setTimeout(() => reply(m, advice(m)), 8000);
    else if (MODE === 'bad') reply(m, m.kind === 'next-wave' ? { foo: 'bar' } : Object.assign(advice(m), { basedOn: 0 }));
  });
  frame.src = './?${GAME_QUERY}';
</script></body></html>`;

async function openHost(page: Page, mode: HostMode): Promise<Frame> {
  await page.route(`**${HOST_PATH}`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: hostHtml(mode) }));
  await page.goto(HOST_PATH);
  const el = await page.waitForSelector('#game');
  const game = (await el.contentFrame())!;
  await game.waitForSelector('#board', { state: 'visible' });
  return game;
}
type Req = { type: string; v: number; reqId: string; kind: string; deadlineMs: number; stateVersion: number; snapshot: Record<string, unknown>; llm: { messages: { role: string; content: string }[]; max_tokens: number; json: boolean } };
const reqs = (page: Page) => page.evaluate(() => (window as any).__reqs as Req[]);
const view = (f: Frame | Page) => f.evaluate(() => (window as any).__advisor.view());
const st = (f: Frame | Page) => f.evaluate(() => { const s = (window as any).__td.state; return { phase: s.phase as string, tick: s.tick as number, gold: s.gold as number, towers: s.towers.length as number, wave: s.wave_index as number, leaks: s.leaks as number }; });
const FORBIDDEN = ['"x":', '"y":', '"cx":', '"cy":', '"path":', '"buildable_cells":', '"occupied":', '"color":', '"palette":', '"skin":', '"seed":', '"rng":', '"token":', '"user":'];

test('独立页 ?advisor=local：卡片出本地建议与押注；采纳只落 build；波后结算押注、第二波出变招并加金', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('./?skiplobby&advisor=local&lang=zh&notactical');
  await page.waitForSelector('#board', { state: 'visible' });
  const card = page.locator('#advisor');
  await expect(card).toHaveAttribute('data-source', 'local');
  await expect(card).toHaveAttribute('data-provider', 'local');
  await expect(page.locator('#adv-badge')).toContainText('本地模板');
  expect(await page.evaluate(() => (window as any).__advisor.mode)).toBe('local');
  await expect(page.locator('#advisor .adv-opt')).not.toHaveCount(0);
  await expect(page.locator('#advisor .adv-bet')).toContainText('军师押');

  // 采纳 a：塔多了、钱少了、结果回灌成 outcome；叠层画在棋盘上不影响棋盘点击（这里只看状态）
  const before = await st(page);
  const movesA = (await view(page)).current.advice.options[0].moves.length as number;
  expect(movesA).toBeGreaterThan(0);
  await page.click('#advisor button[data-adopt="a"]');
  await expect.poll(async () => (await st(page)).towers).toBe(before.towers + movesA);
  expect((await st(page)).gold).toBeLessThan(before.gold);
  await expect(page.locator('#advisor button[data-adopt="a"]')).toBeDisabled();
  await expect(page.locator('#advisor button[data-adopt="a"]')).toHaveText('已采纳');
  const v1 = await view(page);
  expect(v1.outcomes.length).toBe(movesA);
  expect(v1.outcomes.every((o: { ok: boolean }) => o.ok)).toBe(true);
  await page.screenshot({ path: 'docs/screens/advisor-local-card.png' });

  // 开第一波 → 打完回建造期：押注结算一行常驻，战绩有一分落在三格之一；第二波起军师出变招
  await page.click('#start-wave');
  await expect.poll(async () => (await st(page)).phase).toBe('wave');
  await expect.poll(async () => (await st(page)).phase, { timeout: 90_000 }).toBe('build');
  const v2 = await view(page);
  expect(v2.bets).toHaveLength(1);
  expect(v2.score.you + v2.score.advisor + v2.score.none).toBe(1);
  expect(typeof v2.betLine).toBe('string');
  await expect(page.locator('#advisor .adv-betline')).toContainText('军师押');
  await expect(page.locator('#advisor .adv-gambit')).toBeVisible();
  const offer = v2.gambit.offer as { id: string } | null;
  expect(offer).not.toBeNull();
  const goldBefore = (await st(page)).gold;
  await page.click('#advisor button[data-gambit-take]');
  await expect.poll(async () => (await view(page)).gambit.taken?.id).toBe(offer!.id);
  const taken = (await view(page)).gambit.taken as { bonus: number };
  expect(taken.bonus).toBeGreaterThan(0);
  expect((await st(page)).gold).toBe(goldBefore + taken.bonus);
  await expect(page.locator('#advisor button[data-gambit-take]')).toBeDisabled();
  await page.screenshot({ path: 'docs/screens/advisor-local-gambit.png' });
  expect(errors).toEqual([]);
});

test('嵌入 · 宿主代理正常回包：请求契约（v1 / 提示词 / 最小快照不含坐标与机密），LLM 徽记与建议上墙；波内有即时请求', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const game = await openHost(page, 'ok');
  await expect.poll(() => reqs(page), { timeout: 15_000 }).not.toHaveLength(0);
  const r = (await reqs(page))[0];
  expect(r).toMatchObject({ type: 'td:advisor:request', v: 1, kind: 'next-wave', deadlineMs: 6000 });
  expect(r.reqId).toMatch(/^r\d+$/);
  expect(r.llm.json).toBe(true);
  expect(r.llm.messages.map((m) => m.role)).toEqual(['system', 'user']);
  expect(r.llm.messages[1].content).toContain('"stateVersion"');
  expect(r.llm.max_tokens).toBeGreaterThan(0);
  const snapJson = JSON.stringify(r.snapshot);
  expect(snapJson.length).toBeLessThan(8 * 1024);
  for (const k of FORBIDDEN) expect(snapJson, `快照不得含 ${k}`).not.toContain(k);
  expect(r.snapshot).toMatchObject({ v: 1, stateVersion: r.stateVersion, phase: 'build' });
  expect((r.snapshot.slots as unknown[]).length).toBeLessThanOrEqual(12);

  const card = game.locator('#advisor');
  await expect(card).toHaveAttribute('data-source', 'llm');
  await expect(card).toHaveAttribute('data-provider', 'host');
  await expect(game.locator('#adv-badge')).toHaveClass(/llm/);
  await expect(game.locator('#adv-badge')).toContainText('mock-llm');
  await expect(game.locator('#advisor .adv-say')).toContainText('宿主军师在此');
  await expect(game.locator('#advisor .adv-opt[data-option="a"] b')).toContainText('宿主回包');
  await expect(game.locator('#advisor .adv-opt[data-option="b"] button')).toBeDisabled();   // 0 步的选项没得采纳
  const v = await view(game);
  expect(v.current.provider).toBe('mock-llm');
  expect(v.current.reason).toBeNull();
  expect(v.stats).toMatchObject({ requests: 1, replies: 1, fallbacks: 0 });

  const before = await st(game);
  await game.click('#advisor button[data-adopt="a"]');
  await expect.poll(async () => (await st(game)).towers).toBe(before.towers + 1);
  await page.screenshot({ path: 'docs/screens/advisor-host-llm.png' });

  // 波内每 4 s 一问即时指令（2.5 s 截止），宿主秒回 → 上墙
  await game.click('#start-wave');
  await expect.poll(async () => (await reqs(page)).filter((x) => x.kind === 'tactical').length, { timeout: 30_000 }).toBeGreaterThan(0);
  const tac = (await reqs(page)).find((x) => x.kind === 'tactical')!;
  expect(tac.deadlineMs).toBe(2500);
  expect(tac.snapshot.phase).toBe('wave');
  await expect.poll(async () => (await view(game)).log.filter((l: { ev: string; kind?: string; code?: string }) => l.ev === 'present' && l.kind === 'tactical' && l.code === 'LLM').length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('嵌入 · 宿主 8 s 才回（§5-1）：6 s 截止后本地兜底、迟到回包记 LATE；在飞请求不拖慢 tick（§5-5 口径）', async ({ page }) => {
  const game = await openHost(page, 'slow');
  await expect.poll(() => reqs(page), { timeout: 15_000 }).not.toHaveLength(0);
  const card = game.locator('#advisor');
  await expect(card).toHaveAttribute('data-status', 'thinking');
  await expect(game.locator('#adv-badge')).toContainText('思考中');
  const t0 = Date.now();
  await expect(card).toHaveAttribute('data-source', 'local', { timeout: 9_000 });
  const waited = Date.now() - t0;
  expect(waited).toBeLessThan(8_000);   // 是 6 s 截止兜的底，不是等到 8 s 回包
  const v = await view(game);
  expect(v.current.reason).toBe('TIMEOUT');
  expect(v.notice).toContain('迟到');
  expect(v.current.advice.options.length).toBeGreaterThan(0);
  await expect(game.locator('#adv-badge')).toContainText('TIMEOUT');
  const reqId = (await reqs(page))[0].reqId;
  await expect.poll(async () => (await view(game)).log.filter((l: { ev: string; code?: string; reqId?: string }) => l.ev === 'drop' && l.code === 'LATE' && l.reqId === reqId).length, { timeout: 6_000 }).toBe(1);
  expect((await view(game)).current.reqId).toBe(reqId);   // 迟到回包没有顶掉已上墙的本地建议
  expect((await view(game)).stats).toMatchObject({ requests: 1, replies: 0, fallbacks: 1, drops: 1 });

  // 开波：波内即时请求一直在飞（宿主慢），tick 速率仍是 30/s（2 s 里 60 tick，容差 10%）
  await game.click('#start-wave');
  await expect.poll(async () => (await reqs(page)).filter((x) => x.kind === 'tactical').length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(card).toHaveAttribute('data-status', 'thinking');
  const a = await st(game);
  await page.waitForTimeout(2000);
  const b = await st(game);
  if (b.phase === 'wave') expect(Math.abs(b.tick - a.tick - 60)).toBeLessThanOrEqual(6);
  await expect.poll(async () => (await view(game)).log.filter((l: { ev: string; kind?: string; code?: string }) => l.ev === 'drop' && l.kind === 'tactical' && l.code === 'TIMEOUT').length, { timeout: 10_000 }).toBeGreaterThan(0);
});

test('嵌入 · 宿主回不成形 / 过期（§5-2 §5-3）：形状错 → 本地兜底并记 BAD_SHAPE；波内过期回包 → 丢弃记 STALE，不落任何塔', async ({ page }) => {
  const game = await openHost(page, 'bad');
  const card = game.locator('#advisor');
  await expect(card).toHaveAttribute('data-source', 'local', { timeout: 15_000 });
  const v = await view(game);
  expect(v.current.reason).toBe('BAD_SHAPE');
  expect(v.notice).toContain('不成句');
  expect(v.log.some((l: { ev: string; code?: string }) => l.ev === 'error' && l.code === 'BAD_SHAPE')).toBe(true);
  await expect(game.locator('#adv-badge')).toContainText('BAD_SHAPE');

  const towers0 = (await st(game)).towers;
  await game.click('#start-wave');
  await expect.poll(async () => (await view(game)).log.filter((l: { ev: string; code?: string }) => l.ev === 'drop' && l.code === 'STALE').length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect((await st(game)).towers).toBe(towers0);
  expect((await view(game)).stats.adopted).toBe(0);
});

test('嵌入 · 宿主 context 关掉军师（advisor.enabled=false）：不等截止，直接本地建议（NO_ADVISOR）', async ({ page }) => {
  const game = await openHost(page, 'off');
  const card = game.locator('#advisor');
  await expect(card).toHaveAttribute('data-source', 'local', { timeout: 15_000 });
  const v = await view(game);
  expect(v.current.reason).toBe('NO_ADVISOR');
  expect(v.stats.fallbacks).toBe(1);
  expect(v.current.advice.options.length).toBeGreaterThan(0);
  await expect(game.locator('#advisor .adv-opt')).not.toHaveCount(0);
});

test('独立页 ?advisor=/path：HTTP 代理通道（开发代理口径），回 AdvisorReply 即以 LLM 徽记上墙', async ({ page }) => {
  const posted: Record<string, unknown>[] = [];
  await page.route('**/__advisor', async (route) => {
    const req = route.request().postDataJSON() as Req;
    posted.push(req);
    const slot = (req.snapshot.slots as { id: number; open: boolean }[]).find((s) => s.open);
    const payload = { v: 1, basedOn: req.stateVersion, options: [{ id: 'a', title: '代理回包', why: '路口。', moves: slot ? [{ slot: slot.id, tower: 'catapult' }] : [] }] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reqId: req.reqId, ok: true, payload, provider: 'route-llm' }) });
  });
  await page.goto('./?skiplobby&advisor=/__advisor&lang=zh&notactical');
  await page.waitForSelector('#board', { state: 'visible' });
  expect(await page.evaluate(() => (window as any).__advisor.mode)).toBe('http');
  await expect(page.locator('#advisor')).toHaveAttribute('data-source', 'llm', { timeout: 15_000 });
  await expect(page.locator('#advisor')).toHaveAttribute('data-provider', 'http');
  await expect(page.locator('#adv-badge')).toContainText('route-llm');
  await expect(page.locator('#advisor .adv-opt[data-option="a"] b')).toContainText('代理回包');
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ v: 1, kind: 'next-wave' });
});

test('嵌入 · 频道智能体扮演 + 大厅流式出题 + Pn() 按钮复位（任务 d9ad7e7a）', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const lobbyHostHtml = `<!DOCTYPE html><html><body style="margin:0">
<div id="stage" style="width:960px;height:640px"><iframe id="game" sandbox="allow-scripts" referrerpolicy="strict-origin-when-cross-origin" style="width:100%;height:100%;border:0"></iframe></div>
<script>
  const frame = document.getElementById('game');
  window.__reqs = [];
  const send = (m) => frame.contentWindow.postMessage(m, '*');
  const AGENT = {
    id: 'agent-jiangshang',
    name: '姜尚',
    title: '太公兵法',
    avatar: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><polygon points='16,2 30,16 16,30 2,16' fill='%23356d73'/><text x='16' y='21' font-size='14' fill='white' text-anchor='middle'>姜</text></svg>",
    color: '#356d73',
    persona: '善布奇门阵法，主张稳守要冲、待机合围。'
  };
  addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data || {};
    if (m.type === 'td:ready') {
      send({
        type: 'hikos:context', v: 1, skin: 'metropolis-riverside-3d', accent: '356d73', bg: 'e8ede7', ink: '354e52',
        theme: 'day', lang: 'zh', reducedMotion: false,
        advisor: { enabled: true, provider: 'hikos', agent: AGENT }
      });
    }
    if (m.type === 'td:advisor:request') {
      window.__reqs.push(m);
      if (m.kind === 'level') {
        setTimeout(() => send({ type: 'hikos:advisor:stream', v: 1, reqId: m.reqId, delta: '{"meta":{"theme":"渭水奇阵","description":"太公亲布雨夜伏击阵"}', chars: 52, provider: 'deepseek-flash' }), 60);
        setTimeout(() => send({ type: 'hikos:advisor:stream', v: 1, reqId: m.reqId, delta: ',"towers":[...],"waves":[...]}', chars: 128, provider: 'deepseek-flash' }), 140);
        // 第 3 轮或故意返回非法包让其回退以同时验证回退卡与按钮复位
        setTimeout(() => send({ type: 'hikos:advisor:reply', v: 1, reqId: m.reqId, ok: false, error: { code: 'UPSTREAM', message: 'stream test done' }, provider: 'deepseek-flash', latencyMs: 220 }), 260);
      } else {
        const slot = (m.snapshot.slots || []).find((s) => s.open);
        send({
          type: 'hikos:advisor:reply', v: 1, reqId: m.reqId, ok: true, provider: 'deepseek-flash', latencyMs: 35,
          payload: { v: 1, basedOn: m.stateVersion, say: '老夫观此波步卒将至，当守北路。', options: [{ id: 'a', title: '太公伏弩', why: '扼住咽喉。', moves: slot ? [{ slot: slot.id, tower: 'crossbow' }] : [] }], bet: { leaks: 0, line: '此阵必全歼敌军。' } }
        });
      }
    }
  });
  frame.src = './?v=1&skin=metropolis-riverside-3d&accent=356d73&bg=e8ede7&ink=354e52&theme=day&lang=zh';
</script></body></html>`;

  await page.route('**/__lobby-stream-host.html', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: lobbyHostHtml }));
  await page.goto('/__lobby-stream-host.html');
  const el = await page.waitForSelector('#game');
  const game = (await el.contentFrame())!;
  await game.waitForSelector('#lobby', { state: 'visible' });

  // 1) hikos:context 到达后，大厅明确署名频道智能体「姜尚 · 太公兵法」与人设，不再是「Hikos 宿主代理」
  await expect(game.locator('#lobby-who')).toContainText('姜尚 · 太公兵法');
  await expect(game.locator('#lobby-who')).not.toContainText('Hikos 宿主代理');
  await expect(game.locator('#lobby-persona')).toContainText('善布奇门阵法');
  await expect(game.locator('#lobby .lobby-adv-av')).toBeVisible();

  // 2) 点击「让军师设计」期间，流式进展实时出现在 #lobby-stream
  await game.click('#gen');
  await expect(game.locator('#lobby-stream')).toBeVisible();
  await expect(game.locator('#stream-stage')).toContainText('已流式输出');
  await expect(game.locator('#stream-parsed')).toContainText('渭水奇阵');

  // 3) 结果渲染出来后，#gen 按钮必须恢复为可点击的「让军师设计」，不再挂着 disabled 的「军师出题中…」
  await expect(game.locator('#go')).toBeVisible({ timeout: 5000 });
  const genBtn = game.locator('#gen');
  await expect(genBtn).toBeEnabled();
  await expect(genBtn).toHaveText('让军师设计');

  // 4) 进入战局后，底部 HUD #advisor 卡片同样署名「姜尚（太公兵法）」并展示头像与人设，且请求携带 agent 与人设提示词
  await game.click('#go');
  await expect(game.locator('#advisor .adv-title')).toContainText('军师 · 姜尚（太公兵法）');
  await expect(game.locator('#advisor .adv-avatar')).toBeVisible();
  await expect(game.locator('#adv-badge')).toContainText('姜尚 · LLM · deepseek-flash');
  const allReqs = await reqs(page);
  expect(allReqs.length).toBeGreaterThanOrEqual(2);
  expect((allReqs[0] as any).agent?.name).toBe('姜尚');
  expect(allReqs[0].llm.messages[0].content).toContain('姜尚');
  expect(allReqs[0].llm.messages[0].content).toContain('善布奇门阵法');
  expect(errors).toEqual([]);
});

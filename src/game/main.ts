// D1 presenter: fixed 30 tick/s accumulator loop; rendering only reads state, all rules in runtime.
// Hikos 嵌入（hikos.ts / skins.ts）：URL 参数 skin/accent/bg/ink/theme/lang 决定配色与文案，postMessage v1 与宿主握手（td:ready / td:state / td:exit）。
import { createBattle, step, checksum, TICKS_PER_SECOND, CELL } from '../runtime/index';
import type { BattleState, Command, GameEvent } from '../runtime/index';
import { DEFAULT_PACK } from '../content/default';
import { PALETTES, type Palette } from './palettes';
import { MockProvider } from '../ai/mock';
import { runPipeline, type Summary } from '../ai/pipeline';
import type { ContentPack } from '../runtime/index';
import { expandPath } from '../content/validate';
import { createHostBridge, type GameState, type HostContext } from './hikos';
import { paletteForContext } from './skins';

const params = new URLSearchParams(location.search);
const SEED = Number(params.get('seed') ?? 20261107) >>> 0;
const DEBUG = params.has('debug');
const TICK_MS = 1000 / TICKS_PER_SECOND;
const PX = 56; // px per cell
let pack: ContentPack = DEFAULT_PACK;
let PATH_CELLS = new Set(expandPath(pack.map.path.map((c) => [c.x, c.y] as [number, number])).cells.map((c) => c.join(',')));
const provider = new MockProvider();

// ---- 配色来源：① ?palette=default|neon|retro（旧 ?theme=<名> 仍认）② Hikos 皮肤（嵌入时 / 带 skin|accent 参数时）③ 内置 default
const legacyPalette = [params.get('palette'), params.get('theme')].find((k) => k && k in PALETTES) ?? null;
// ?debug 时把解析后的 query 与收到的 hikos:* 消息挂在 window.__q / window.__msgs：宿主侧 tools/addons/test-arcade.cjs 对真游戏跑协议断言的读点
const hostLog: Record<string, unknown>[] = [];
const bridge = createHostBridge(window, { onContext: applyContext, onVisibility: setHostVisible, onAny: (m) => { if (DEBUG) hostLog.push(m); } });
if (DEBUG) { (window as any).__q = Object.fromEntries(params); (window as any).__msgs = hostLog; }
const hikosMode = bridge.embedded || params.has('skin') || params.has('accent');
let currentTheme = legacyPalette ?? (hikosMode ? 'hikos' : 'default');
let theme: Palette = legacyPalette ? PALETTES[legacyPalette] : hikosMode ? paletteForContext(bridge.context) : PALETTES.default;
let lang = bridge.context.lang;

// 一次只显示一种语言（宿主规则）：HUD / 结算 / 按钮按 lang 切；军师议事（D2 大厅）暂只有中文
const STR = {
  zh: { base: '基地', gold: '金币', wave: '波次', build: '布防中', fight: '交战中', won: '胜利', lost: '失败', start: '出兵', restart: '重新开始', exit: '退出', theme: '主题:', held: '守住了！', fell: '基地失守', paused: '已暂停' },
  en: { base: 'Base', gold: 'Gold', wave: 'Wave', build: 'Build', fight: 'Fighting', won: 'Won', lost: 'Lost', start: 'Start wave', restart: 'Restart', exit: 'Exit', theme: 'Theme:', held: 'Held!', fell: 'Base fell', paused: 'Paused' },
} as const;
const t = (k: keyof typeof STR.zh) => STR[lang][k];

let state: BattleState = createBattle(pack, SEED);
let queue: Command[] = [];
let selected = pack.towers[0].id;
let inLobby = !params.has('skiplobby');
let speed = 1;
let paused = false;
let hostHidden = false;   // hikos:visibility:false → 冻结模拟、停止重绘（相当于暂停），回来时自动恢复
let toast = '';
let toastUntil = 0;

interface Particle { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; color: string; }
const particles: Particle[] = [];
const shots: { fx: number; fy: number; tx: number; ty: number; until: number }[] = [];
const recorded: { tick: number; cmds: Command[] }[] = [];

const root = document.getElementById('game-container')!;
root.innerHTML = '';
const canvas = document.createElement('canvas');
canvas.width = pack.map.width * PX;
canvas.height = pack.map.height * PX;
canvas.id = 'board';
const hud = document.createElement('div');
hud.id = 'hud';
const dbg = document.createElement('pre');
dbg.id = 'debug';
dbg.style.display = DEBUG ? 'block' : 'none';
root.append(hud, canvas, dbg);
const ctx = canvas.getContext('2d')!;

function applyPalette() {
  const r = document.documentElement.style;
  r.setProperty('--td-bg', theme.bg);
  r.setProperty('--td-paper', theme.paper ?? '#2b3846');
  r.setProperty('--td-ink', theme.ink ?? theme.text);
  r.setProperty('--td-hair', theme.hair ?? '#555');
  r.setProperty('--td-accent', theme.accent ?? '#ffd36a');
  r.setProperty('--td-danger', theme.danger ?? '#ff9a8a');
  document.documentElement.dataset.theme = hikosMode ? bridge.context.theme : 'night';
  document.documentElement.lang = lang;
}
function applyContext(c: HostContext) {
  lang = c.lang;
  if (!legacyPalette) { theme = paletteForContext(c); currentTheme = 'hikos'; }
  applyPalette();
  renderHud();
}
function setHostVisible(visible: boolean) {
  hostHidden = !visible;
  if (visible) { last = performance.now(); acc = 0; }
  renderHud();
}
applyPalette();

// ---- 向宿主报状态（td:state）：只在变化时发；宿主只用它改窗口标题角标
function gameState(): GameState {
  if (state.phase === 'won') return 'won';
  if (state.phase === 'lost') return 'lost';
  if (inLobby) return 'idle';
  if (paused || hostHidden) return 'paused';
  return 'playing';
}
function reportState() { bridge.state(gameState()); }

function renderHud() {
  const s = state;
  const phaseText = { build: t('build'), wave: t('fight'), won: t('won'), lost: t('lost') }[s.phase];
  hud.innerHTML = '';
  const info = document.createElement('span');
  info.className = 'stats';
  info.textContent = `${t('base')} ${s.base_hp}/${pack.map.base_hp}　${t('gold')} ${s.gold}　${t('wave')} ${s.wave_index}/${pack.waves.length}　${paused || hostHidden ? t('paused') : phaseText}`;
  hud.append(info);
  for (const tw of pack.towers) {
    const b = document.createElement('button');
    b.textContent = `${tw.display_name} ${tw.cost}`;
    b.dataset.tower = tw.id;
    if (tw.id === selected) b.className = 'sel';
    b.disabled = s.gold < tw.cost || s.phase === 'won' || s.phase === 'lost';
    b.onclick = () => { selected = tw.id; renderHud(); };
    hud.append(b);
  }
  const w = document.createElement('button');
  w.id = 'start-wave';
  w.textContent = s.phase === 'won' || s.phase === 'lost' ? t('restart') : t('start');
  w.disabled = s.phase === 'wave';
  w.onclick = () => {
    if (s.phase === 'won' || s.phase === 'lost') { startWith(pack); showLobby(); }
    else queue.push({ type: 'start_wave' });
  };
  hud.append(w);

  if (!hikosMode) {
    // 独立页才有主题下拉；嵌在 Hikos 里配色由宿主皮肤决定
    const tb = document.createElement('select');
    tb.id = 'theme-select';
    for (const k of Object.keys(PALETTES)) {
      const opt = document.createElement('option'); opt.value = k; opt.textContent = t('theme') + k;
      if (k === currentTheme) opt.selected = true;
      tb.appendChild(opt);
    }
    tb.onchange = (e) => {
      currentTheme = (e.target as HTMLSelectElement).value;
      theme = PALETTES[currentTheme];
      applyPalette();
      const url = new URL(location.href); url.searchParams.set('palette', currentTheme); url.searchParams.delete('theme'); history.replaceState(null, '', url);
    };
    hud.append(tb);
  }
  if (bridge.embedded) {
    const x = document.createElement('button');
    x.id = 'td-exit'; x.className = 'exit'; x.textContent = t('exit');
    x.onclick = () => bridge.exit();
    hud.append(x);
  }

  if (toast && performance.now() < toastUntil) {
    const m = document.createElement('span'); m.className = 'toast'; m.textContent = toast; hud.append(m);
  }
  reportState();
  fit();
}

// ---- 嵌入时把画布缩放到容器里（任意宽高比、最小 480×360 可玩；接入说明 §1.3）
let fitRaf = 0;
function fit() {
  if (!bridge.embedded) return;
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    const availW = Math.max(200, document.documentElement.clientWidth - 20);
    const availH = Math.max(200, document.documentElement.clientHeight - hud.offsetHeight - 30);
    const scale = Math.min(availW / canvas.width, availH / canvas.height, 2);
    canvas.style.width = `${Math.floor(canvas.width * scale)}px`;
    canvas.style.height = `${Math.floor(canvas.height * scale)}px`;
  });
}
window.addEventListener('resize', fit);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(document.documentElement);

canvas.addEventListener('click', (ev) => {
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - r.left) / r.width) * pack.map.width);
  const y = Math.floor(((ev.clientY - r.top) / r.height) * pack.map.height);
  queue.push({ type: 'build', tower_id: selected, x, y });
});

// 触控：只注册一次；touchend 里 preventDefault 抑制浏览器随后合成的 click，避免一次点触建两座塔
canvas.addEventListener('touchend', (e) => {
  const tp = e.changedTouches[0];
  if (!tp) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((tp.clientX - r.left) / r.width) * pack.map.width);
  const y = Math.floor(((tp.clientY - r.top) / r.height) * pack.map.height);
  queue.push({ type: 'build', tower_id: selected, x, y });
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (e.key === 'F1' || e.key === '`') { e.preventDefault(); dbg.style.display = dbg.style.display === 'none' ? 'block' : 'none'; }
  if (dbg.style.display === 'none') return;
  if (e.key === 'p') { paused = !paused; renderHud(); }
  if (e.key === '1' || e.key === '2' || e.key === '4') speed = Number(e.key);
  if (e.key === 'g') queue.push({ type: 'debug_add_gold', amount: 100 });
  if (e.key === 'n') queue.push({ type: 'debug_next_wave' });
});

function onEvents(evs: GameEvent[]) {
  const now = performance.now();
  for (const e of evs) {
    if (e.type === 'build_rejected' || e.type === 'wave_rejected') { toast = e.message; toastUntil = now + 1800; }
    if (e.type === 'attack') shots.push({ fx: e.fx, fy: e.fy, tx: e.tx, ty: e.ty, until: now + 90 });

    if (e.type === 'wave_cleared') {
      const btn = document.getElementById('start-wave');
      if (btn) btn.style.display = 'block';
    }
    if (e.type === 'entity_died' && !bridge.context.reducedMotion) {
      for (let i = 0; i < 15; i++) {
        particles.push({
          x: toPx(e.x), y: toPx(e.y),
          vx: (Math.random() - 0.5) * 100, vy: (Math.random() - 0.5) * 100,
          life: 0.5 + Math.random() * 0.5, maxLife: 1.0, color: theme.danger ?? '#f55'
        });
      }
    }

  }
}

function tickOnce() {
  const cmds = queue; queue = [];
  if (cmds.length) recorded.push({ tick: state.tick, cmds });
  const r = step(state, cmds);
  state = r.state;
  onEvents(r.events);
  const dt = 1 / TICKS_PER_SECOND;
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].x += particles[i].vx * dt;
    particles[i].y += particles[i].vy * dt;
    particles[i].life -= dt;
    if (particles[i].life <= 0) particles.splice(i, 1);
  }

  if (r.events.length || cmds.length) renderHud();
}

const toPx = (m: number) => (m / CELL) * PX;
function draw() {
  const s = state;
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < pack.map.height; y++) {
    for (let x = 0; x < pack.map.width; x++) {
      const isPath = PATH_CELLS.has(`${x},${y}`);
      ctx.fillStyle = isPath ? (((x + y) % 2) ? theme.path : theme.pathAlt) : (((x + y) % 2) ? theme.grid1 : theme.grid2);
      ctx.fillRect(x * PX, y * PX, PX, PX);
    }
  }

  const end = pack.map.path[pack.map.path.length - 1];
  ctx.fillStyle = theme.base;
  ctx.fillRect(end.x * PX + 8, end.y * PX + 8, PX - 16, PX - 16);

  for (const tw of s.towers) {
    const def = pack.towers.find((d) => d.id === tw.def)!;
    // Hikos 皮肤：塔身用建筑主体色、塔顶 / 炮口用 accent（接入说明 §3.4）；内置配色沿用内容包里的塔色
    ctx.fillStyle = theme.tower ?? def.color ?? '#fff'; ctx.globalAlpha = tw.life === 'pending' ? 0.5 : 1;
    // 带有阴影的基座
    ctx.beginPath();
    ctx.roundRect(tw.cx * PX + 10, tw.cy * PX + 10, PX - 20, PX - 20, 6);
    ctx.fill();
    if (theme.tower) {
      ctx.strokeStyle = theme.hair ?? theme.text; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(tw.cx * PX + 10, tw.cy * PX + 10, PX - 20, PX - 20, 6); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // 绘制简易枪管
    ctx.fillStyle = theme.tower ? (def.color ?? theme.accent ?? theme.base) : theme.bg;
    ctx.beginPath(); ctx.arc(tw.cx * PX + PX / 2, tw.cy * PX + PX / 2, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = theme.text; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(def.display_name[0], tw.cx * PX + PX / 2, tw.cy * PX + PX / 2 + 3);
  }

  for (const e of s.enemies) {
    const def = pack.enemies.find((d) => d.id === e.def)!;
    const x = toPx(e.x), y = toPx(e.y);
    ctx.fillStyle = theme.danger ?? def.color ?? '#f00';
    ctx.beginPath();
    ctx.moveTo(x, y - PX * 0.25); ctx.lineTo(x + PX * 0.2, y + PX * 0.2); ctx.lineTo(x - PX * 0.2, y + PX * 0.2);
    ctx.fill();

    // 血条
    ctx.fillStyle = theme.ink ? 'rgba(0,0,0,.45)' : '#000'; ctx.fillRect(x - 12, y - 22, 24, 4);
    ctx.fillStyle = theme.ok ?? '#7CFC7C'; ctx.fillRect(x - 12, y - 22, 24 * Math.max(0, e.hp) / def.hp, 4);
  }

  // 粒子
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  const now = performance.now();
  ctx.strokeStyle = theme.shot; ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = shots.length - 1; i >= 0; i--) {
    const sh = shots[i];
    if (now > sh.until) { shots.splice(i, 1); continue; }
    ctx.globalAlpha = Math.max(0, (sh.until - now) / 90);
    ctx.beginPath(); ctx.moveTo(toPx(sh.fx), toPx(sh.fy)); ctx.lineTo(toPx(sh.tx), toPx(sh.ty)); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if (s.phase === 'won' || s.phase === 'lost') {
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = theme.paper ?? theme.text; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(s.phase === 'won' ? t('held') : t('fell'), canvas.width / 2, canvas.height / 2);
  }
  if (dbg.style.display !== 'none') {
    dbg.textContent = `DEBUG  seed=${s.seed} tick=${s.tick} checksum=${checksum(s)}\n` +
      `speed=${speed}x paused=${paused} hidden=${hostHidden} enemies=${s.enemies.length} towers=${s.towers.length} kills=${s.kills} leaks=${s.leaks}\n` +
      `host: embedded=${bridge.embedded} skin=${bridge.context.skin ?? '-'} theme=${bridge.context.theme} lang=${lang} palette=${currentTheme}\n` +
      `keys: p 暂停 · 1/2/4 倍速 · g +100金 · n 下一波 · F1/\` 开关\n` +
      `cmds=${JSON.stringify(recorded.slice(-3))}`;
  }
}

let acc = 0; let last = performance.now();
let firstFrame = true;
function frame(now: number) {
  acc += Math.min(250, now - last) * (paused || inLobby || hostHidden ? 0 : speed); last = now;
  let n = 0;
  while (acc >= TICK_MS && n < 16) { tickOnce(); acc -= TICK_MS; n++; }
  if (!hostHidden || firstFrame) draw();
  if (firstFrame) { firstFrame = false; bridge.ready(); reportState(); }   // 首帧可交互后向宿主报 td:ready（接入说明 §1.6）
  requestAnimationFrame(frame);
}

// ---- D2 lobby: describe -> Mock 军师 -> validate -> dry-run -> summary card -> 开始 / 再改改 ----
const lobby = document.createElement('div');
lobby.id = 'lobby';
root.append(lobby);
function esc(tx: string) { return tx.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }
function showLobby(sum?: Summary, text = '') {
  inLobby = true; lobby.style.display = 'block';
  lobby.innerHTML = `<div class="card"><h3>军师议事 <small>${esc(provider.name)}</small></h3>
  <textarea id="desc" rows="2" placeholder="描述你想要的战局，例如：长坂坡雨夜，人海战术">${esc(text)}</textarea>
  <div class="row"><button id="gen">让军师设计</button></div>
  <div id="summary"></div></div>`;
  const out = lobby.querySelector('#summary')!;
  if (sum) {
    const dr = sum.dryrun.map((d) => `${d.bot === 'greedy' ? '贪心放塔' : '不放塔'}：${d.result === 'won' ? '胜' : d.result === 'lost' ? '负' : '超时'}（基地剩 ${d.base_hp}，漏 ${d.leaks}）`).join('；');
    out.innerHTML = `<p class="echo">${esc(sum.echo)}</p>
    <p>塔：${esc(sum.towers.join('、'))}<br>怪：${esc(sum.enemies.join('、'))}<br>波次：${sum.waves.map((w, i) => `${i + 1}(${w.total})`).join(' ')}</p>
    <p class="dry">预演：${esc(dr)}</p>
    ${sum.warnings.map((w) => `<p class="warn">⚠ ${esc(w.message)}</p>`).join('')}
    ${sum.errors.slice(0, 5).map((e) => `<p class="err">✗ ${esc(e.message)}（${esc(e.path)}）</p>`).join('')}
    <div class="row"><button id="go">开始</button><button id="again">再改改</button></div>`;
    out.querySelector('#go')!.addEventListener('click', () => startWith(sum.pack));
    out.querySelector('#again')!.addEventListener('click', () => (lobby.querySelector('#desc') as HTMLTextAreaElement).focus());
  }
  lobby.querySelector('#gen')!.addEventListener('click', () => {
    const tx = (lobby.querySelector('#desc') as HTMLTextAreaElement).value.trim() || '长坂坡雨夜';
    showLobby(runPipeline(provider, tx), tx);
  });
  reportState();
}
function startWith(p: ContentPack) {
  pack = p;
  PATH_CELLS = new Set(expandPath(pack.map.path.map((c) => [c.x, c.y] as [number, number])).cells.map((c) => c.join(',')));
  canvas.width = pack.map.width * PX; canvas.height = pack.map.height * PX;
  selected = pack.towers[0].id;
  state = createBattle(pack, SEED); recorded.length = 0; shots.length = 0; queue = [];
  inLobby = false; lobby.style.display = 'none'; renderHud();
}
(window as any).__lobby = { gen: (tx: string) => showLobby(runPipeline(provider, tx), tx) };
if (inLobby) showLobby(); else lobby.style.display = 'none';
renderHud();
requestAnimationFrame(frame);
(window as any).__td = { get state() { return state; }, checksum: () => checksum(state), recorded, get host() { return { embedded: bridge.embedded, origin: bridge.origin, context: bridge.context, hidden: hostHidden, palette: currentTheme }; } };

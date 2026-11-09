// D1 presenter: fixed 30 tick/s accumulator loop; rendering only reads state, all rules in runtime.
// Hikos 嵌入（hikos.ts / skins.ts）：URL 参数 skin/accent/bg/ink/theme/lang 决定配色与文案，postMessage v1 与宿主握手（td:ready / td:state / td:exit）。
// 军师（src/advisor/，任务 fb4d93bc / d9ad7e7a / 94bbcebe / 997eeae6）：?advisor=local|host|<url> 选通道；会话每 tick 前后各一个钩子；
// 采纳只产出 build 命令走同一条校验；卡片见 advisorCard.ts，聊天式自然语言格式化见 chatFormat.ts。
import { createBattle, step, checksum, TICKS_PER_SECOND, CELL } from '../runtime/index';
import type { BattleState, Command, GameEvent } from '../runtime/index';
import { DEFAULT_PACK } from '../content/default';
import { PALETTES, type Palette } from './palettes';
import { MockProvider } from '../ai/mock';
import { runPipeline, runPipelineAsync, type LevelStreamProgress, type Summary } from '../ai/pipeline';
import { LlmContentProvider } from '../ai/llm';
import type { ContentPack } from '../runtime/index';
import { expandPath } from '../content/validate';
import { createHostBridge, type GameState, type HostContext, type HostSettlementReply } from './hikos';
import { paletteForContext } from './skins';
import { AdvisorSession, HostChannel, selectChannel, type AdvisorAgent, type AdvisorView } from '../advisor/index';
import { slotCell } from '../advisor/snapshot';
import { renderAdvisorCard, drawAdvisorOverlay } from './advisorCard';
import { createSpatialProjector, drawSpatialBattlefield, getMinionModelKind, type SpatialProjector } from './spatialMap';
import { cleanTechTerms, escHtml, extractNaturalAdvisorSpeech } from './chatFormat';

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
const advisorReplyCbs: ((m: Record<string, unknown>) => void)[] = [];
const advisorStreamCbs: ((m: Record<string, unknown>) => void)[] = [];
const settleReplyCbs: ((m: HostSettlementReply) => void)[] = [];
const explicitInsitu = params.get('insitu');
const bridge = createHostBridge(window, {
  onContext: applyContext,
  onVisibility: setHostVisible,
  onMap: () => { applyPalette(); syncProjector(); },
  onSize: () => { syncProjector(); fit(); },
  onAdvisorReply: (m) => { for (const cb of advisorReplyCbs) cb(m); },
  onAdvisorStream: (m) => { for (const cb of advisorStreamCbs) cb(m); },
  onSettleReply: (m) => { onHostSettleReply(m); for (const cb of settleReplyCbs) cb(m); },
  onAny: (m) => { if (DEBUG) hostLog.push(m); },
});
if (DEBUG) { (window as any).__q = Object.fromEntries(params); (window as any).__msgs = hostLog; }
const hikosMode = bridge.embedded || params.has('skin') || params.has('accent');
const isInsitu = () => explicitInsitu === '0' ? false : (explicitInsitu === '1' || explicitInsitu === 'true' || bridge.embedded || !!bridge.context.insitu || !!bridge.context.map);
let currentProjector: SpatialProjector | null = null;
let hoverCell: { cx: number; cy: number; slot: number } | null = null;
let currentTheme = legacyPalette ?? (hikosMode ? 'hikos' : 'default');
let theme: Palette = legacyPalette ? PALETTES[legacyPalette] : hikosMode ? paletteForContext(bridge.context) : PALETTES.default;
let lang = bridge.context.lang;

// 一次只显示一种语言（宿主规则）：HUD / 结算 / 按钮按 lang 切；彻底去除“金币”概念，统一使用 CP（大厅 #25804 ④）
const STR = {
  zh: { base: '基地', gold: 'CP', wave: '波次', build: '布防中', fight: '交战中', won: '胜利', lost: '失败', start: '出兵', restart: '重新开始', exit: '退出', theme: '主题:', held: '守住了！', fell: '基地失守', paused: '已暂停', revenge: '复仇一局', revenging: '军师出题中…', wallet: '账户' },
  en: { base: 'Base', gold: 'CP', wave: 'Wave', build: 'Build', fight: 'Fighting', won: 'Won', lost: 'Lost', start: 'Start wave', restart: 'Restart', exit: 'Exit', theme: 'Theme:', held: 'Held!', fell: 'Base fell', paused: 'Paused', revenge: 'Revenge round', revenging: 'Advisor is designing…', wallet: 'Wallet' },
} as const;
const t = (k: keyof typeof STR.zh) => STR[lang][k];

// 单局 CP 结算量级（大厅 #25804 ④：胜利 +10 CP，失败 -10 CP）
export const MATCH_WIN_CP = 10;
export const MATCH_LOSS_CP = -10;
let matchSeq = 1;
let settledMatchSeq = 0;
let localWalletCp = 1000;
let lastSettlement: {
  matchId: string;
  outcome: 'won' | 'lost';
  deltaCp: number;
  appliedCp: number;
  balanceCp: number;
  status: 'pending' | 'settled';
} | null = null;

// ---- 军师通道与会话：嵌入缺省走宿主代理，独立缺省走本地模板，?advisor= 可切；凭据与端点永远不在这里
let hostChannel: HostChannel | null = null;
const advisorSel = selectChannel({
  search: location.search, embedded: bridge.embedded,
  makeHost: () => (hostChannel = new HostChannel((m) => bridge.send(m), (cb) => advisorReplyCbs.push(cb), '频道智能体军师', () => Date.now(), (cb) => advisorStreamCbs.push(cb))),
});
const session = new AdvisorSession({ channel: advisorSel.channel, lang, tactical: !params.has('notactical'), onChange: () => scheduleCard() });
const llmLevelProvider = advisorSel.channel ? new LlmContentProvider(advisorSel.channel, { lang }) : null;

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
const advisorBox = document.createElement('div');
advisorBox.id = 'advisor';
root.append(hud, canvas, advisorBox, dbg);
const ctx = canvas.getContext('2d')!;

// ---- 军师卡片：会话一变就重画（合并到下一帧）；点击只回灌命令 / 开关
let cardRaf = 0;
let cardView: AdvisorView = session.view();
function scheduleCard() { cancelAnimationFrame(cardRaf); cardRaf = requestAnimationFrame(renderCard); }
function renderCard() {
  cardView = session.view();
  advisorBox.style.display = inLobby && !isInsitu() ? 'none' : 'block';
  renderAdvisorCard(advisorBox, cardView, pack, lang, state.phase, {
    adopt: (id) => {
      if (inLobby) enterBattleInSitu();
      queue.push(...session.adopt(id));
    },
    takeGambit: () => {
      if (inLobby) enterBattleInSitu();
      const c = session.takeGambit();
      if (c) queue.push(c);
    },
    setAutopilot: (on) => session.setAutopilot(on),
  });
  fit();
}

function syncProjector() {
  if (isInsitu()) {
    const vw = Math.max(320, document.documentElement.clientWidth || window.innerWidth || 960);
    const vh = Math.max(240, document.documentElement.clientHeight || window.innerHeight || 640);
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }
    currentProjector = createSpatialProjector(pack, vw, vh, bridge.context.map ?? null);
  } else {
    const gw = pack.map.width * PX, gh = pack.map.height * PX;
    if (canvas.width !== gw || canvas.height !== gh) {
      canvas.width = gw;
      canvas.height = gh;
    }
    currentProjector = null;
  }
}

function applyPalette() {
  const r = document.documentElement.style;
  r.setProperty('--td-bg', theme.bg);
  r.setProperty('--td-paper', theme.paper ?? '#2b3846');
  r.setProperty('--td-ink', theme.ink ?? theme.text);
  r.setProperty('--td-hair', theme.hair ?? '#555');
  r.setProperty('--td-accent', theme.accent ?? '#ffd36a');
  r.setProperty('--td-danger', theme.danger ?? '#ff9a8a');
  r.setProperty('--td-ok', theme.ok ?? '#338a72');
  const effectiveTheme = hikosMode ? bridge.context.theme : 'night';
  document.documentElement.dataset.theme = effectiveTheme;
  // 关键修复（#25648 ⑤）：同步设置 iframe :root 的 color-scheme 与宿主页面一致，防止 WebKit/Blink 在夜色皮肤下给 iframe 强制绘制 #ffffff 不透明白底
  r.colorScheme = effectiveTheme === 'night' ? 'dark' : 'light';
  document.documentElement.dataset.insitu = isInsitu() ? 'true' : 'false';
  if (bridge.context.skin) document.documentElement.dataset.skin = bridge.context.skin;
  document.documentElement.lang = lang;
}
function applyContext(c: HostContext) {
  lang = c.lang;
  session.lang = c.lang;
  if (llmLevelProvider) llmLevelProvider.lang = c.lang;
  const agent: AdvisorAgent | null = c.advisor?.agent ?? null;
  hostChannel?.setAgent(agent);
  session.setAgent(agent);
  llmLevelProvider?.setAgent(agent);
  if (c.wallet && typeof c.wallet.balanceCp === 'number' && Number.isFinite(c.wallet.balanceCp)) {
    localWalletCp = Math.round(c.wallet.balanceCp);
  }
  // 宿主 context 一到就定军师可用性：没配（enabled:false）或老宿主（没有 advisor 字段）→ 不白等截止，秒切本地；排队中的请求随之放行 / 作废
  hostChannel?.setAvailable(c.advisor?.enabled === true);
  if (!legacyPalette) { theme = paletteForContext(c); currentTheme = 'hikos'; }
  applyPalette();
  syncProjector();
  if (inLobby) refreshLobbyIdentity();
  renderHud();
  scheduleCard();
}

function onHostSettleReply(sr: HostSettlementReply) {
  if (typeof sr.balanceCp === 'number' && Number.isFinite(sr.balanceCp)) {
    localWalletCp = Math.round(sr.balanceCp);
  }
  lastSettlement = {
    matchId: sr.matchId || lastSettlement?.matchId || `td-${state.seed}-${matchSeq}`,
    outcome: sr.outcome,
    deltaCp: sr.deltaCp,
    appliedCp: sr.appliedCp,
    balanceCp: typeof sr.balanceCp === 'number' ? Math.round(sr.balanceCp) : localWalletCp,
    status: 'settled',
  };
  renderHud();
}

function settleCurrentMatch(outcome: 'won' | 'lost') {
  if (settledMatchSeq === matchSeq) return;
  settledMatchSeq = matchSeq;
  const deltaCp = outcome === 'won' ? MATCH_WIN_CP : MATCH_LOSS_CP;
  const matchId = `td-${state.seed}-${matchSeq}-${state.tick}-${checksum(state)}`;
  localWalletCp = Math.max(0, localWalletCp + deltaCp);
  lastSettlement = {
    matchId,
    outcome,
    deltaCp,
    appliedCp: deltaCp,
    balanceCp: localWalletCp,
    status: bridge.embedded ? 'pending' : 'settled',
  };
  if (!firstFrame) {
    bridge.send({
      type: 'td:settle:request',
      v: 1,
      matchId,
      outcome,
      deltaCp,
      wavesCleared: state.wave_index,
      totalWaves: pack.waves.length,
      baseHp: state.base_hp,
      maxBaseHp: pack.map.base_hp,
      kills: state.kills,
      leaks: state.leaks,
      checksum: checksum(state),
    });
  }
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
  if ((s.phase === 'won' || s.phase === 'lost') && settledMatchSeq !== matchSeq) {
    settleCurrentMatch(s.phase);
  }
  const phaseText = { build: t('build'), wave: t('fight'), won: t('won'), lost: t('lost') }[s.phase];
  hud.innerHTML = '';
  const info = document.createElement('span');
  info.className = 'stats';
  info.textContent = `${t('base')} ${s.base_hp}/${pack.map.base_hp}　${t('gold')} ${s.gold}　${t('wave')} ${s.wave_index}/${pack.waves.length}　${paused || hostHidden ? t('paused') : phaseText}`;
  hud.append(info);

  const cpChip = document.createElement('span');
  cpChip.id = 'td-cp-settlement';
  const walletCp = bridge.context.wallet?.balanceCp ?? localWalletCp;
  if (s.phase === 'won' || s.phase === 'lost') {
    const delta = lastSettlement?.deltaCp ?? (s.phase === 'won' ? MATCH_WIN_CP : MATCH_LOSS_CP);
    const sign = delta > 0 ? `+${delta}` : `${delta}`;
    cpChip.className = `stats cp-badge ${s.phase === 'won' ? 'cp-won' : 'cp-lost'}`;
    cpChip.dataset.deltaCp = String(delta);
    cpChip.dataset.balanceCp = String(lastSettlement?.balanceCp ?? walletCp);
    cpChip.textContent = lang === 'zh'
      ? `结算 ${sign} CP · ${t('wallet')} ${lastSettlement?.balanceCp ?? walletCp} CP`
      : `Settle ${sign} CP · ${t('wallet')} ${lastSettlement?.balanceCp ?? walletCp} CP`;
  } else {
    cpChip.className = 'stats cp-badge';
    cpChip.dataset.balanceCp = String(walletCp);
    cpChip.textContent = lang === 'zh'
      ? `${t('wallet')} ${walletCp} CP（胜+${MATCH_WIN_CP}/败${MATCH_LOSS_CP}）`
      : `${t('wallet')} ${walletCp} CP (+${MATCH_WIN_CP}/${MATCH_LOSS_CP})`;
  }
  hud.append(cpChip);

  // 下一波预览：军师快照里的 wave.next 就是这一行——军师知道的，玩家同样看得见（#24353「不泄露玩家尚不可见的信息」）
  const nextWave = s.phase === 'build' ? pack.waves[s.wave_index] : null;
  if (nextWave) {
    const counts = new Map<string, number>();
    for (const g of nextWave.groups) counts.set(g.enemy_id, (counts.get(g.enemy_id) ?? 0) + g.count);
    const preview = document.createElement('span');
    preview.className = 'stats next-wave'; preview.id = 'td-next-wave';
    preview.textContent = `${lang === 'zh' ? '下一波' : 'Next'}：${[...counts].map(([id, n]) => `${pack.enemies.find((e) => e.id === id)?.display_name ?? id}×${n}`).join(lang === 'zh' ? '、' : ', ')}`;
    hud.append(preview);
  }
  for (const tw of pack.towers) {
    const b = document.createElement('button');
    b.textContent = `${tw.display_name} ${tw.cost} CP`;
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
    else {
      if (inLobby) enterBattleInSitu();
      queue.push({ type: 'start_wave' });
    }
  };
  hud.append(w);
  if (s.phase === 'won' || s.phase === 'lost') {
    // 复仇一局（玩法增强 ③）：把这局的战报交给关卡设计军师，出一张针对你弱点的关
    const rv = document.createElement('button');
    rv.id = 'td-revenge'; rv.textContent = revenging ? t('revenging') : t('revenge'); rv.disabled = revenging;
    rv.onclick = () => { void revenge(); };
    hud.append(rv);
  }

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

// ---- 嵌入时把画布缩放到容器里（任意宽高比、最小 480×360 可玩；原位模式下画布与 #hub-view 视口 1:1 叠合，并动态同步 #hud 下缘安全距）
let fitRaf = 0;
function fit() {
  if (isInsitu()) {
    cancelAnimationFrame(fitRaf);
    fitRaf = requestAnimationFrame(() => {
      syncProjector();
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const hudBottom = Math.max(56, Math.ceil((hud.offsetTop || 10) + (hud.offsetHeight || 36) + 10));
      document.documentElement.style.setProperty('--td-hud-bottom', `${hudBottom}px`);
    });
    return;
  }
  if (!bridge.embedded) return;
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    const availW = Math.max(200, document.documentElement.clientWidth - 20);
    const availH = Math.max(200, document.documentElement.clientHeight - hud.offsetHeight - advisorBox.offsetHeight - 38);
    const scale = Math.min(availW / canvas.width, availH / canvas.height, 2);
    canvas.style.width = `${Math.floor(canvas.width * scale)}px`;
    canvas.style.height = `${Math.floor(canvas.height * scale)}px`;
  });
}
window.addEventListener('resize', fit);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(document.documentElement);

function resolveClientCell(clientX: number, clientY: number): { x: number; y: number; slot: number } {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return { x: -1, y: -1, slot: -1 };
  if (isInsitu()) {
    if (!currentProjector) syncProjector();
    const sx = ((clientX - r.left) / r.width) * canvas.width;
    const sy = ((clientY - r.top) / r.height) * canvas.height;
    const hit = currentProjector!.screenToCell(sx, sy);
    return { x: hit.cx, y: hit.cy, slot: hit.slot };
  }
  return {
    x: Math.floor(((clientX - r.left) / r.width) * pack.map.width),
    y: Math.floor(((clientY - r.top) / r.height) * pack.map.height),
    slot: -1,
  };
}

function enterBattleInSitu() {
  if (!inLobby) return;
  inLobby = false;
  lobby.style.display = 'none';
  session.reset(state);
  renderHud();
  scheduleCard();
}

let pointerDrag: { startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null = null;
canvas.addEventListener('pointerdown', (ev) => {
  if (!isInsitu() || ev.button !== 0) return;
  pointerDrag = { startX: ev.clientX, startY: ev.clientY, lastX: ev.clientX, lastY: ev.clientY, moved: false };
});
canvas.addEventListener('pointermove', (ev) => {
  if (isInsitu()) {
    const hit = resolveClientCell(ev.clientX, ev.clientY);
    hoverCell = hit.x >= 0 && hit.x < pack.map.width && hit.y >= 0 && hit.y < pack.map.height ? { cx: hit.x, cy: hit.y, slot: hit.slot } : null;
    if (pointerDrag) {
      const dx = ev.clientX - pointerDrag.lastX;
      const dy = ev.clientY - pointerDrag.lastY;
      if (Math.hypot(ev.clientX - pointerDrag.startX, ev.clientY - pointerDrag.startY) > 8) {
        pointerDrag.moved = true;
        bridge.send({ type: 'td:camera', kind: ev.shiftKey ? 'pan' : 'rotate', dx, dy });
      }
      pointerDrag.lastX = ev.clientX;
      pointerDrag.lastY = ev.clientY;
    }
  }
});
canvas.addEventListener('pointerleave', () => {
  hoverCell = null;
  pointerDrag = null;
});
canvas.addEventListener('wheel', (ev) => {
  if (!isInsitu()) return;
  ev.preventDefault();
  bridge.send({ type: 'td:camera', kind: 'zoom', dy: ev.deltaY });
}, { passive: false });

canvas.addEventListener('click', (ev) => {
  if (pointerDrag?.moved) { pointerDrag = null; return; }
  pointerDrag = null;
  const { x, y } = resolveClientCell(ev.clientX, ev.clientY);
  if (inLobby) enterBattleInSitu();
  queue.push({ type: 'build', tower_id: selected, x, y });
  session.notePlayerBuild();
});

// 触控：只注册一次；touchend 里 preventDefault 抑制浏览器随后合成的 click，避免一次点触建两座塔
canvas.addEventListener('touchend', (e) => {
  const tp = e.changedTouches[0];
  if (!tp) return;
  e.preventDefault();
  const { x, y } = resolveClientCell(tp.clientX, tp.clientY);
  if (inLobby) enterBattleInSitu();
  queue.push({ type: 'build', tower_id: selected, x, y });
  session.notePlayerBuild();
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
    if (e.type === 'battle_ended') {
      settleCurrentMatch(e.result);
    }
    if (e.type === 'entity_died' && !bridge.context.reducedMotion) {
      const pt = isInsitu() && currentProjector ? currentProjector.milliToScreen(e.x, e.y) : { x: toPx(e.x), y: toPx(e.y) };
      for (let i = 0; i < 15; i++) {
        particles.push({
          x: pt.x, y: pt.y,
          vx: (Math.random() - 0.5) * 100, vy: (Math.random() - 0.5) * 100,
          life: 0.5 + Math.random() * 0.5, maxLife: 1.0, color: theme.danger ?? '#f55'
        });
      }
    }

  }
}

function tickOnce() {
  queue.push(...session.beforeTick());   // 托管采纳等异步产生的命令，与玩家命令同队同校验
  const cmds = queue; queue = [];
  if (cmds.length) recorded.push({ tick: state.tick, cmds });
  const r = step(state, cmds);
  state = r.state;
  onEvents(r.events);
  session.afterTick(state, r.events);
  const dt = 1 / TICKS_PER_SECOND;
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].x += particles[i].vx * dt;
    particles[i].y += particles[i].vy * dt;
    particles[i].life -= dt;
    if (particles[i].life <= 0) particles.splice(i, 1);
  }

  if (r.events.length || cmds.length) renderHud();
  if (r.events.some((e) => e.type === 'wave_started' || e.type === 'wave_cleared' || e.type === 'battle_ended' || e.type === 'gambit_accepted')) scheduleCard();
}

const toPx = (m: number) => (m / CELL) * PX;
function draw() {
  const s = state;
  const walletCp = lastSettlement?.balanceCp ?? bridge.context.wallet?.balanceCp ?? localWalletCp;
  const settlementText = (s.phase === 'won' || s.phase === 'lost')
    ? (lang === 'zh'
        ? `本局结算 ${s.phase === 'won' ? `+${MATCH_WIN_CP}` : MATCH_LOSS_CP} CP · ${t('wallet')} ${walletCp} CP`
        : `Match ${s.phase === 'won' ? `+${MATCH_WIN_CP}` : MATCH_LOSS_CP} CP · ${t('wallet')} ${walletCp} CP`)
    : undefined;
  if (isInsitu()) {
    if (!currentProjector) syncProjector();
    drawSpatialBattlefield(ctx, s, pack, theme, currentProjector!, {
      pathCells: PATH_CELLS,
      cardView,
      selectedTowerId: selected,
      hoverCell,
      shots,
      particles,
      now: performance.now(),
      inLobby,
      lang,
      heldText: t('held'),
      fellText: t('fell'),
      settlementText,
    });
    if (dbg.style.display !== 'none') {
      dbg.textContent = `DEBUG  seed=${s.seed} tick=${s.tick} checksum=${checksum(s)}\n` +
        `speed=${speed}x paused=${paused} hidden=${hostHidden} enemies=${s.enemies.length} towers=${s.towers.length} kills=${s.kills} leaks=${s.leaks}\n` +
        `host: embedded=${bridge.embedded} insitu=${isInsitu()} skin=${bridge.context.skin ?? '-'} theme=${bridge.context.theme} lang=${lang} palette=${currentTheme}\n` +
        `keys: p 暂停 · 1/2/4 倍速 · g +100 CP · n 下一波 · F1/\` 开关\n` +
        `cmds=${JSON.stringify(recorded.slice(-3))}`;
    }
    return;
  }
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
    ctx.fillStyle = theme.tower ?? def.color ?? '#fff'; ctx.globalAlpha = tw.life === 'pending' ? 0.5 : 1;
    ctx.beginPath();
    ctx.roundRect(tw.cx * PX + 10, tw.cy * PX + 10, PX - 20, PX - 20, 6);
    ctx.fill();
    if (theme.tower) {
      ctx.strokeStyle = theme.hair ?? theme.text; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(tw.cx * PX + 10, tw.cy * PX + 10, PX - 20, PX - 20, 6); ctx.stroke();
    }
    ctx.globalAlpha = 1;
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

    ctx.fillStyle = theme.ink ? 'rgba(0,0,0,.45)' : '#000'; ctx.fillRect(x - 12, y - 22, 24, 4);
    ctx.fillStyle = theme.ok ?? '#7CFC7C'; ctx.fillRect(x - 12, y - 22, 24 * Math.max(0, e.hp) / def.hp, 4);
  }

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

  if (!inLobby && (s.phase === 'build' || s.phase === 'wave')) drawAdvisorOverlay(ctx, cardView, pack, PX, theme.accent ?? '#ffd36a');

  if (s.phase === 'won' || s.phase === 'lost') {
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = theme.paper ?? theme.text; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(s.phase === 'won' ? t('held') : t('fell'), canvas.width / 2, canvas.height / 2 - 12);
    if (settlementText) {
      ctx.font = 'bold 18px sans-serif';
      ctx.fillStyle = s.phase === 'won' ? (theme.ok ?? '#338a72') : (theme.danger ?? '#ff9a8a');
      ctx.fillText(settlementText, canvas.width / 2, canvas.height / 2 + 24);
    }
  }
  if (dbg.style.display !== 'none') {
    dbg.textContent = `DEBUG  seed=${s.seed} tick=${s.tick} checksum=${checksum(s)}\n` +
      `speed=${speed}x paused=${paused} hidden=${hostHidden} enemies=${s.enemies.length} towers=${s.towers.length} kills=${s.kills} leaks=${s.leaks}\n` +
      `host: embedded=${bridge.embedded} skin=${bridge.context.skin ?? '-'} theme=${bridge.context.theme} lang=${lang} palette=${currentTheme}\n` +
      `keys: p 暂停 · 1/2/4 倍速 · g +100 CP · n 下一波 · F1/\` 开关\n` +
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

// ---- D2 lobby: 皮肤化紧凑「军师议事」对话框 + 聊天式自然语言 AI 输出（去除原始 JSON 与「流式」技术词） ----
const lobby = document.createElement('div');
lobby.id = 'lobby';
root.append(lobby);
const esc = escHtml;
const safeAvatar = (u?: string) => !!u && (/^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/i.test(u) || /^https?:\/\//i.test(u) || u.startsWith('/'));
let designing = false;   // 关卡设计军师（LLM）出活中：按钮置灰，防连点
let lastSum: Summary | undefined;

function activeAdvisorAgent(): AdvisorAgent | null {
  return session.agent ?? hostChannel?.agent ?? null;
}

function lobbyIdentityHtml(sum?: Summary): string {
  const ag = activeAdvisorAgent();
  const rawWho = sum?.provider ?? (llmLevelProvider ? llmLevelProvider.name : provider.name);
  const who = cleanTechTerms(rawWho, lang);
  const avHtml = ag?.name
    ? (safeAvatar(ag.avatar)
        ? `<img class="lobby-adv-av" src="${esc(ag.avatar!)}" alt="${esc(ag.name)}">`
        : `<span class="lobby-adv-av lobby-adv-glyph"${ag.color ? ` style="--adv-c:${esc(ag.color)}"` : ''}>${esc([...ag.name][0] ?? '军')}</span>`)
    : `<span class="lobby-adv-av lobby-adv-glyph">军</span>`;
  const personaAttr = ag?.persona ? ` title="${esc(ag.persona)}"` : '';
  const personaHtml = ag?.persona ? `<p class="lobby-persona" id="lobby-persona" hidden>${esc(ag.persona)}</p>` : '';
  return `<div id="lobby-head"${personaAttr}><h3>${avHtml}<span class="lobby-title-text">军师议事</span> <small id="lobby-who">${esc(who)}</small></h3>${personaHtml}</div>`;
}

function refreshLobbyIdentity() {
  const head = lobby.querySelector('#lobby-head');
  if (!head) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = lobbyIdentityHtml(lastSum);
  if (wrap.firstElementChild) head.replaceWith(wrap.firstElementChild);
}

function renderLobbyStream(p: LevelStreamProgress) {
  const out = lobby.querySelector('#summary');
  if (!out) return;
  let box = out.querySelector('.stream-box') as HTMLElement | null;
  if (!box) {
    out.innerHTML = `<div class="stream-box lobby-chat-bubble" id="lobby-stream"><div class="stream-head"><span class="adv-pulse-dot"></span><p class="stream-stage" id="stream-stage"></p></div><div class="stream-parsed chat-md-body" id="stream-parsed"></div></div>`;
    box = out.querySelector('.stream-box') as HTMLElement | null;
  }
  const stageEl = out.querySelector('#stream-stage');
  const parsedEl = out.querySelector('#stream-parsed');
  const ag = activeAdvisorAgent();
  const actor = ag?.name ? `军师「${ag.name}」` : cleanTechTerms(p.provider || '军师', lang);
  const stageText = cleanTechTerms(p.stage || '正在推演阵法与兵力部署…', lang);
  if (stageEl) {
    stageEl.textContent = `${actor} · ${stageText}`;
  }
  if (parsedEl) {
    // 复用聊天式自然语言提取器：将增量内容渲染成通顺的军师自然语言战策段落，绝不展示原始 JSON
    parsedEl.innerHTML = extractNaturalAdvisorSpeech(p.text, stageText, lang);
  }
}

function showLobby(sum?: Summary, text = '') {
  inLobby = true; lobby.style.display = 'block'; advisorBox.style.display = 'none';
  lastSum = sum;
  lobby.innerHTML = `<div class="card">${lobbyIdentityHtml(sum)}
  <textarea id="desc" rows="2" placeholder="输入战局构想，例如：长坂坡雨夜，轻骑突袭">${esc(text)}</textarea>
  <div class="lobby-presets"><button type="button" class="preset-chip" data-preset="长坂坡雨夜，轻骑突袭">长坂坡雨夜</button><button type="button" class="preset-chip" data-preset="水路栈道伏击，人海战术">水路伏击</button><button type="button" class="preset-chip" data-preset="重甲铁骑攻城，高CP奖励">重甲攻城</button></div>
  <div class="row"><button id="gen" class="primary-btn"${designing ? ' disabled' : ''}>${designing ? '军师推演中…' : '让军师设计'}</button><button id="td-direct-play" class="ghost-btn" type="button">直接原位布防</button></div>
  <div id="summary"></div></div>`;

  lobby.querySelectorAll('.preset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const preset = (chip as HTMLElement).dataset.preset || '';
      const area = lobby.querySelector('#desc') as HTMLTextAreaElement | null;
      if (area && preset) area.value = preset;
    });
  });

  lobby.querySelector('#td-direct-play')?.addEventListener('click', () => enterBattleInSitu());
  const out = lobby.querySelector('#summary')!;
  if (designing && !sum) {
    const ag = activeAdvisorAgent();
    const actor = ag?.name ? `军师「${ag.name}」` : cleanTechTerms(llmLevelProvider?.name ?? '军师', lang);
    out.innerHTML = `<div class="stream-box lobby-chat-bubble" id="lobby-stream"><div class="stream-head"><span class="adv-pulse-dot"></span><p class="stream-stage" id="stream-stage">${esc(actor)} · 正在勘察地形并推演阵法…</p></div><div class="stream-parsed chat-md-body" id="stream-parsed"><p class="chat-md-p">正在结合当前地图地势编排兵种与防线…</p></div></div>`;
  } else if (sum) {
    const ag = activeAdvisorAgent();
    const speaker = ag?.name ? `${ag.name}${ag.title ? `（${ag.title}）` : ''}` : cleanTechTerms(sum.provider, lang);
    const cleanNote = sum.note ? cleanTechTerms(sum.note, lang) : '';
    const greedyRun = sum.dryrun.find((d) => d.bot === 'greedy');
    const simLine = greedyRun
      ? `我已在沙盘推演过此阵：若在折角要冲合理布设防线，可稳守母星（预计基地余量 ${greedyRun.base_hp}，仅漏 ${greedyRun.leaks} 骑）。`
      : '';
    out.innerHTML = `<div class="lobby-chat-bubble result-bubble">
      <div class="chat-msg-head"><strong>${esc(speaker)}</strong><span>阵法成稿</span></div>
      <p class="echo">${esc(cleanTechTerms(sum.echo, lang))}</p>
      ${simLine ? `<p class="dry">${esc(simLine)}</p>` : ''}
      <div class="lobby-pack-grid">
        <div><span class="meta-k">守军器械</span><span class="meta-v">${esc(sum.towers.join(' · '))}</span></div>
        <div><span class="meta-k">敌军先锋</span><span class="meta-v">${esc(sum.enemies.join(' · '))}</span></div>
        <div><span class="meta-k">攻势编组</span><span class="meta-v">共 ${sum.waves.length} 波（${sum.waves.map((w, i) => `W${i + 1}:${w.total}骑`).join(' / ')}）</span></div>
      </div>
      ${cleanNote ? `<p class="warn">${esc(cleanNote)}</p>` : ''}
      ${sum.warnings.map((w) => `<p class="warn">⚠ ${esc(w.message)}</p>`).join('')}
      ${sum.errors.slice(0, 5).map((e) => `<p class="err">✗ ${esc(e.message)}（${esc(e.path)}）</p>`).join('')}
    </div>
    <div class="row action-row"><button id="go" class="primary-btn">开始布防</button><button id="again" class="ghost-btn">重新推演</button></div>`;
    out.querySelector('#go')!.addEventListener('click', () => startWith(sum.pack));
    out.querySelector('#again')!.addEventListener('click', () => (lobby.querySelector('#desc') as HTMLTextAreaElement).focus());
  }
  lobby.querySelector('#gen')!.addEventListener('click', () => {
    const tx = (lobby.querySelector('#desc') as HTMLTextAreaElement).value.trim() || '长坂坡雨夜';
    void design(tx);
  });
  reportState();
}

/** 关卡设计：有通道就走真 LLM（支持实时进展反馈；失败整条退本地模板并在卡上说明），没有就同步走 Mock。
 *  注意：先复位忙碌标志 designing 再调用 showLobby 重绘，结果渲染后按钮恢复可点、不再挂「军师推演中…」。 */
async function design(tx: string) {
  if (designing) return;
  if (!llmLevelProvider) { showLobby(runPipeline(provider, tx), tx); return; }
  designing = true; showLobby(undefined, tx);
  let sum: Summary | undefined;
  try {
    sum = await runPipelineAsync(llmLevelProvider, tx, 3, provider, (p) => {
      if (designing) renderLobbyStream(p);
    });
  } finally {
    designing = false;
  }
  showLobby(sum, tx);
}
let revenging = false;
async function revenge() {
  if (revenging) return;
  revenging = true; renderHud();
  try {
    await design(session.debrief(state));
  } finally {
    revenging = false;
    renderHud();
  }
}
function startWith(p: ContentPack) {
  pack = p;
  PATH_CELLS = new Set(expandPath(pack.map.path.map((c) => [c.x, c.y] as [number, number])).cells.map((c) => c.join(',')));
  syncProjector();
  selected = pack.towers[0].id;
  matchSeq++;
  lastSettlement = null;
  state = createBattle(pack, SEED); recorded.length = 0; shots.length = 0; queue = [];
  inLobby = false; lobby.style.display = 'none'; renderHud();
  session.reset(state);
  scheduleCard();
}
(window as any).__lobby = { gen: (tx: string) => { void design(tx); } };
syncProjector();
if (inLobby) showLobby(); else { lobby.style.display = 'none'; session.reset(state); }
renderHud();
requestAnimationFrame(frame);
(window as any).__td = {
  get state() { return state; },
  checksum: () => checksum(state),
  recorded,
  get host() { return { embedded: bridge.embedded, origin: bridge.origin, context: bridge.context, hidden: hostHidden, palette: currentTheme }; },
  get cp() {
    return {
      inGameCp: state.gold,
      walletCp: bridge.context.wallet?.balanceCp ?? localWalletCp,
      rewardWinCp: MATCH_WIN_CP,
      penaltyLossCp: MATCH_LOSS_CP,
      lastSettlement,
    };
  },
  settleNow: (outcome: 'won' | 'lost') => {
    state = { ...state, phase: outcome, base_hp: outcome === 'lost' ? 0 : Math.max(1, state.base_hp) };
    settleCurrentMatch(outcome);
    renderHud();
    draw();
    return lastSettlement;
  },
  get insitu() { return isInsitu(); },
  get spatial() {
    if (!isInsitu()) return null;
    if (!currentProjector) syncProjector();
    const p = currentProjector!;
    return {
      insitu: true,
      canvasBg: 'transparent',
      stage: { w: canvas.width, h: canvas.height },
      azimuth: p.azimuth,
      pitch: p.pitch,
      zoom: p.zoom,
      origin: p.origin,
      cellPx: p.cellPx,
      hostMap: p.hostMap,
      roadPlan: p.roadPlan,
      ambientTrafficCleared: p.hostMap?.ambientTrafficCleared ?? true,
      enemyModels: pack.enemies.map((e) => ({
        id: e.id,
        name: e.display_name,
        modelKind: getMinionModelKind(e, p.hostMap?.skin),
        vfx: ['auraRing', 'wakeTrail', 'battleCrest'],
      })),
      waypoints: p.waypoints,
      tacticalSlots: p.tacticalSlots.slice(0, 16),
      slotScreen: (slot: number) => { const c = slotCell(pack, slot); return c ? p.cellToScreen(c.x + 0.5, c.y + 0.5) : null; },
      cellScreen: (cx: number, cy: number) => p.cellToScreen(cx + 0.5, cy + 0.5),
    };
  },
};
// 军师读点（E2E / 宿主侧 test-arcade 用）：只读视图 + 与卡片按钮等价的三个动作；没有任何注入回包的后门（回包只能从通道来）
(window as any).__advisor = {
  mode: advisorSel.mode, reason: advisorSel.reason,
  view: () => session.view(),
  adopt: (id: string) => { const c = session.adopt(id); queue.push(...c); return c.length; },
  takeGambit: () => { const c = session.takeGambit(); if (c) queue.push(c); return !!c; },
  setAutopilot: (on: boolean) => session.setAutopilot(on),
  snapshot: () => session.snapshotNow(),
  debrief: () => session.debrief(state),
};

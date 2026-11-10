// D1 presenter: fixed 30 tick/s accumulator loop; rendering only reads state, all rules in runtime.
// Hikos 嵌入（hikos.ts / skins.ts）：URL 参数 skin/accent/bg/ink/theme/lang 决定配色与文案，postMessage v1 与宿主握手（td:ready / td:state / td:exit）。
// 军师（src/advisor/，任务 fb4d93bc / d9ad7e7a / 94bbcebe / 997eeae6）：?advisor=local|host|<url> 选通道；会话每 tick 前后各一个钩子；
// 采纳只产出 build 命令走同一条校验；卡片见 advisorCard.ts，聊天式自然语言格式化见 chatFormat.ts。
import { createBattle, step, checksum, TICKS_PER_SECOND, CELL, milliOf, pathLength, positionAt } from '../runtime/index';
import type { BattleState, Command, GameEvent } from '../runtime/index';
import { DEFAULT_PACK } from '../content/default';
import { PALETTES, type Palette } from './palettes';
import { MockProvider } from '../ai/mock';
import { runPipeline, runPipelineAsync, type LevelStreamProgress, type Summary } from '../ai/pipeline';
import { LlmContentProvider } from '../ai/llm';
import type { ContentPack } from '../runtime/index';
import { expandPath } from '../content/validate';
import { createHostBridge, type GameState, type HostCamera, type HostContext, type HostGround, type HostSettlementReply } from './hikos';
import { buildWorldField, milliToWorld, packForField, routePoint, type HostWorldMap, type WorldField } from './worldField';
import { arcOf, encodeField, encodeFrame, groundOf, padPoints, pickPad, projectWorld, routeIndex, routeMilli, routeWorld, type WorldFx, type WorldPoint } from './worldMode';
import { paletteForContext } from './skins';
import { AdvisorSession, HostChannel, selectChannel, type AdvisorAgent, type AdvisorView } from '../advisor/index';
import { slotCell } from '../advisor/snapshot';
import { renderAdvisorCard, drawAdvisorOverlay } from './advisorCard';
import {
  createSpatialProjector,
  drawSpatialBattlefield,
  getMinionModelKind,
  type FloatingPopup,
  type ShieldRipple,
  type SpatialProjector,
  type SpatialShot,
} from './spatialMap';
import { cleanTechTerms, escHtml, extractNaturalAdvisorSpeech } from './chatFormat';
import {
  buildCulturalMappingTable,
  CAMPAIGN_MAX_LEVEL,
  CAMPAIGN_SKIN_ROTATION,
  computeCounterPreview,
  generateCampaignPack,
  getCulturalLexicon,
  getSkin3dAssetManifest,
  localizePackForSkin,
  replaceAncientTerms,
  type CrisisAffixSpec,
  type EdictOptionSpec,
} from './culturalThemes';
import { dryRun } from '../content/dryrun';

const params = new URLSearchParams(location.search);
const SEED = Number(params.get('seed') ?? 20261107) >>> 0;
const DEBUG = params.has('debug');
const TICK_MS = 1000 / TICKS_PER_SECOND;
const PX = 56; // px per cell
let baseRawPack: ContentPack = DEFAULT_PACK;
let selectedEdictId: EdictOptionSpec['id'] | null = null;
let activeAffixIds: CrisisAffixSpec['id'][] = [];
let userReducedMotionOverride: boolean | null = params.get('reducedMotion') === '1' || params.get('reducedMotion') === 'true'
  ? true
  : (params.get('reducedMotion') === '0' || params.get('reducedMotion') === 'false' ? false : null);

function isReducedMotion(): boolean {
  if (userReducedMotionOverride !== null) return userReducedMotionOverride;
  if (bridge?.context?.reducedMotion) return true;
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
  } catch {}
  return false;
}

let pack: ContentPack = DEFAULT_PACK;
// 自由几何（世界模式）的路线不是格子：不能逐格展开（坐标带小数，逐格走永远到不了终点）
const pathCellSet = (p: ContentPack): Set<string> => p.map.free
  ? new Set<string>()
  : new Set(expandPath(p.map.path.map((c) => [c.x, c.y] as [number, number])).cells.map((c) => c.join(',')));
let PATH_CELLS = pathCellSet(pack);
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
  onMap: () => { applyPalette(); syncWorld(); syncProjector(); },
  // 宿主每帧推来的相机矩阵：收到就立刻按它重画跳字（不等下一个 rAF），与宿主这一帧的三维画面对齐
  onCamera: (cam) => { hostCamera = cam; if (worldField && !hostHidden && !firstFrame) drawWorldOverlay(); },
  onGround: (g) => { hostGround = g; if (worldField) worldPads = padPoints(worldField, hostGround); },
  onSize: () => { syncProjector(); fit(); },
  onAdvisorReply: (m) => { for (const cb of advisorReplyCbs) cb(m); },
  onAdvisorStream: (m) => { for (const cb of advisorStreamCbs) cb(m); },
  onSettleReply: (m) => { onHostSettleReply(m); for (const cb of settleReplyCbs) cb(m); },
  onAny: (m) => { if (DEBUG && m.type !== 'hikos:camera') hostLog.push(m); },   // 相机每帧一条，不进日志（读点在 __td.world.camera）
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
  zh: { base: '基地', gold: 'CP', wave: '波次', level: '关卡', nextLevel: '下一关', build: '布防中', fight: '交战中', won: '胜利', lost: '失败', start: '出兵', restart: '重新开始', exit: '退出', theme: '主题:', held: '守住了！', fell: '基地失守', paused: '已暂停', revenge: '复仇一局', revenging: '军师出题中…', wallet: '账户' },
  en: { base: 'Base', gold: 'CP', wave: 'Wave', level: 'Stage', nextLevel: 'Next Stage', build: 'Build', fight: 'Fighting', won: 'Won', lost: 'Lost', start: 'Start wave', restart: 'Restart', exit: 'Exit', theme: 'Theme:', held: 'Held!', fell: 'Base fell', paused: 'Paused', revenge: 'Revenge round', revenging: 'Advisor is designing…', wallet: 'Wallet' },
} as const;
const t = (k: keyof typeof STR.zh) => STR[lang][k];

// 单局 CP 结算量级（大厅 #25804 ④：胜利 +10 CP，失败 -10 CP）
export const MATCH_WIN_CP = 10;
export const MATCH_LOSS_CP = -10;
let campaignLevel = Math.max(1, Math.min(CAMPAIGN_MAX_LEVEL, Number(params.get('level') ?? 1) || 1));
let currentDpr = 1;
let matchSeq = 1;
let settledMatchSeq = 0;
const queryWalletCp = params.has('walletCp') && Number.isFinite(Number(params.get('walletCp')))
  ? Math.max(0, Math.round(Number(params.get('walletCp'))))
  : null;
let localWalletCp: number | null = queryWalletCp;
let previewOptionId: string | null = null;
let lastSettlement: {
  matchId: string;
  outcome: 'won' | 'lost';
  deltaCp: number;
  appliedCp: number;
  balanceCp: number | null;
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

// ---- 世界模式（大厅 #27514 根治）：宿主给了场景的真实几何（map.world）时，战场长在地图上——路线是真实道路的中心线、塔位是路边真实空地、
// 模拟按世界距离算；路线 / 塔 / 敌人 / 弹道由宿主画进它自己的三维场景（td:field / td:frame），地图怎么缩放旋转都贴着道路。
// 游戏画布只剩按宿主相机矩阵（hikos:camera）投影的跳字。线格式与投影见 worldMode.ts，战场生成见 worldField.ts。
let hostWorldKey = '';
let hostWorld: HostWorldMap | null = null;
let worldField: WorldField | null = null;
let worldPads: WorldPoint[] = [];
let hostCamera: HostCamera | null = null;
let hostGround: HostGround | null = null;   // 宿主量出的真实高度（对上当前战场 id 才用）
let worldHoverPad = -1;
let worldRingPad = -1;        // 点了一座已建的塔：显示它的射程圈
let fieldDirty = true;        // 战场的文案 / 配色 / 几何可能变了：下一帧先比对再决定要不要重发 td:field
let lastFieldJson = '';
let lastFieldMsg: Record<string, unknown> | null = null;
let lastFrameSig = '';
let lastFrameMsg: Record<string, unknown> | null = null;
let worldFramesSent = 0;
let worldFocusSentFor = '';
interface WorldPopup { x: number; y: number; z: number; rise: number; text: string; color: string; critical: boolean; life: number; maxLife: number }
const worldPopups: WorldPopup[] = [];
const worldShots: { tower: number; target: number; x: number; z: number; until: number }[] = [];
const worldFx: WorldFx[] = [];            // 一次性事件（击破 / 漏怪 / 爆破 / 推倒 / 落成）：随下一条 td:frame 发出后清空
let worldMilliPack: ContentPack | null = null;
let worldMilli: number[] = [];
const FIELD_DEBUG = params.has('fielddebug');   // 调试：把游戏自己算的路线 / 塔位 / 敌人用相机矩阵描在画布上，和宿主的三维画面叠着看

function activeSkin(): string | null {
  return bridge.context.skin ?? (hikosMode ? 'union-atlas-3d' : null);
}

/** 内容包按当前皮肤 / 语言 / 敕令 / 词缀本地化后的样子（地图仍是内容包自己的棋盘） */
function localizedBasePack(): ContentPack {
  const sk = activeSkin();
  return sk ? localizePackForSkin(baseRawPack, sk, lang, selectedEdictId, activeAffixIds) : baseRawPack;
}

function syncPackLexicon(resetBattle = false) {
  const prevStartGold = pack.map.starting_gold;
  const prevBaseHp = pack.map.base_hp;
  const localized = localizedBasePack();
  // 世界模式：塔 / 敌人 / 波次 / 文案照旧来自内容包，地图几何换成宿主地图上的真实战场
  pack = worldField ? packForField(localized, worldField) : localized;
  fieldDirty = true;
  const canApplyEdictStats = resetBattle && (state.tick === 0 || (state.wave_index === 0 && state.phase === 'build'));
  const goldDelta = pack.map.starting_gold - prevStartGold;
  const hpDelta = pack.map.base_hp - prevBaseHp;
  state = {
    ...state,
    pack,
    ...(canApplyEdictStats
      ? {
          gold: state.towers.length === 0 ? pack.map.starting_gold : Math.max(0, state.gold + goldDelta),
          base_hp: Math.max(1, state.base_hp + hpDelta),
        }
      : {}),
  };
}

let state: BattleState = createBattle(pack, SEED);
syncPackLexicon(true);
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
const shots: SpatialShot[] = [];
const floatingPopups: FloatingPopup[] = [];
const shieldRipples: ShieldRipple[] = [];
const towerRecoils = new Map<number, number>();
const enemyHitFlashes = new Map<number, number>();
let hitStopUntil = 0;
let screenShakeUntil = 0;
let vfxStats = {
  shotsFired: 0,
  muzzleFlashes: 0,
  recoils: 0,
  hitFlashes: 0,
  hitStops: 0,
  shieldRipples: 0,
  armorBreakPopups: 0,
  baseRipples: 0,
  screenShakes: 0,
};
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
function blastRoadNow(branch = 1): { ok: boolean; cratersCount: number; gold: number } {
  if (inLobby) enterBattleInSitu();
  const before = state.craters?.length ?? 0;
  queue.push({ type: 'blast_road', branch });
  tickOnce();
  const cratersCount = state.craters?.length ?? 0;
  if (cratersCount > before && worldField) {
    // 世界模式：弹坑随 td:frame 的 craters（路线号 + 世界弧长）给宿主，画在真实路面上；不再发带格坐标的 td:destruct kind:'road'
    const cr = state.craters![cratersCount - 1];
    const w = routeWorldAt(cr.branch, cr.progress);
    if (w) {
      worldFx.push(['blast', w.x, w.z]);
      worldPopups.push({ x: w.x, y: w.y + 1.2, z: w.z, rise: 0, text: lang === 'zh' ? '💥 炸毁道路 · 敌军改道!' : '💥 Road Blasted · Rerouted!', color: '#ffcf8b', critical: true, life: 0.9, maxLife: 0.9 });
    }
    renderHud();
    scheduleCard();
    draw();
  } else if (cratersCount > before) {
    const cr = state.craters![cratersCount - 1];
    const pt = screenPointForMilli(cr.cx * CELL + 500, cr.cy * CELL + 500);
    if (!isReducedMotion()) {
      screenShakeUntil = Math.max(screenShakeUntil, performance.now() + 260);
      vfxStats.screenShakes++;
      for (let i = 0; i < 16; i++) {
        particles.push({
          x: pt.x,
          y: pt.y,
          vx: (Math.random() - 0.5) * 140,
          vy: (Math.random() - 0.5) * 120 - 25,
          life: 0.65,
          maxLife: 0.65,
          color: i % 2 === 0 ? '#ff6d3b' : '#4a4542',
        });
      }
    }
    floatingPopups.push({
      x: pt.x,
      y: pt.y - 18,
      text: lang === 'zh' ? '💥 炸毁道路 · 敌军改道!' : '💥 Road Blasted · Rerouted!',
      color: '#ffcf8b',
      critical: true,
      life: 0.9,
      maxLife: 0.9,
    });
    bridge.send({ type: 'td:destruct', v: 1, kind: 'road', id: cr.id, branch: cr.branch, cx: cr.cx, cy: cr.cy });
    renderHud();
    scheduleCard();
    draw();
  }
  return { ok: cratersCount > before, cratersCount, gold: state.gold };
}

function demolishBuildingNow(targetKey?: string): { ok: boolean; key: string; demolishedCount: number; gold: number } {
  if (inLobby) enterBattleInSitu();
  if (worldField) {
    // 世界模式：推倒的是地图上离路线最近的一座真实建筑，冲击范围按它的真实位置算
    const f = worldField;
    const tgt = worldDemolishTarget(targetKey);
    const had = state.demolished?.length ?? 0;
    if (!tgt) return { ok: false, key: targetKey ?? '', demolishedCount: had, gold: state.gold };
    const cx = Math.round(((tgt.x - f.ox) / f.unit - 0.5) * 1000) / 1000, cy = Math.round(((tgt.z - f.oz) / f.unit - 0.5) * 1000) / 1000;
    queue.push({ type: 'demolish_building', key: tgt.key, label: tgt.label, x: cx, y: cy });
    tickOnce();
    const count = state.demolished?.length ?? 0;
    if (count > had) {
      const at = milliWorld(milliOf(cx), milliOf(cy));
      worldFx.push(['demolish', tgt.x, tgt.z]);
      worldPopups.push({ x: tgt.x, y: at.y + 2.4, z: tgt.z, rise: 0, text: lang === 'zh' ? `🏚️ 推倒${tgt.label} +30 CP` : `🏚️ Demolished ${tgt.label} +30 CP`, color: '#ffd599', critical: true, life: 0.95, maxLife: 0.95 });
      bridge.send({ type: 'td:destruct', v: 1, kind: 'building', key: tgt.key, label: tgt.label, cx, cy, wx: tgt.x, wz: tgt.z });
      renderHud();
      scheduleCard();
      draw();
    }
    return { ok: count > had, key: tgt.key, demolishedCount: count, gold: state.gold };
  }
  const nodes = bridge.context.map?.nodes ?? [];
  const candidates = nodes.length > 0
    ? nodes
    : [
        { key: 'bldg-west-factory', kind: 'entity' as const, label: '西翼厂房', x: 460, y: 320 },
        { key: 'bldg-north-depot', kind: 'entity' as const, label: '北翼仓储楼', x: 640, y: 280 },
        { key: 'bldg-south-tower', kind: 'entity' as const, label: '南翼观测站', x: 580, y: 520 },
      ];
  const already = new Set((state.demolished ?? []).map((d) => d.key));
  const picked = (targetKey ? candidates.find((c) => c.key === targetKey) : null)
    ?? candidates.find((c) => !already.has(c.key))
    ?? { key: targetKey || `bldg-${(state.demolished?.length ?? 0) + 1}`, kind: 'entity' as const, label: '沿途街坊建筑', x: 520, y: 360 };
  const midIdx = Math.min(pack.map.buildable_cells.length - 1, Math.max(0, Math.floor(pack.map.buildable_cells.length * 0.5) + (state.demolished?.length ?? 0)));
  const cell = pack.map.buildable_cells[midIdx] ?? { x: Math.floor(pack.map.width / 2), y: Math.floor(pack.map.height / 2) };
  const before = state.demolished?.length ?? 0;
  queue.push({ type: 'demolish_building', key: picked.key, label: picked.label, x: cell.x, y: cell.y });
  tickOnce();
  const demolishedCount = state.demolished?.length ?? 0;
  if (demolishedCount > before) {
    const pt = screenPointForMilli(cell.x * CELL + 500, cell.y * CELL + 500);
    if (!isReducedMotion()) {
      screenShakeUntil = Math.max(screenShakeUntil, performance.now() + 280);
      vfxStats.screenShakes++;
      for (let i = 0; i < 18; i++) {
        particles.push({
          x: pt.x,
          y: pt.y,
          vx: (Math.random() - 0.5) * 130,
          vy: (Math.random() - 0.5) * 110 - 20,
          life: 0.72,
          maxLife: 0.72,
          color: i % 2 === 0 ? '#d9822b' : '#8c8275',
        });
      }
    }
    floatingPopups.push({
      x: pt.x,
      y: pt.y - 20,
      text: lang === 'zh' ? `🏚️ 推倒${picked.label} +30 CP` : `🏚️ Demolished ${picked.label} +30 CP`,
      color: '#ffd599',
      critical: true,
      life: 0.95,
      maxLife: 0.95,
    });
    bridge.send({ type: 'td:destruct', v: 1, kind: 'building', key: picked.key, label: picked.label, cx: cell.x, cy: cell.y });
    renderHud();
    scheduleCard();
    draw();
  }
  return { ok: demolishedCount > before, key: picked.key, demolishedCount, gold: state.gold };
}

function renderCard() {
  cardView = session.view();
  advisorBox.style.display = inLobby && !isInsitu() ? 'none' : 'block';
  renderAdvisorCard(advisorBox, cardView, pack, lang, state.phase, {
    adopt: (id) => {
      if (inLobby) enterBattleInSitu();
      previewOptionId = null;
      queue.push(...session.adopt(id));
    },
    takeGambit: () => {
      if (inLobby) enterBattleInSitu();
      const c = session.takeGambit();
      if (c) queue.push(c);
    },
    setAutopilot: (on) => session.setAutopilot(on),
    previewOption: (id) => {
      previewOptionId = id;
      draw();
    },
    blastRoad: () => { blastRoadNow(1); },
    demolishBuilding: () => { demolishBuildingNow(); },
  }, activeSkin());
  fit();
}

function syncProjector() {
  const rawDpr = typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
  currentDpr = Math.max(1, Math.min(3, rawDpr));
  if (isInsitu()) {
    const vw = Math.max(320, document.documentElement.clientWidth || window.innerWidth || 960);
    const vh = Math.max(240, document.documentElement.clientHeight || window.innerHeight || 640);
    const pw = Math.round(vw * currentDpr);
    const ph = Math.round(vh * currentDpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
    // 世界模式不建屏幕投影器：战场在宿主的三维场景里，这里只按宿主相机矩阵投影（旧投影器要逐格展开路线，自由几何下走不到头）
    currentProjector = worldField ? null : createSpatialProjector(pack, vw, vh, bridge.context.map ?? null);
  } else {
    const gw = pack.map.width * PX, gh = pack.map.height * PX;
    const pw = Math.round(gw * currentDpr);
    const ph = Math.round(gh * currentDpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
    currentProjector = null;
  }
}

function applyPalette() {
  fieldDirty = true;
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
    const syncedCp = Math.round(c.wallet.balanceCp);
    localWalletCp = syncedCp;
    if (lastSettlement && lastSettlement.status === 'pending') {
      lastSettlement.balanceCp = Math.max(0, syncedCp + lastSettlement.deltaCp);
    }
  }
  // 宿主 context 一到就定军师可用性：没配（enabled:false）或老宿主（没有 advisor 字段）→ 不白等截止，秒切本地；排队中的请求随之放行 / 作废
  hostChannel?.setAvailable(c.advisor?.enabled === true);
  if (!legacyPalette) { theme = paletteForContext(c); currentTheme = 'hikos'; }
  syncWorld();
  syncPackLexicon(false);
  applyPalette();
  syncProjector();
  if (inLobby) {
    showLobby(lastSum);
    if (isInsitu() && c.advisor?.enabled === false && !session.view().current && session.view().status === 'idle') {
      session.reset(state);
      session.afterTick(state, []);
    }
  }
  renderHud();
  scheduleCard();
}

function onHostSettleReply(sr: HostSettlementReply) {
  if (typeof sr.balanceCp === 'number' && Number.isFinite(sr.balanceCp)) {
    localWalletCp = Math.round(sr.balanceCp);
  }
  const resolvedBalance = typeof sr.balanceCp === 'number' && Number.isFinite(sr.balanceCp)
    ? Math.round(sr.balanceCp)
    : localWalletCp;
  lastSettlement = {
    matchId: sr.matchId || lastSettlement?.matchId || `td-${state.seed}-${matchSeq}`,
    outcome: sr.outcome,
    deltaCp: sr.deltaCp,
    appliedCp: sr.appliedCp,
    balanceCp: resolvedBalance,
    status: 'settled',
  };
  renderHud();
  draw();
}

function settleCurrentMatch(outcome: 'won' | 'lost') {
  if (settledMatchSeq === matchSeq) return;
  settledMatchSeq = matchSeq;
  const deltaCp = outcome === 'won' ? MATCH_WIN_CP : MATCH_LOSS_CP;
  const matchId = `td-${state.seed}-${matchSeq}-${state.tick}-${checksum(state)}`;
  const hostCp = bridge.context.wallet?.balanceCp;
  const baseCp = typeof hostCp === 'number' && Number.isFinite(hostCp)
    ? Math.round(hostCp)
    : localWalletCp;
  const nextBalance = baseCp !== null && baseCp !== undefined ? Math.max(0, baseCp + deltaCp) : null;
  if (nextBalance !== null) localWalletCp = nextBalance;
  lastSettlement = {
    matchId,
    outcome,
    deltaCp,
    appliedCp: deltaCp,
    balanceCp: nextBalance,
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

  const lvBadge = document.createElement('span');
  lvBadge.id = 'td-campaign-level';
  lvBadge.className = 'stats level-badge';
  lvBadge.dataset.level = String(campaignLevel);
  lvBadge.dataset.maxLevel = String(CAMPAIGN_MAX_LEVEL);
  lvBadge.innerHTML = `<span class="hud-ico" aria-hidden="true">🚩</span><span>${t('level')} ${campaignLevel}/${CAMPAIGN_MAX_LEVEL}</span>`;
  hud.append(lvBadge);

  const info = document.createElement('span');
  info.className = 'stats';
  info.id = 'td-core-stats';
  const statusStr = paused || hostHidden ? t('paused') : phaseText;
  info.innerHTML = `<span class="hud-metric"><span class="hud-ico" aria-hidden="true">🛡️</span><span>${t('base')} <b class="hud-val">${s.base_hp}/${pack.map.base_hp}</b></span></span>` +
    `<span class="hud-metric"><span class="hud-ico" aria-hidden="true">⚡</span><span>${t('gold')} <b class="hud-val">${s.gold}</b></span></span>` +
    `<span class="hud-metric"><span class="hud-ico" aria-hidden="true">🌊</span><span>${t('wave')} <b class="hud-val">${s.wave_index}/${pack.waves.length}</b></span></span>` +
    `<span class="hud-metric"><span class="hud-ico" aria-hidden="true">🎯</span><span>${escHtml(statusStr)}</span></span>`;
  hud.append(info);

  const cpChip = document.createElement('span');
  cpChip.id = 'td-cp-settlement';
  const walletCp = bridge.context.wallet?.balanceCp ?? localWalletCp;
  const walletDisplay = walletCp !== null && walletCp !== undefined ? String(walletCp) : (lang === 'zh' ? '同步中' : 'Syncing');
  if (s.phase === 'won' || s.phase === 'lost') {
    const delta = lastSettlement?.deltaCp ?? (s.phase === 'won' ? MATCH_WIN_CP : MATCH_LOSS_CP);
    const sign = delta > 0 ? `+${delta}` : `${delta}`;
    const settledBal = lastSettlement?.balanceCp ?? walletCp;
    cpChip.className = `stats cp-badge ${s.phase === 'won' ? 'cp-won' : 'cp-lost'}`;
    cpChip.dataset.deltaCp = String(delta);
    cpChip.dataset.balanceCp = settledBal !== null && settledBal !== undefined ? String(settledBal) : '';
    const settleLabel = settledBal !== null && settledBal !== undefined
      ? (lang === 'zh'
          ? `结算 ${sign} CP · ${t('wallet')} ${settledBal} CP`
          : `Settle ${sign} CP · ${t('wallet')} ${settledBal} CP`)
      : (lang === 'zh'
          ? `结算 ${sign} CP · ${t('wallet')}同步中`
          : `Settle ${sign} CP · ${t('wallet')} Syncing`);
    cpChip.innerHTML = `<span class="hud-ico" aria-hidden="true">💎</span><span>${escHtml(settleLabel)}</span>`;
  } else {
    cpChip.className = 'stats cp-badge';
    cpChip.dataset.balanceCp = walletCp !== null && walletCp !== undefined ? String(walletCp) : '';
    const balLabel = lang === 'zh'
      ? `${t('wallet')} ${walletDisplay} CP（胜+${MATCH_WIN_CP}/败${MATCH_LOSS_CP}）`
      : `${t('wallet')} ${walletDisplay} CP (+${MATCH_WIN_CP}/${MATCH_LOSS_CP})`;
    cpChip.innerHTML = `<span class="hud-ico" aria-hidden="true">💎</span><span>${escHtml(balLabel)}</span>`;
  }
  hud.append(cpChip);

  // 战前参谋敕令快捷切换钮（大厅 #26913 ⑤：即使关闭了右侧议事窗或处于首波布防期，也可直接在顶栏点击切换参谋敕令）
  if (s.phase === 'build' && s.wave_index === 0) {
    const lex = getCulturalLexicon(activeSkin());
    const curEdict = lex.edicts.find((e) => e.id === selectedEdictId) ?? null;
    const edictBtn = document.createElement('button');
    edictBtn.id = 'td-edict-cycle';
    edictBtn.className = curEdict ? 'sel' : '';
    edictBtn.dataset.edict = selectedEdictId ?? '';
    edictBtn.innerHTML = `<span class="btn-ico" aria-hidden="true">📜</span><span>${escHtml(
      curEdict
        ? `${lang === 'zh' ? '敕令:' : 'Edict:'}${curEdict.name[lang]}`
        : (lang === 'zh' ? '敕令:未选(点选)' : 'Edict:None'),
    )}</span>`;
    edictBtn.title = lang === 'zh' ? '点击切换战前参谋敕令（三选一）' : 'Click to cycle pre-battle council edicts';
    edictBtn.onclick = () => {
      const ids: (EdictOptionSpec['id'] | null)[] = [null, ...lex.edicts.map((e) => e.id)];
      const idx = ids.indexOf(selectedEdictId);
      selectedEdictId = ids[(idx + 1) % ids.length];
      syncPackLexicon(true);
      if (inLobby) showLobby(lastSum);
      renderHud();
      draw();
    };
    hud.append(edictBtn);
  }

  // 下一波预览：军师快照里的 wave.next 就是这一行——军师知道的，玩家同样看得见（#24353「不泄露玩家尚不可见的信息」）
  const nextWave = s.phase === 'build' ? pack.waves[s.wave_index] : null;
  if (nextWave) {
    const counts = new Map<string, number>();
    for (const g of nextWave.groups) counts.set(g.enemy_id, (counts.get(g.enemy_id) ?? 0) + g.count);
    const preview = document.createElement('span');
    preview.className = 'stats next-wave'; preview.id = 'td-next-wave';
    const nextStr = `${lang === 'zh' ? '下一波' : 'Next'}：${[...counts].map(([id, n]) => `${pack.enemies.find((e) => e.id === id)?.display_name ?? id}×${n}`).join(lang === 'zh' ? '、' : ', ')}`;
    preview.innerHTML = `<span class="hud-ico" aria-hidden="true">🔭</span><span>${escHtml(nextStr)}</span>`;
    hud.append(preview);
  }
  const towerIcon = (id: string) => /catapult|stone/.test(id) ? '💥' : /fire|poison/.test(id) ? '🌀' : '🔦';
  for (const tw of pack.towers) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="btn-ico" aria-hidden="true">${towerIcon(tw.id)}</span><span>${escHtml(tw.display_name)}</span> <span class="btn-cost">${tw.cost} CP</span>`;
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
    if (s.phase === 'won' || s.phase === 'lost') { startWith(baseRawPack); showLobby(); }
    else {
      if (inLobby) enterBattleInSitu();
      queue.push({ type: 'start_wave' });
    }
  };
  hud.append(w);
  if (s.phase === 'won' || s.phase === 'lost') {
    if (s.phase === 'won' && campaignLevel < CAMPAIGN_MAX_LEVEL) {
      const nxt = document.createElement('button');
      nxt.id = 'td-next-level';
      nxt.className = 'sel';
      nxt.innerHTML = `<span class="btn-ico" aria-hidden="true">⏭️</span><span>${t('nextLevel')} (${campaignLevel + 1}/${CAMPAIGN_MAX_LEVEL})</span>`;
      nxt.onclick = () => startCampaignLevel(campaignLevel + 1);
      hud.append(nxt);
    }
    // 复仇一局（玩法增强 ③）：把这局的战报交给关卡设计军师，出一张针对你弱点的关
    const rv = document.createElement('button');
    rv.id = 'td-revenge'; rv.textContent = revenging ? t('revenging') : t('revenge'); rv.disabled = revenging;
    rv.onclick = () => { void revenge(); };
    hud.append(rv);
  }

  // 减弱动态开关（大厅 #26153 ②：支持 prefers-reduced-motion / 宿主 reducedMotion / 玩家手动切换，关闭屏震与强闪动效）
  const rmBtn = document.createElement('button');
  rmBtn.id = 'td-reduced-motion';
  const rmOn = isReducedMotion();
  rmBtn.className = `motion-toggle${rmOn ? ' is-reduced' : ''}`;
  rmBtn.dataset.reducedMotion = rmOn ? 'true' : 'false';
  rmBtn.textContent = lang === 'zh'
    ? (rmOn ? '动效:减弱' : '动效:标准')
    : (rmOn ? 'Motion:Reduced' : 'Motion:Full');
  rmBtn.title = lang === 'zh' ? '切换攻防震屏与粒子动效强度' : 'Toggle screen shake & particle intensity';
  rmBtn.onclick = () => {
    userReducedMotionOverride = !isReducedMotion();
    if (userReducedMotionOverride) {
      screenShakeUntil = 0;
      hitStopUntil = 0;
    }
    renderHud();
  };
  hud.append(rmBtn);

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
    x.onclick = () => {
      cleanupBattleResources();
      bridge.exit();
    };
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
    syncProjector();
    const logicalW = pack.map.width * PX;
    const logicalH = pack.map.height * PX;
    const availW = Math.max(200, document.documentElement.clientWidth - 20);
    const availH = Math.max(200, document.documentElement.clientHeight - hud.offsetHeight - advisorBox.offsetHeight - 38);
    const scale = Math.min(availW / logicalW, availH / logicalH, 2);
    canvas.style.width = `${Math.floor(logicalW * scale)}px`;
    canvas.style.height = `${Math.floor(logicalH * scale)}px`;
  });
}
window.addEventListener('resize', fit);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(document.documentElement);

function resolveClientCell(clientX: number, clientY: number): { x: number; y: number; slot: number } {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return { x: -1, y: -1, slot: -1 };
  if (worldField) {
    const pad = worldPadAt(clientX, clientY);
    const c = pad >= 0 ? pack.map.buildable_cells[pad] : null;
    return c ? { x: c.x, y: c.y, slot: pad } : { x: -1, y: -1, slot: -1 };
  }
  if (isInsitu()) {
    if (!currentProjector) syncProjector();
    const sx = ((clientX - r.left) / r.width) * currentProjector!.viewportW;
    const sy = ((clientY - r.top) / r.height) * currentProjector!.viewportH;
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
  if (worldField) return;   // 世界模式的输入在下面单独一套（worldPointer*）
  if (!isInsitu() || ev.button !== 0) return;
  pointerDrag = { startX: ev.clientX, startY: ev.clientY, lastX: ev.clientX, lastY: ev.clientY, moved: false };
});
canvas.addEventListener('pointermove', (ev) => {
  if (worldField) return;
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
  if (worldField && !wPointers.size) setWorldHover(-1);
});
canvas.addEventListener('wheel', (ev) => {
  if (!isInsitu()) return;
  ev.preventDefault();
  // 行 / 页为单位的滚轮先折成像素（和地图自己的滚轮处理同一换算）
  const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * 120 : ev.deltaY;
  bridge.send({ type: 'td:camera', kind: 'zoom', dy });
}, { passive: false });

canvas.addEventListener('click', (ev) => {
  if (worldField) return;   // 世界模式：点按在 pointerup 里处理（worldTap），浏览器随后合成的 click 不再建塔
  if (pointerDrag?.moved) { pointerDrag = null; return; }
  pointerDrag = null;
  const { x, y } = resolveClientCell(ev.clientX, ev.clientY);
  if (inLobby) enterBattleInSitu();
  queue.push({ type: 'build', tower_id: selected, x, y });
  session.notePlayerBuild();
});

// 触控：支持 iPad 双指捏合缩放相机 + 单指点触建塔；touchend 里 preventDefault 抑制浏览器随后合成的 click，避免一次点触建两座塔
let touchPinchDist: number | null = null;
canvas.addEventListener('touchstart', (e) => {
  if (worldField) return;
  if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    touchPinchDist = Math.hypot(dx, dy);
  } else {
    touchPinchDist = null;
  }
}, { passive: true });
canvas.addEventListener('touchmove', (e) => {
  if (worldField) { if (e.touches.length > 1) e.preventDefault(); return; }   // 双指：不让页面跟着缩放，手势走 pointer 事件
  if (e.touches.length === 2 && touchPinchDist !== null && isInsitu()) {
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const d = Math.hypot(dx, dy);
    if (Math.abs(d - touchPinchDist) > 10) {
      bridge.send({ type: 'td:camera', kind: 'zoom', dy: d > touchPinchDist ? -60 : 60 });
      touchPinchDist = d;
    }
  }
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
  if (worldField) return;
  if (touchPinchDist !== null) {
    if (e.touches.length < 2) touchPinchDist = null;
    return;
  }
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

// ================================================================================================
// 世界模式（大厅 #27514 根治）：战场长在宿主地图的真实道路上
// ================================================================================================

/** 按宿主世界地图 + 当前内容包（路线的目标长度）+ 关卡号（轮换起点）生成战场。没有世界地图 / 路网不可用 → null（退回旧的屏幕模式）。返回战场几何是否换了。 */
function refreshField(): boolean {
  const prevId = worldField?.id ?? '';
  let next: WorldField | null = null;
  if (hostWorld && isInsitu()) {
    try {
      const base = localizedBasePack();
      next = buildWorldField(hostWorld, { pathCells: Math.max(8, Math.round(pathLength(base.map.path) / CELL)), level: campaignLevel });
    } catch (err) {
      console.error('[td] world field', err);
    }
  }
  worldField = next;
  worldPads = next ? padPoints(next, hostGround) : [];
  fieldDirty = true;
  if ((next?.id ?? '') === prevId) return false;
  worldHoverPad = -1;
  worldRingPad = -1;
  worldPopups.length = 0;
  worldShots.length = 0;
  worldFx.length = 0;
  return true;
}

/** 宿主的世界地图到了 / 变了：战场跟着（重新）生成。同一份地图再来一次不动。 */
function syncWorld() {
  const w = bridge.context.map?.world ?? null;
  const key = w ? JSON.stringify(w) : '';
  if (key === hostWorldKey) return;
  hostWorldKey = key;
  hostWorld = w;
  if (refreshField()) redeployOnField(state.tick > 0 && !inLobby);
}

/** 战场几何换了：原来的塔位和行军进度在新战场上没有意义，本关在新战场上重新部署（关卡、敕令、钱包不动）。 */
function redeployOnField(notify: boolean) {
  cleanupBattleResources();
  syncPackLexicon(false);
  PATH_CELLS = pathCellSet(pack);
  syncProjector();
  if (!pack.towers.some((tw) => tw.id === selected)) selected = pack.towers[0].id;
  if (settledMatchSeq === matchSeq) { matchSeq++; lastSettlement = null; }
  state = createBattle(pack, state.seed);
  session.reset(state);
  if (notify) {
    toast = lang === 'zh' ? '地图变了：本关已在新战场上重新部署' : 'The map changed: this stage was redeployed';
    toastUntil = performance.now() + 2600;
  }
  renderHud();
  scheduleCard();
}

/** 各路线的模拟长度（毫格）；按内容包缓存 */
function fieldMilli(): number[] {
  if (worldMilliPack !== pack) { worldMilliPack = pack; worldMilli = routeMilli(pack); }
  return worldMilli;
}

/** 敌人（或弹坑）此刻在世界里的位置：沿它所在的路线按进度取——和宿主画它的位置是同一个算法 */
function routeWorldAt(branch: number | undefined, progress: number): WorldPoint | null {
  const f = worldField;
  if (!f) return null;
  const ri = routeIndex(f, branch);
  const route = f.routes[ri];
  return route ? routeWorld(route, arcOf(f, fieldMilli(), ri, progress), groundOf(f, hostGround, ri)) : null;
}

/** 模拟坐标（毫格）→ 世界坐标；高度取路线上最近的折点（塔位 / 命中点都在路面附近） */
function milliWorld(mx: number, my: number): WorldPoint {
  const f = worldField!;
  const p = milliToWorld(f, mx, my);
  let y = 0, bd = Infinity;
  f.routes.forEach((r, ri) => {
    const ys = groundOf(f, hostGround, ri);
    r.pts.forEach((q, i) => {
      const h = ys ? ys[i] : q[1];
      if (h === null) return;
      const d = (q[0] - p.x) * (q[0] - p.x) + (q[2] - p.z) * (q[2] - p.z);
      if (d < bd) { bd = d; y = h; }
    });
  });
  return { x: p.x, y, z: p.z };
}

const padOccupied = (pad: number): boolean => {
  const c = pack.map.buildable_cells[pad];
  return !!c && state.occupied.includes(`${c.x},${c.y}`);
};
const towerOnPad = (pad: number) => {
  const c = pack.map.buildable_cells[pad];
  return c ? state.towers.find((tw) => tw.cx === c.x && tw.cy === c.y) ?? null : null;
};
function towerRangeWorld(towerId: string): number {
  const def = pack.towers.find((d) => d.id === towerId);
  return def && worldField ? (def.range / CELL) * worldField.unit : 0;
}

/** 页面坐标 → 相机矩阵所在的舞台坐标（宿主量到的 iframe CSS 像素；画布铺满 iframe，通常 1:1） */
function stagePoint(clientX: number, clientY: number): { x: number; y: number } | null {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height || !hostCamera) return null;
  return { x: ((clientX - r.left) / r.width) * (hostCamera.w || r.width), y: ((clientY - r.top) / r.height) * (hostCamera.h || r.height) };
}
/** 屏幕上这一点压着哪个塔位（-1 = 没有）：用宿主这一帧的相机矩阵投影，和三维画面逐像素一致 */
function worldPadAt(clientX: number, clientY: number, coarse = false): number {
  if (!worldField || !hostCamera) return -1;
  const p = stagePoint(clientX, clientY);
  return p ? pickPad(hostCamera, worldPads, p.x, p.y, coarse ? 32 : 24) : -1;
}
function setWorldHover(pad: number) {
  if (pad === worldHoverPad) return;
  worldHoverPad = pad;
  canvas.style.cursor = pad >= 0 ? 'pointer' : '';
}

/** 点了一下：空塔位 → 建当前选中的塔；已有塔 → 开 / 关它的射程圈；点空 → 收起射程圈 */
function worldTap(clientX: number, clientY: number, coarse: boolean) {
  const pad = worldPadAt(clientX, clientY, coarse);
  if (pad < 0) { worldRingPad = -1; return; }
  const cell = pack.map.buildable_cells[pad];
  if (!cell) return;
  if (padOccupied(pad)) { worldRingPad = worldRingPad === pad ? -1 : pad; return; }
  if (inLobby) enterBattleInSitu();
  worldRingPad = -1;
  queue.push({ type: 'build', tower_id: selected, x: cell.x, y: cell.y });
  session.notePlayerBuild();
}

/** 游戏自己的界面挡住了舞台的哪几条边（像素）：宿主把镜头对准战场时避开它们 */
function stageInsets(): { top: number; right: number; bottom: number; left: number } {
  const vw = document.documentElement.clientWidth || 0, vh = document.documentElement.clientHeight || 0;
  const ins = { top: 0, right: 0, bottom: 0, left: 0 };
  const rect = (el: Element | null): DOMRect | null => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 ? r : null;
  };
  const h = rect(hud);
  if (h) ins.top = Math.round(h.bottom + 8);
  const side = (r: DOMRect | null) => {
    if (!r) return;
    if (r.width > vw * 0.6) { if (r.top + r.height / 2 > vh / 2) ins.bottom = Math.max(ins.bottom, Math.round(vh - r.top + 8)); }   // 窄屏：卡片横在下方
    else if (r.left + r.width / 2 < vw / 2) ins.left = Math.max(ins.left, Math.round(r.right + 8));
    else ins.right = Math.max(ins.right, Math.round(vw - r.left + 8));
  };
  if (advisorBox.style.display !== 'none') side(rect(advisorBox));
  if (lobby.style.display !== 'none') side(rect(lobby.querySelector('.card')));
  return {
    top: Math.min(ins.top, Math.round(vh * 0.4)), right: Math.min(ins.right, Math.round(vw * 0.4)),
    bottom: Math.min(ins.bottom, Math.round(vh * 0.4)), left: Math.min(ins.left, Math.round(vw * 0.4)),
  };
}

/** 请宿主把镜头对准战场：只在一块战场第一次出现（或换了）时发一次，之后镜头归玩家 */
function sendWorldFocus() {
  const f = worldField;
  if (!f) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const grow = (x: number, z: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); };
  for (const r of f.routes) for (const p of r.pts) grow(p[0], p[2]);
  for (const p of f.pads) grow(p.x, p.z);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  bridge.send({ type: 'td:camera', kind: 'frame', minX: r1(minX - f.unit), maxX: r1(maxX + f.unit), minZ: r1(minZ - f.unit), maxZ: r1(maxZ + f.unit), insets: stageInsets() });
}

/** td:field：战场的静态内容。内容没变不重发（文案 / 配色 / 几何任何一样变了才发）。 */
function sendField() {
  const f = worldField;
  if (!f) {
    // 离开世界模式：告诉宿主把它画的战场收掉
    if (lastFieldJson) { lastFieldJson = ''; lastFieldMsg = null; lastFrameSig = ''; lastFrameMsg = null; worldFocusSentFor = ''; bridge.send({ type: 'td:field', v: 1, id: null }); }
    return;
  }
  const msg = encodeField(f, pack, {
    skin: activeSkin(), lang, level: campaignLevel,
    spawnTitle: lang === 'zh' ? '起点' : 'Spawn', baseTitle: lang === 'zh' ? '终点' : 'Base',
    palette: { accent: theme.accent ?? '#ffd36a', danger: theme.danger ?? '#ff9a8a', ok: theme.ok ?? '#338a72', paper: theme.paper ?? '#2b3846', ink: theme.ink ?? theme.text },
  });
  const json = JSON.stringify(msg);
  if (json === lastFieldJson) return;
  lastFieldJson = json;
  lastFieldMsg = msg;
  lastFrameSig = '';
  bridge.send(msg);
  if (worldFocusSentFor !== f.id) { worldFocusSentFor = f.id; sendWorldFocus(); }
}

/** td:frame：这一刻战场上的动态内容。和上一条相比什么都没变就不发（建造期没人动时零流量）。 */
function sendFrame(now: number) {
  const f = worldField;
  if (!f) return;
  for (let i = worldShots.length - 1; i >= 0; i--) if (worldShots[i].until <= now) worldShots.splice(i, 1);
  const advised: number[] = [], preview: number[] = [];
  const tips = new Map<number, string>();
  let previewRing: [number, number] | null = null;
  const cur = cardView.current;
  if (cur && (state.phase === 'build' || state.phase === 'wave')) {
    for (const o of cur.advice.options) for (const m of o.moves) {
      if (tips.has(m.slot) || m.slot >= f.pads.length || padOccupied(m.slot)) continue;
      const isPreview = !!previewOptionId && o.id.toLowerCase() === previewOptionId.toLowerCase();
      (isPreview ? preview : advised).push(m.slot);
      tips.set(m.slot, `${o.id.toUpperCase()}·${pack.towers.find((tw) => tw.id === m.tower)?.display_name ?? m.tower}`);
      if (isPreview && !previewRing) previewRing = [m.slot, towerRangeWorld(m.tower)];
    }
  }
  const over = state.phase === 'won' || state.phase === 'lost';
  let ring: [number, number] | null = null;
  if (!over && worldHoverPad >= 0 && worldHoverPad < f.pads.length) {
    const tw = towerOnPad(worldHoverPad);
    if (tw) ring = [worldHoverPad, towerRangeWorld(tw.def)];
    else {
      const def = pack.towers.find((d) => d.id === selected);
      ring = [worldHoverPad, towerRangeWorld(selected)];
      if (def && !tips.has(worldHoverPad)) tips.set(worldHoverPad, `${def.display_name} ${def.cost} CP`);
    }
  } else if (!over && worldRingPad >= 0) {
    const tw = towerOnPad(worldRingPad);
    if (tw) ring = [worldRingPad, towerRangeWorld(tw.def)];
    else worldRingPad = -1;
  }
  const msg = encodeFrame(state, pack, f, {
    phase: inLobby ? 'lobby' : state.phase,
    paused: paused || hostHidden,
    hoverPad: over ? -1 : worldHoverPad,
    advisedPads: advised,
    previewPads: preview,
    ring: ring ?? previewRing,
    tips: [...tips].sort((a, b) => a[0] - b[0]),
    recoil: (iid) => (towerRecoils.get(iid) ?? 0) > now,
    flash: (iid) => (enemyHitFlashes.get(iid) ?? 0) > now,
    shots: worldShots.map((sh) => [sh.tower, sh.target, sh.x, sh.z] as [number, number, number, number]),
    fx: worldFx,
  });
  const sig = JSON.stringify({ ...msg, tick: 0 });
  if (!worldFx.length && sig === lastFrameSig) return;
  worldFx.length = 0;
  lastFrameSig = sig;
  lastFrameMsg = msg;
  worldFramesSent++;
  bridge.send(msg);
}

/** 每个动画帧收尾时调一次：战场内容变了发 td:field，战况变了发 td:frame。td:ready 之前什么都不发（它必须是第一条出站消息）。 */
function pumpWorld(now: number) {
  if (firstFrame) return;
  if (fieldDirty) { fieldDirty = false; sendField(); }
  if (worldField && !hostHidden) sendFrame(now);
}

/** 世界模式下游戏画布上只剩两样东西：贴着世界位置的跳字（按宿主相机矩阵投影），和居中的胜负横幅。其余都在宿主的三维场景里。 */
function drawWorldOverlay() {
  const s = state;
  const vw = canvas.width / currentDpr, vh = canvas.height / currentDpr;
  ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);
  const cam = hostCamera, f = worldField;
  if (cam && f) {
    ctx.save();
    // 相机矩阵落在「宿主量到的 iframe 尺寸」上；画布铺满 iframe，两者通常相等。尺寸消息还在路上时按比例对齐
    if (cam.w > 0 && cam.h > 0 && (Math.abs(vw - cam.w) > 0.5 || Math.abs(vh - cam.h) > 0.5)) ctx.scale(vw / cam.w, vh / cam.h);
    if (FIELD_DEBUG) drawFieldDebug(cam, f);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const fp of worldPopups) {
      const p = projectWorld(cam, fp.x, fp.y, fp.z);
      const ratio = Math.max(0, Math.min(1, fp.life / fp.maxLife));
      ctx.globalAlpha = Math.min(1, ratio * 1.3);
      ctx.font = fp.critical
        ? '800 12.5px "IBM Plex Sans", "PingFang SC", sans-serif'
        : '700 11px "IBM Plex Sans", "PingFang SC", sans-serif';
      ctx.strokeStyle = 'rgba(10, 14, 22, 0.78)';
      ctx.lineWidth = 3;
      ctx.strokeText(fp.text, p.x, p.y - 12 - fp.rise);
      ctx.fillStyle = fp.color;
      ctx.fillText(fp.text, p.x, p.y - 12 - fp.rise);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  if (s.phase === 'won' || s.phase === 'lost') {
    const settlementText = settlementTextNow();
    const okColor = theme.ok ?? '#338a72', danger = theme.danger ?? '#ff9a8a';
    ctx.save();
    const bannerW = Math.min(380, vw - 40);
    const bannerH = settlementText ? 86 : 68;
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = theme.paper ?? '#243040';
    ctx.strokeStyle = s.phase === 'won' ? okColor : danger;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.roundRect((vw - bannerW) / 2, (vh - bannerH) / 2, bannerW, bannerH, 12);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.fillStyle = theme.ink ?? theme.text;
    ctx.font = 'bold 26px "IBM Plex Sans", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.phase === 'won' ? t('held') : t('fell'), vw / 2, settlementText ? vh / 2 - 12 : vh / 2);
    if (settlementText) {
      ctx.fillStyle = s.phase === 'won' ? okColor : danger;
      ctx.font = '700 14px "IBM Plex Sans", "PingFang SC", sans-serif';
      ctx.fillText(settlementText, vw / 2, vh / 2 + 18);
    }
    ctx.restore();
  }
  if (dbg.style.display !== 'none') {
    dbg.textContent = `DEBUG  seed=${s.seed} tick=${s.tick} checksum=${checksum(s)}\n` +
      `speed=${speed}x paused=${paused} hidden=${hostHidden} enemies=${s.enemies.length} towers=${s.towers.length} kills=${s.kills} leaks=${s.leaks}\n` +
      `host: embedded=${bridge.embedded} insitu=${isInsitu()} skin=${bridge.context.skin ?? '-'} theme=${bridge.context.theme} lang=${lang} palette=${currentTheme}\n` +
      `world: field=${f?.id ?? '-'} unit=${f?.unit ?? '-'} routes=${f?.routes.length ?? 0} pads=${f?.pads.length ?? 0} cam=${cam ? `#${cam.seq} ppu=${cam.ppu.toFixed(2)} zoom=${cam.zoom.toFixed(2)}` : '-'} frames=${worldFramesSent}\n` +
      `keys: p 暂停 · 1/2/4 倍速 · g +100 CP · n 下一波 · F1/\` 开关\n` +
      `cmds=${JSON.stringify(recorded.slice(-3))}`;
  }
}

/** ?fielddebug：把游戏自己算的路线 / 塔位 / 敌人按相机矩阵描在画布上，和宿主画进三维场景的那一份叠着看——两者应当重合 */
function drawFieldDebug(cam: HostCamera, f: WorldField) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  f.routes.forEach((r, i) => {
    ctx.strokeStyle = i === 0 ? 'rgba(255, 64, 160, .9)' : 'rgba(64, 200, 255, .9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let d = 0, k = 0; ; d += 1, k++) {
      const w = routeWorld(r, Math.min(d, r.len), groundOf(f, hostGround, i));
      const p = projectWorld(cam, w.x, w.y, w.z);
      if (k === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      if (d >= r.len) break;
    }
    ctx.stroke();
  });
  ctx.fillStyle = 'rgba(255, 220, 0, .95)';
  for (const p of worldPads) {
    const q = projectWorld(cam, p.x, p.y, p.z);
    ctx.beginPath(); ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = 'rgba(255, 40, 40, .95)';
  for (const e of state.enemies) {
    const w = routeWorldAt(e.branch, e.progress);
    if (!w) continue;
    const q = projectWorld(cam, w.x, w.y, w.z);
    ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ---- 世界模式的输入：点一下 = 选塔位 / 建塔；其余手势原样交还给地图相机，和地图自己的手势是同一套——
// 拖动旋转、Shift / 中键拖动平移、滚轮 / 双指缩放、双击空白处复位。宿主用引擎原生的同一组算法与上下限去动相机，
// 相机一动，这一帧的三维画面（含战场）和 hikos:camera 一起到位，没有「游戏画面追着地图跑」这回事。
const wPointers = new Map<number, { x: number; y: number }>();
let wDown: { id: number; startX: number; startY: number; x: number; y: number; moved: boolean; pan: boolean } | null = null;
let wPinch: { dist: number; cx: number; cy: number } | null = null;
let wNoTap = false;
canvas.addEventListener('pointerdown', (ev) => {
  if (!worldField) return;
  if (ev.button !== 0 && ev.button !== 1) return;
  try { canvas.setPointerCapture(ev.pointerId); } catch { /* 合成事件没有活动指针：不捕获也能用 */ }
  wPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (wPointers.size === 2) {
    const [a, b] = [...wPointers.values()];
    wPinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    wDown = null;
    wNoTap = true;
    return;
  }
  if (wPointers.size > 2) { wDown = null; wPinch = null; wNoTap = true; return; }
  wDown = { id: ev.pointerId, startX: ev.clientX, startY: ev.clientY, x: ev.clientX, y: ev.clientY, moved: false, pan: ev.shiftKey || ev.button === 1 };
  wNoTap = false;
});
canvas.addEventListener('pointermove', (ev) => {
  if (!worldField) return;
  const tracked = wPointers.get(ev.pointerId);
  if (!tracked) {
    if (ev.pointerType !== 'touch' && !wPointers.size) setWorldHover(worldPadAt(ev.clientX, ev.clientY));
    return;
  }
  tracked.x = ev.clientX;
  tracked.y = ev.clientY;
  if (wPointers.size === 2 && wPinch) {
    const [a, b] = [...wPointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const scale = dist / Math.max(1, wPinch.dist);
    if (Math.abs(scale - 1) > 0.004 || Math.hypot(cx - wPinch.cx, cy - wPinch.cy) >= 1) {
      bridge.send({ type: 'td:camera', kind: 'pinch', scale: Math.round(scale * 1e4) / 1e4, dx: Math.round(cx - wPinch.cx), dy: Math.round(cy - wPinch.cy) });
      wPinch = { dist, cx, cy };
    }
    return;
  }
  if (wDown && wDown.id === ev.pointerId) {
    const dx = ev.clientX - wDown.x, dy = ev.clientY - wDown.y;
    if (!wDown.moved && Math.hypot(ev.clientX - wDown.startX, ev.clientY - wDown.startY) > 6) { wDown.moved = true; setWorldHover(-1); }
    if (wDown.moved && (dx || dy)) {
      bridge.send({ type: 'td:camera', kind: wDown.pan ? 'pan' : 'rotate', dx, dy });
      wDown.x = ev.clientX;
      wDown.y = ev.clientY;
    }
  }
});
function worldPointerEnd(ev: PointerEvent, cancelled: boolean) {
  if (!wPointers.has(ev.pointerId)) return;
  const d = wDown;
  const tap = !cancelled && !!d && d.id === ev.pointerId && !d.moved && !wNoTap && wPointers.size === 1 && ev.button === 0;
  wPointers.delete(ev.pointerId);
  wDown = null;
  wPinch = null;
  if (!wPointers.size) wNoTap = false;
  try { canvas.releasePointerCapture(ev.pointerId); } catch { /* 没捕获过 */ }
  if (tap && worldField) worldTap(ev.clientX, ev.clientY, ev.pointerType === 'touch');
}
canvas.addEventListener('pointerup', (ev) => worldPointerEnd(ev, false));
canvas.addEventListener('pointercancel', (ev) => worldPointerEnd(ev, true));
canvas.addEventListener('dblclick', (ev) => {
  if (!worldField || worldPadAt(ev.clientX, ev.clientY) >= 0) return;
  bridge.send({ type: 'td:camera', kind: 'reset' });
});
// Safari（macOS 触控板、iPadOS）把捏合报成 gesture 事件：指针事件已经在跟的双指捏合不重复算
let wGestureScale = 1;
canvas.addEventListener('gesturestart', (ev) => { if (!worldField) return; ev.preventDefault(); wGestureScale = 1; }, { passive: false });
canvas.addEventListener('gesturechange', (ev) => {
  if (!worldField) return;
  ev.preventDefault();
  const sc = (ev as unknown as { scale?: number }).scale;
  if (wPointers.size >= 2 || typeof sc !== 'number' || !Number.isFinite(sc) || sc <= 0) return;
  const stepScale = sc / wGestureScale;
  if (Math.abs(stepScale - 1) > 0.004) {
    bridge.send({ type: 'td:camera', kind: 'pinch', scale: Math.round(stepScale * 1e4) / 1e4, dx: 0, dy: 0 });
    wGestureScale = sc;
  }
}, { passive: false });
canvas.addEventListener('gestureend', (ev) => { if (worldField) ev.preventDefault(); }, { passive: false });

/** 世界模式下「推倒哪座楼」：指定了就用指定的，否则挑离路线最近的一座真实建筑（起终点和母星除外） */
function worldDemolishTarget(targetKey?: string): { key: string; label: string; x: number; z: number } | null {
  const f = worldField, w = hostWorld;
  if (!f || !w) return null;
  const already = new Set((state.demolished ?? []).map((d) => d.key));
  const anchors = new Set([f.base.key, f.spawn.key, f.spawn2?.key ?? null]);
  const pool = w.places.filter((p) => p.kind === 'entity' && !anchors.has(p.key) && !already.has(p.key));
  const named = targetKey ? pool.find((p) => p.key === targetKey) : null;
  if (named) return named;
  let best: (typeof pool)[number] | null = null, bd = Infinity;
  for (const p of pool) {
    let d = Infinity;
    for (const r of f.routes) for (let a = 0; a <= r.len; a += f.unit) {
      const q = routePoint(r, a);
      d = Math.min(d, (q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z));
    }
    if (d < bd - 1e-9 || (best && Math.abs(d - bd) <= 1e-9 && p.key < best.key)) { bd = d; best = p; }
  }
  return best;
}

function screenPointForMilli(mx: number, my: number): { x: number; y: number } {
  if (worldField) {
    if (!hostCamera) return { x: -9999, y: -9999 };
    const w = milliWorld(mx, my);
    return projectWorld(hostCamera, w.x, w.y, w.z);
  }
  if (isInsitu()) {
    if (!currentProjector) syncProjector();
    if (currentProjector) return currentProjector.milliToScreen(mx, my);
  }
  return { x: toPx(mx), y: toPx(my) };
}

function onEvents(evs: GameEvent[]) {
  const now = performance.now();
  const rm = isReducedMotion();
  const lex = getCulturalLexicon(activeSkin());
  for (const e of evs) {
    if (e.type === 'build_rejected' || e.type === 'wave_rejected') { toast = e.message; toastUntil = now + 1800; }
    if (worldField) {
      // 世界模式：弹道 / 受击 / 击破由宿主画在三维场景里（td:frame 的 shots、flags、fx），这里只留贴着世界位置的跳字
      if (e.type === 'attack') {
        towerRecoils.set(e.tower, now + 140);
        enemyHitFlashes.set(e.target, now + 95);
        vfxStats.shotsFired++;
        vfxStats.muzzleFlashes++;
        vfxStats.recoils++;
        vfxStats.hitFlashes++;
        const twInst = state.towers.find((tw) => tw.iid === e.tower);
        const enInst = state.enemies.find((en) => en.iid === e.target);
        const hit = (enInst ? routeWorldAt(enInst.branch, enInst.progress) : null) ?? milliWorld(e.tx, e.ty);
        worldShots.push({ tower: e.tower, target: e.target, x: hit.x, z: hit.z, until: now + 115 });
        if (worldShots.length > 64) worldShots.splice(0, worldShots.length - 64);
        const twId = twInst?.def ?? pack.towers[0].id;
        const counter = computeCounterPreview(twId, enInst?.def ?? pack.enemies[0].id, activeSkin());
        const dmgVal = pack.towers.find((d) => d.id === twId)?.damage ?? 15;
        const heavy = dmgVal >= 35 || counter.isCounter;
        worldPopups.push({
          x: hit.x, y: hit.y + 1.4, z: hit.z, rise: 0,
          text: counter.isCounter ? `${lang === 'zh' ? counter.tagZh : counter.tagEn} -${dmgVal}` : `-${dmgVal}`,
          color: counter.isCounter ? lex.vfx.critColor : (theme.paper ?? '#ffffff'),
          critical: heavy, life: 0.55, maxLife: 0.55,
        });
        if (worldPopups.length > 48) worldPopups.splice(0, worldPopups.length - 48);
        if (heavy) {
          vfxStats.armorBreakPopups++;
          if (!rm) { hitStopUntil = Math.max(hitStopUntil, now + lex.vfx.hitStopMs); vfxStats.hitStops++; }
        }
      } else if (e.type === 'entity_escaped') {
        worldFx.push(['leak', worldField.base.x, worldField.base.z]);
        vfxStats.baseRipples++;
      } else if (e.type === 'entity_died') {
        const w = milliToWorld(worldField, e.x, e.y);
        worldFx.push(['die', w.x, w.z]);
      } else if (e.type === 'build_ok') {
        const w = milliToWorld(worldField, milliOf(e.x), milliOf(e.y));
        worldFx.push(['build', w.x, w.z]);
      } else if (e.type === 'wave_cleared') {
        const btn = document.getElementById('start-wave');
        if (btn) btn.style.display = 'block';
      } else if (e.type === 'battle_ended') {
        settleCurrentMatch(e.result);
      }
      if (worldFx.length > 96) worldFx.splice(0, worldFx.length - 96);
      continue;
    }
    if (e.type === 'attack') {
      shots.push({ fx: e.fx, fy: e.fy, tx: e.tx, ty: e.ty, until: now + 115, towerIid: e.tower, targetIid: e.target });
      towerRecoils.set(e.tower, now + 140);
      enemyHitFlashes.set(e.target, now + 95);
      vfxStats.shotsFired++;
      vfxStats.muzzleFlashes++;
      vfxStats.recoils++;
      vfxStats.hitFlashes++;

      const twInst = state.towers.find((t) => t.iid === e.tower);
      const enInst = state.enemies.find((en) => en.iid === e.target);
      const twId = twInst?.def ?? 'crossbow';
      const enId = enInst?.def ?? 'footman';
      const counter = computeCounterPreview(twId, enId, activeSkin());
      const hitPt = screenPointForMilli(e.tx, e.ty);

      // 护盾波纹（Shield Ripple）
      shieldRipples.push({
        x: hitPt.x,
        y: hitPt.y,
        r: 6,
        maxR: counter.isCounter ? 24 : 17,
        color: counter.isCounter ? lex.vfx.critColor : lex.vfx.shieldColor,
        life: 0.28,
        maxLife: 0.28,
        isBase: false,
      });
      vfxStats.shieldRipples++;

      // 受击碎屑粒子（非减弱动态下触发）
      if (!rm) {
        const shardCount = counter.isCounter ? 8 : 4;
        for (let i = 0; i < shardCount; i++) {
          const ang = (Math.PI * 2 * i) / shardCount + (e.target % 3) * 0.2;
          const spd = 45 + (i % 3) * 25;
          particles.push({
            x: hitPt.x,
            y: hitPt.y,
            vx: Math.cos(ang) * spd,
            vy: Math.sin(ang) * spd - 15,
            life: 0.32,
            maxLife: 0.32,
            color: counter.isCounter ? lex.vfx.critColor : lex.vfx.shieldColor,
          });
        }
      }

      // 破甲/破盾跳字与重击短帧顿挫（Hit-stop）+ 轻度屏震
      const twDef = pack.towers.find((d) => d.id === twId);
      const dmgVal = twDef?.damage ?? 15;
      const isHeavyShot = dmgVal >= 35 || counter.isCounter;
      const popupText = counter.isCounter
        ? `${lang === 'zh' ? counter.tagZh : counter.tagEn} -${dmgVal}`
        : `-${dmgVal}`;
      floatingPopups.push({
        x: hitPt.x,
        y: hitPt.y - 14,
        text: popupText,
        color: counter.isCounter ? lex.vfx.critColor : (theme.paper ?? '#ffffff'),
        critical: isHeavyShot,
        life: 0.55,
        maxLife: 0.55,
      });
      if (isHeavyShot) {
        vfxStats.armorBreakPopups++;
        if (!rm) {
          hitStopUntil = Math.max(hitStopUntil, now + lex.vfx.hitStopMs);
          screenShakeUntil = Math.max(screenShakeUntil, now + 160);
          vfxStats.hitStops++;
          vfxStats.screenShakes++;
        }
      }
    }

    if (e.type === 'entity_escaped') {
      // 基地受创时触发基地能量护盾涟漪与轻度屏幕震动
      const endCell = pack.map.path[pack.map.path.length - 1] ?? { x: pack.map.width - 1, y: pack.map.height - 1 };
      const basePt = screenPointForMilli(endCell.x * CELL + 500, endCell.y * CELL + 500);
      shieldRipples.push({
        x: basePt.x,
        y: basePt.y,
        r: 12,
        maxR: 46,
        color: theme.danger ?? '#ff5238',
        life: 0.55,
        maxLife: 0.55,
        isBase: true,
      });
      vfxStats.baseRipples++;
      if (!rm) {
        screenShakeUntil = Math.max(screenShakeUntil, now + 240);
        vfxStats.screenShakes++;
      }
    }

    if (e.type === 'wave_cleared') {
      const btn = document.getElementById('start-wave');
      if (btn) btn.style.display = 'block';
    }
    if (e.type === 'battle_ended') {
      settleCurrentMatch(e.result);
    }
    if (e.type === 'entity_died' && !rm) {
      const pt = screenPointForMilli(e.x, e.y);
      for (let i = 0; i < 12; i++) {
        particles.push({
          x: pt.x, y: pt.y,
          vx: (Math.random() - 0.5) * 100, vy: (Math.random() - 0.5) * 100,
          life: 0.45 + Math.random() * 0.35, maxLife: 0.8, color: theme.danger ?? '#f55'
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
  const now = performance.now();
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].x += particles[i].vx * dt;
    particles[i].y += particles[i].vy * dt;
    particles[i].life -= dt;
    if (particles[i].life <= 0) particles.splice(i, 1);
  }
  if (particles.length > 160) particles.splice(0, particles.length - 160);
  for (let i = floatingPopups.length - 1; i >= 0; i--) {
    floatingPopups[i].y -= 22 * dt;
    floatingPopups[i].life -= dt;
    if (floatingPopups[i].life <= 0) floatingPopups.splice(i, 1);
  }
  if (floatingPopups.length > 48) floatingPopups.splice(0, floatingPopups.length - 48);
  for (let i = worldPopups.length - 1; i >= 0; i--) {
    worldPopups[i].rise += 22 * dt;
    worldPopups[i].life -= dt;
    if (worldPopups[i].life <= 0) worldPopups.splice(i, 1);
  }
  for (let i = shieldRipples.length - 1; i >= 0; i--) {
    shieldRipples[i].life -= dt;
    if (shieldRipples[i].life <= 0) shieldRipples.splice(i, 1);
  }
  if (shieldRipples.length > 32) shieldRipples.splice(0, shieldRipples.length - 32);
  if (shots.length > 64) shots.splice(0, shots.length - 64);
  for (const [k, exp] of towerRecoils) if (exp < now) towerRecoils.delete(k);
  for (const [k, exp] of enemyHitFlashes) if (exp < now) enemyHitFlashes.delete(k);

  if (r.events.length || cmds.length) renderHud();
  if (r.events.some((e) => e.type === 'wave_started' || e.type === 'wave_cleared' || e.type === 'battle_ended' || e.type === 'gambit_accepted')) scheduleCard();
}

const toPx = (m: number) => (m / CELL) * PX;
/** 胜负横幅上的结算行（未分胜负时没有） */
function settlementTextNow(): string | undefined {
  const s = state;
  if (s.phase !== 'won' && s.phase !== 'lost') return undefined;
  const walletCp = lastSettlement?.balanceCp ?? bridge.context.wallet?.balanceCp ?? localWalletCp;
  const walletLabel = walletCp !== null && walletCp !== undefined ? `${walletCp} CP` : (lang === 'zh' ? '同步中' : 'Syncing');
  return lang === 'zh'
    ? `本局结算 ${s.phase === 'won' ? `+${MATCH_WIN_CP}` : MATCH_LOSS_CP} CP · ${t('wallet')} ${walletLabel}`
    : `Match ${s.phase === 'won' ? `+${MATCH_WIN_CP}` : MATCH_LOSS_CP} CP · ${t('wallet')} ${walletLabel}`;
}
function draw() {
  const s = state;
  if (worldField) { drawWorldOverlay(); return; }
  const settlementText = settlementTextNow();
  if (isInsitu()) {
    if (!currentProjector) syncProjector();
    ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
    drawSpatialBattlefield(ctx, s, pack, theme, currentProjector!, {
      pathCells: PATH_CELLS,
      cardView,
      selectedTowerId: selected,
      previewOptionId,
      hoverCell,
      shots,
      particles,
      floatingPopups,
      shieldRipples,
      towerRecoils,
      enemyHitFlashes,
      screenShakeUntil,
      reducedMotion: isReducedMotion(),
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
  const logicalW = pack.map.width * PX;
  const logicalH = pack.map.height * PX;
  ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, logicalW, logicalH);

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
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, logicalW, logicalH);
    ctx.fillStyle = theme.paper ?? theme.text; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(s.phase === 'won' ? t('held') : t('fell'), logicalW / 2, logicalH / 2 - 12);
    if (settlementText) {
      ctx.font = 'bold 18px sans-serif';
      ctx.fillStyle = s.phase === 'won' ? (theme.ok ?? '#338a72') : (theme.danger ?? '#ff9a8a');
      ctx.fillText(settlementText, logicalW / 2, logicalH / 2 + 24);
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
  const inHitStop = !isReducedMotion() && now < hitStopUntil;
  acc += Math.min(250, now - last) * (paused || inLobby || hostHidden || inHitStop ? 0 : speed); last = now;
  let n = 0;
  while (acc >= TICK_MS && n < 16) { tickOnce(); acc -= TICK_MS; n++; }
  if (!hostHidden || firstFrame) draw();
  if (firstFrame) { firstFrame = false; bridge.ready(); reportState(); }   // 首帧可交互后向宿主报 td:ready（接入说明 §1.6）
  pumpWorld(now);
  requestAnimationFrame(frame);
}

// ---- D2 lobby: 皮肤化紧凑参谋议事对话框 + 战前敕令三选一 + 兵种克制与路线分流 + 危机挑战词缀 ----
const lobby = document.createElement('div');
lobby.id = 'lobby';
root.append(lobby);
const esc = escHtml;
const safeAvatar = (u?: string) => !!u && (/^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/i.test(u) || /^https?:\/\//i.test(u) || u.startsWith('/'));
let designing = false;   // 关卡设计参谋（LLM）出活中：按钮置灰，防连点
let lastSum: Summary | undefined;

function activeAdvisorAgent(): AdvisorAgent | null {
  return session.agent ?? hostChannel?.agent ?? null;
}

function lobbyIdentityHtml(sum?: Summary): string {
  const sk = activeSkin();
  const lex = getCulturalLexicon(sk);
  const ag = activeAdvisorAgent();
  const rawWho = sum?.provider ?? (llmLevelProvider ? llmLevelProvider.name : provider.name);
  const who = sk ? replaceAncientTerms(cleanTechTerms(rawWho, lang), sk, lang) : cleanTechTerms(rawWho, lang);
  const avHtml = ag?.name
    ? (safeAvatar(ag.avatar)
        ? `<img class="lobby-adv-av" src="${esc(ag.avatar!)}" alt="${esc(ag.name)}">`
        : `<span class="lobby-adv-av lobby-adv-glyph"${ag.color ? ` style="--adv-c:${esc(ag.color)}"` : ''}>${esc([...ag.name][0] ?? lex.advisorGlyph.zh)}</span>`)
    : `<span class="lobby-adv-av lobby-adv-glyph">${esc(sk ? lex.advisorGlyph[lang] : '军')}</span>`;
  const personaAttr = ag?.persona ? ` title="${esc(ag.persona)}"` : '';
  const personaHtml = ag?.persona ? `<p class="lobby-persona" id="lobby-persona" hidden>${esc(ag.persona)}</p>` : '';
  const councilHeading = sk ? lex.councilTitle[lang] : (lang === 'zh' ? '军师议事' : 'Tactical Council');
  return `<div id="lobby-head"${personaAttr}><h3>${avHtml}<span class="lobby-title-text" id="lobby-council-title">${esc(councilHeading)}</span> <small id="lobby-who">${esc(who)}</small></h3>${personaHtml}</div>`;
}

function renderLobbyStream(p: LevelStreamProgress) {
  const out = lobby.querySelector('#summary');
  if (!out) return;
  const sk = activeSkin();
  const lex = getCulturalLexicon(sk);
  let box = out.querySelector('.stream-box') as HTMLElement | null;
  if (!box) {
    out.innerHTML = `<div class="stream-box lobby-chat-bubble" id="lobby-stream"><div class="stream-head"><span class="adv-pulse-dot"></span><p class="stream-stage" id="stream-stage"></p></div><div class="stream-parsed chat-md-body" id="stream-parsed"></div></div>`;
    box = out.querySelector('.stream-box') as HTMLElement | null;
  }
  const stageEl = out.querySelector('#stream-stage');
  const parsedEl = out.querySelector('#stream-parsed');
  const ag = activeAdvisorAgent();
  const actor = ag?.name ? `${lex.advisorRole[lang]}「${ag.name}」` : (sk ? replaceAncientTerms(cleanTechTerms(p.provider || lex.advisorRole.zh, lang), sk, lang) : cleanTechTerms(p.provider || '军师', lang));
  const stageText = sk ? replaceAncientTerms(cleanTechTerms(p.stage || '正在推演防线与兵力部署…', lang), sk, lang) : cleanTechTerms(p.stage || '正在推演阵法与兵力部署…', lang);
  if (stageEl) {
    stageEl.textContent = `${actor} · ${stageText}`;
  }
  if (parsedEl) {
    parsedEl.innerHTML = extractNaturalAdvisorSpeech(p.text, stageText, lang);
  }
}

function showLobby(sum?: Summary, text = '') {
  inLobby = true; lobby.style.display = 'block'; advisorBox.style.display = isInsitu() ? 'block' : 'none';
  lastSum = sum;
  const sk = activeSkin();
  const lex = getCulturalLexicon(sk);
  const presets = sk
    ? lex.presets
    : [
        { label: '长坂坡雨夜', prompt: '长坂坡雨夜，轻骑突袭' },
        { label: '水路伏击', prompt: '水路栈道伏击，人海战术' },
        { label: '重甲攻城', prompt: '重甲铁骑攻城，高CP奖励' },
      ];
  const placeholderText = sk ? lex.placeholder[lang] : '输入战局构想，例如：长坂坡雨夜，轻骑突袭';
  const edictsHtml = `<div class="lobby-section-title"><span>${esc(lex.edictTitle[lang])}</span><small>${lang === 'zh' ? '风险—回报抉择（可点选）' : 'Risk-Reward'}</small></div>
    <div class="edict-grid" id="lobby-edicts" role="radiogroup">
      ${lex.edicts.map((ed) => {
        const active = selectedEdictId === ed.id;
        return `<button type="button" class="edict-card${active ? ' active' : ''}" data-edict="${esc(ed.id)}" aria-pressed="${active ? 'true' : 'false'}">
          <span class="edict-radio" aria-hidden="true">${active ? '✓' : ''}</span>
          <span><b>${esc(ed.name[lang])}</b><span>+${esc(ed.upside[lang])} / -${esc(ed.downside[lang])}</span></span>
        </button>`;
      }).join('')}
    </div>`;

  const crisisRank = activeAffixIds.length;
  const affixesHtml = `<div class="lobby-section-title"><span>${esc(lex.affixTitle[lang])}</span><small id="td-crisis-rating">${lang === 'zh' ? `挑战评级 R${crisisRank}` : `Crisis R${crisisRank}`}</small></div>
    <div class="affix-row" id="lobby-affixes">
      ${lex.affixes.map((af) => {
        const active = activeAffixIds.includes(af.id);
        return `<button type="button" class="affix-chip${active ? ' active' : ''}" data-affix="${esc(af.id)}" aria-pressed="${active ? 'true' : 'false'}" title="${esc(af.desc[lang])}">
          ${esc(af.name[lang])}
        </button>`;
      }).join('')}
    </div>`;

  const counterHtml = `<div class="counter-matrix" id="lobby-counters">
    <div><strong>${lang === 'zh' ? '兵种克制' : 'Counters'}</strong>：${esc(lex.towers.crossbow[lang])}克${esc(lex.enemies.footman[lang])} · ${esc(lex.towers.fire_brazier[lang])}克${esc(lex.enemies.light_cavalry[lang])} · ${esc(lex.towers.catapult[lang])}克${esc(lex.enemies.heavy_armor[lang])}</div>
    <div><strong>${lang === 'zh' ? '路线分流' : 'Route Split'}</strong>：${esc(lex.routeSplitLabel[lang])}</div>
  </div>`;

  lobby.innerHTML = `<div class="card">${lobbyIdentityHtml(sum)}
  <textarea id="desc" rows="2" placeholder="${esc(placeholderText)}">${esc(text)}</textarea>
  <div class="lobby-presets">${presets.map((pr) => `<button type="button" class="preset-chip" data-preset="${esc(pr.prompt)}">${esc(pr.label)}</button>`).join('')}</div>
  ${edictsHtml}
  ${affixesHtml}
  ${counterHtml}
  <div class="row"><button id="gen" class="primary-btn"${designing ? ' disabled' : ''}>${designing ? '军师推演中…' : '让军师设计'}</button><button id="td-direct-play" class="ghost-btn" type="button">直接原位布防</button></div>
  <div id="summary"></div></div>`;

  lobby.querySelectorAll('.preset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const preset = (chip as HTMLElement).dataset.preset || '';
      const area = lobby.querySelector('#desc') as HTMLTextAreaElement | null;
      if (area && preset) area.value = preset;
    });
  });

  // 修复 #26913 ⑤ 战前参谋敕令在触控屏/iPad Safari 下点击失效问题：原地切换 .active 与 aria-pressed，不在 click 回调中整块销毁重建 lobby DOM
  lobby.querySelectorAll('[data-edict]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = (btn as HTMLElement).dataset.edict as EdictOptionSpec['id'];
      selectedEdictId = selectedEdictId === id ? null : id;
      syncPackLexicon(true);
      lobby.querySelectorAll('[data-edict]').forEach((el) => {
        const b = el as HTMLElement;
        const on = b.dataset.edict === selectedEdictId;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        const radio = b.querySelector('.edict-radio');
        if (radio) radio.textContent = on ? '✓' : '';
      });
      renderHud();
      scheduleCard();
      draw();
    });
  });

  lobby.querySelectorAll('[data-affix]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = (btn as HTMLElement).dataset.affix as CrisisAffixSpec['id'];
      if (activeAffixIds.includes(id)) activeAffixIds = activeAffixIds.filter((x) => x !== id);
      else activeAffixIds = [...activeAffixIds, id];
      syncPackLexicon(true);
      lobby.querySelectorAll('[data-affix]').forEach((el) => {
        const b = el as HTMLElement;
        const on = activeAffixIds.includes(b.dataset.affix as CrisisAffixSpec['id']);
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const ratingEl = lobby.querySelector('#td-crisis-rating');
      if (ratingEl) ratingEl.textContent = lang === 'zh' ? `挑战评级 R${activeAffixIds.length}` : `Crisis R${activeAffixIds.length}`;
      renderHud();
      scheduleCard();
      draw();
    });
  });

  lobby.querySelector('#td-direct-play')?.addEventListener('click', () => enterBattleInSitu());
  const out = lobby.querySelector('#summary')!;
  if (designing && !sum) {
    const ag = activeAdvisorAgent();
    const actor = ag?.name ? `${lex.advisorRole[lang]}「${ag.name}」` : (sk ? lex.advisorRole[lang] : cleanTechTerms(llmLevelProvider?.name ?? '军师', lang));
    out.innerHTML = `<div class="stream-box lobby-chat-bubble" id="lobby-stream"><div class="stream-head"><span class="adv-pulse-dot"></span><p class="stream-stage" id="stream-stage">${esc(actor)} · 正在勘察地形并推演防线…</p></div><div class="stream-parsed chat-md-body" id="stream-parsed"><p class="chat-md-p">正在结合当前地图地势编排单位与防卫设施…</p></div></div>`;
  } else if (sum) {
    const ag = activeAdvisorAgent();
    const speaker = ag?.name ? `${ag.name}${ag.title ? `（${ag.title}）` : ''}` : (sk ? replaceAncientTerms(cleanTechTerms(sum.provider, lang), sk, lang) : cleanTechTerms(sum.provider, lang));
    const cleanNote = sum.note ? (sk ? replaceAncientTerms(cleanTechTerms(sum.note, lang), sk, lang) : cleanTechTerms(sum.note, lang)) : '';
    const greedyRun = sum.dryrun.find((d) => d.bot === 'greedy');
    const simLine = greedyRun
      ? `沙盘预演结论：若在折角要冲合理布设防线，可稳守核心（预计余量 ${greedyRun.base_hp}，仅漏 ${greedyRun.leaks} 单位）。`
      : '';
    const localizedTowers = sum.towers.map((tw) => sk ? replaceAncientTerms(cleanTechTerms(tw, lang), sk, lang) : cleanTechTerms(tw, lang));
    const localizedEnemies = sum.enemies.map((en) => sk ? replaceAncientTerms(cleanTechTerms(en, lang), sk, lang) : cleanTechTerms(en, lang));
    out.innerHTML = `<div class="lobby-chat-bubble result-bubble">
      <div class="chat-msg-head"><strong>${esc(speaker)}</strong><span>防线成稿</span></div>
      <p class="echo">${esc(sk ? replaceAncientTerms(cleanTechTerms(sum.echo, lang), sk, lang) : cleanTechTerms(sum.echo, lang))}</p>
      ${simLine ? `<p class="dry">${esc(simLine)}</p>` : ''}
      <div class="lobby-pack-grid">
        <div><span class="meta-k">防卫设施</span><span class="meta-v">${esc(localizedTowers.join(' · '))}</span></div>
        <div><span class="meta-k">来袭单位</span><span class="meta-v">${esc(localizedEnemies.join(' · '))}</span></div>
        <div><span class="meta-k">攻势编组</span><span class="meta-v">共 ${sum.waves.length} 波（${sum.waves.map((w, i) => `W${i + 1}:${w.total}`).join(' / ')}）</span></div>
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
    const tx = (lobby.querySelector('#desc') as HTMLTextAreaElement).value.trim() || presets[0].prompt;
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
function cleanupBattleResources() {
  particles.length = 0;
  shots.length = 0;
  floatingPopups.length = 0;
  shieldRipples.length = 0;
  worldPopups.length = 0;
  worldShots.length = 0;
  worldFx.length = 0;
  worldRingPad = -1;
  towerRecoils.clear();
  enemyHitFlashes.clear();
  recorded.length = 0;
  queue = [];
  hitStopUntil = 0;
  screenShakeUntil = 0;
  previewOptionId = null;
  if (state.craters && state.craters.length > 0) state = { ...state, craters: [] };
  if (state.demolished && state.demolished.length > 0) state = { ...state, demolished: [] };
  if (!firstFrame) {
    bridge.send({ type: 'td:restore', v: 1 });
  }
}

window.addEventListener('pagehide', () => {
  cleanupBattleResources();
  cancelAnimationFrame(cardRaf);
  cancelAnimationFrame(fitRaf);
});

function startCampaignLevel(lv: number, skinOverride?: string | null) {
  campaignLevel = Math.max(1, Math.min(CAMPAIGN_MAX_LEVEL, Math.round(lv || 1)));
  const sk = skinOverride ?? activeSkin() ?? CAMPAIGN_SKIN_ROTATION[(campaignLevel - 1) % CAMPAIGN_SKIN_ROTATION.length];
  const nextPack = generateCampaignPack(campaignLevel, sk, lang, selectedEdictId, activeAffixIds);
  startWith(nextPack);
  return {
    level: campaignLevel,
    maxLevel: CAMPAIGN_MAX_LEVEL,
    skin: sk,
    theme: pack.meta.theme,
    enemyTypes: pack.enemies.length,
    waveCount: pack.waves.length,
    pathCellsCount: pathCellCount(),
  };
}

/** 路线有多少格（世界模式下是真实道路按每格世界长度折算的格数） */
function pathCellCount(): number {
  return pack.map.free ? Math.round(pathLength(pack.map.path) / CELL) : PATH_CELLS.size;
}

function startWith(p: ContentPack) {
  cleanupBattleResources();
  baseRawPack = p;
  refreshField();   // 世界模式：新内容包的路线长度、关卡号（轮换起点）变了，战场跟着重新选路
  syncPackLexicon(false);
  PATH_CELLS = pathCellSet(pack);
  syncProjector();
  selected = pack.towers[0].id;
  matchSeq++;
  lastSettlement = null;
  state = createBattle(pack, SEED + campaignLevel - 1);
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
  get cultural() {
    const sk = activeSkin();
    const lex = getCulturalLexicon(sk);
    return {
      skin: lex.skin,
      worldTitle: lex.worldTitle[lang],
      councilTitle: lex.councilTitle[lang],
      advisorRole: lex.advisorRole[lang],
      baseTitle: lex.baseTitle[lang],
      spawnTitle: lex.spawnTitle[lang],
      gambitTitle: lex.gambitTitle[lang],
      towers: pack.towers.map((t) => ({
        id: t.id,
        name: t.display_name,
        weapon: lex.towers[t.id]?.[lang === 'zh' ? 'weaponZh' : 'weaponEn'] ?? '',
        role: lex.towers[t.id]?.[lang === 'zh' ? 'roleZh' : 'roleEn'] ?? '',
      })),
      enemies: pack.enemies.map((e) => ({
        id: e.id,
        name: e.display_name,
        trait: lex.enemies[e.id]?.[lang === 'zh' ? 'traitLabelZh' : 'traitLabelEn'] ?? '',
        counteredBy: lex.enemies[e.id]?.[lang === 'zh' ? 'counteredByZh' : 'counteredByEn'] ?? '',
      })),
      mappingTable: buildCulturalMappingTable(),
    };
  },
  get vfx() {
    const lex = getCulturalLexicon(activeSkin());
    return {
      projectileStyle: lex.vfx.projectileStyle,
      reducedMotion: isReducedMotion(),
      activeShots: shots.length,
      activePopups: floatingPopups.length,
      activeRipples: shieldRipples.length,
      activeParticles: particles.length,
      screenShaking: !isReducedMotion() && performance.now() < screenShakeUntil,
      hitStopping: !isReducedMotion() && performance.now() < hitStopUntil,
      stats: { ...vfxStats },
    };
  },
  get tactics() {
    const lex = getCulturalLexicon(activeSkin());
    return {
      selectedEdictId,
      edicts: lex.edicts,
      activeAffixIds: [...activeAffixIds],
      affixes: lex.affixes,
      crisisRating: `R${activeAffixIds.length}`,
      routeSplitLabel: lex.routeSplitLabel[lang],
      counterMatrix: pack.towers.map((tw) => ({
        towerId: tw.id,
        towerName: tw.display_name,
        vs: pack.enemies.map((en) => ({
          enemyId: en.id,
          enemyName: en.display_name,
          ...computeCounterPreview(tw.id, en.id, activeSkin()),
        })),
      })),
    };
  },
  setReducedMotion: (on: boolean | null) => {
    userReducedMotionOverride = on;
    if (isReducedMotion()) {
      screenShakeUntil = 0;
      hitStopUntil = 0;
    }
    renderHud();
    draw();
    return isReducedMotion();
  },
  selectEdict: (id: EdictOptionSpec['id'] | null) => {
    selectedEdictId = id;
    syncPackLexicon(true);
    if (inLobby) showLobby(lastSum);
    renderHud();
    return selectedEdictId;
  },
  toggleAffix: (id: CrisisAffixSpec['id']) => {
    if (activeAffixIds.includes(id)) activeAffixIds = activeAffixIds.filter((x) => x !== id);
    else activeAffixIds = [...activeAffixIds, id];
    syncPackLexicon(true);
    if (inLobby) showLobby(lastSum);
    renderHud();
    return [...activeAffixIds];
  },
  triggerDemoCombatVfx: () => {
    if (inLobby) enterBattleInSitu();
    if (worldField) {
      // 世界模式的演示局面：沿真实路线从前到后摆 6 座塔、主线 6 个 + 分支 2 个敌人，再打一轮齐射（截图 / 验收用，不经命令队列）
      const cells = pack.map.buildable_cells;
      if (!state.towers.length && cells.length) {
        const n = Math.min(6, cells.length);
        for (let k = 0; k < n; k++) {
          const pad = Math.min(cells.length - 1, Math.round(((k + 0.5) / n) * cells.length - 0.5));
          const c = cells[pad];
          if (state.occupied.includes(`${c.x},${c.y}`)) continue;
          state.towers.push({ iid: 901 + k, def: pack.towers[k % pack.towers.length].id, cx: c.x, cy: c.y, x: milliOf(c.x), y: milliOf(c.y), cooldown: 0, life: 'alive' });
          state.occupied.push(`${c.x},${c.y}`);
        }
      }
      if (!state.enemies.length) {
        const paths = [pack.map.path, ...(pack.map.branch_paths ?? [])];
        const put = (iid: number, branch: number, frac: number, defIdx: number) => {
          const path = paths[branch] ?? paths[0];
          const progress = Math.round(pathLength(path) * frac);
          const at = positionAt(path, progress);
          const def = pack.enemies[defIdx % pack.enemies.length];
          state.enemies.push({ iid, def: def.id, hp: Math.max(1, Math.round(def.hp * (0.45 + 0.5 * frac))), progress, x: at.x, y: at.y, life: 'alive', ...(branch > 0 ? { branch } : {}) });
        };
        [0.1, 0.26, 0.42, 0.58, 0.74, 0.9].forEach((fr, k) => put(951 + k, 0, fr, k));
        if (paths.length > 1) { put(961, 1, 0.2, 1); put(962, 1, 0.45, 2); }
      }
      const evs: GameEvent[] = [];
      state.towers.slice(0, 3).forEach((tw, k) => {
        const en = state.enemies[Math.min(state.enemies.length - 1, k * 2)];
        if (en) evs.push({ type: 'attack', tower: tw.iid, target: en.iid, fx: tw.x, fy: tw.y, tx: en.x, ty: en.y });
      });
      evs.push({ type: 'entity_escaped', iid: 999, base_damage: 1 });
      onEvents(evs);
      renderHud();
      draw();
      return (window as any).__td.vfx;
    }
    if (!state.towers.length && currentProjector?.tacticalSlots.length) {
      const s0 = currentProjector.tacticalSlots[0];
      const s1 = currentProjector.tacticalSlots[1] ?? s0;
      const s2 = currentProjector.tacticalSlots[2] ?? s1;
      state.towers.push(
        { iid: 901, def: pack.towers[0].id, cx: s0.x, cy: s0.y, x: (s0.x + 0.5) * CELL, y: (s0.y + 0.5) * CELL, cooldown: 0, life: 'alive' },
        { iid: 902, def: (pack.towers[1] ?? pack.towers[0]).id, cx: s1.x, cy: s1.y, x: (s1.x + 0.5) * CELL, y: (s1.y + 0.5) * CELL, cooldown: 0, life: 'alive' },
        { iid: 903, def: (pack.towers[2] ?? pack.towers[0]).id, cx: s2.x, cy: s2.y, x: (s2.x + 0.5) * CELL, y: (s2.y + 0.5) * CELL, cooldown: 0, life: 'alive' },
      );
    }
    if (!state.enemies.length) {
      const pMid = pack.map.path[Math.min(2, pack.map.path.length - 1)];
      const pAhead = pack.map.path[Math.min(4, pack.map.path.length - 1)];
      state.enemies.push(
        {
          iid: 951,
          def: pack.enemies[0].id,
          hp: Math.round(pack.enemies[0].hp * 0.65),
          progress: 2400,
          x: (pMid.x + 0.5) * CELL,
          y: (pMid.y + 0.5) * CELL,
          life: 'alive',
        },
        {
          iid: 952,
          def: (pack.enemies[1] ?? pack.enemies[0]).id,
          hp: Math.round((pack.enemies[1] ?? pack.enemies[0]).hp * 0.8),
          progress: 4200,
          x: (pAhead.x + 0.5) * CELL,
          y: (pAhead.y + 0.5) * CELL,
          life: 'alive',
        },
      );
    }
    const tw = state.towers[0];
    const en = state.enemies[0];
    if (tw && en) {
      onEvents([
        { type: 'attack', tower: tw.iid, target: en.iid, fx: tw.x, fy: tw.y, tx: en.x, ty: en.y },
        { type: 'entity_escaped', iid: 999, base_damage: 1 },
      ]);
      draw();
    }
    return (window as any).__td.vfx;
  },
  settleNow: (outcome: 'won' | 'lost') => {
    state = { ...state, phase: outcome, base_hp: outcome === 'lost' ? 0 : Math.max(1, state.base_hp) };
    settleCurrentMatch(outcome);
    renderHud();
    draw();
    return lastSettlement;
  },
  get campaign() {
    return {
      level: campaignLevel,
      maxLevel: CAMPAIGN_MAX_LEVEL,
      skinRotation: CAMPAIGN_SKIN_ROTATION,
      enemyTypesCount: pack.enemies.length,
      enemyIds: pack.enemies.map((e) => e.id),
      towerIds: pack.towers.map((t) => t.id),
      pathCellsCount: pathCellCount(),
    };
  },
  startCampaignLevel: (lv: number, skinOverride?: string | null) => startCampaignLevel(lv, skinOverride),
  get assets3d() {
    return getSkin3dAssetManifest();
  },
  runBalanceAudit: () => {
    const sk = activeSkin() ?? 'union-atlas-3d';
    const stages = [1, 2, 3].map((lv) => {
      const p = generateCampaignPack(lv, sk, lang);
      const noTowers = dryRun(p, 'no_towers', 100 + lv);
      const poor = dryRun(p, 'poor_placement', 100 + lv);
      const greedy = dryRun(p, 'greedy', 100 + lv);
      return {
        level: lv,
        startingCp: p.map.starting_gold,
        baseHp: p.map.base_hp,
        maxEnemyBaseDamage: Math.max(...p.enemies.map((e) => e.base_damage)),
        fastEnemySpeed: p.enemies.find((e) => e.id === 'light_cavalry')?.speed ?? 52,
        enemyCount: p.enemies.length,
        noTowers: { result: noTowers.result, baseHp: noTowers.base_hp, leaks: noTowers.leaks, kills: noTowers.kills },
        poorPlacement: { result: poor.result, baseHp: poor.base_hp, leaks: poor.leaks, kills: poor.kills },
        reasonablePlacement: { result: greedy.result, baseHp: greedy.base_hp, leaks: greedy.leaks, kills: greedy.kills, towersBuilt: greedy.towers },
      };
    });
    return {
      calibratedConstants: {
        baseDamageCap: 3,
        fastEnemySpeed: 52,
        startingCpStage1: 180,
        crossbowRange: 2650,
      },
      stages,
    };
  },
  runMemoryBenchmark: (rounds = 10) => {
    const samples: {
      round: number;
      beforeCleanup: { particles: number; shots: number; popups: number; ripples: number };
      afterCleanup: { particles: number; shots: number; popups: number; ripples: number; recoils: number; flashes: number };
      heapUsedBytes: number | null;
      frameMs: number;
    }[] = [];
    for (let r = 1; r <= rounds; r++) {
      startCampaignLevel(r);
      (window as any).__td.triggerDemoCombatVfx();
      const t0 = performance.now();
      for (let k = 0; k < 15; k++) tickOnce();
      draw();
      const frameMs = Math.round(((performance.now() - t0) / 15) * 100) / 100;
      const beforeCleanup = {
        particles: particles.length,
        shots: shots.length,
        popups: floatingPopups.length,
        ripples: shieldRipples.length,
      };
      cleanupBattleResources();
      const afterCleanup = {
        particles: particles.length,
        shots: shots.length,
        popups: floatingPopups.length,
        ripples: shieldRipples.length,
        recoils: towerRecoils.size,
        flashes: enemyHitFlashes.size,
      };
      const mem = (performance as any).memory;
      samples.push({
        round: r,
        beforeCleanup,
        afterCleanup,
        heapUsedBytes: mem && typeof mem.usedJSHeapSize === 'number' ? mem.usedJSHeapSize : null,
        frameMs,
      });
    }
    startWith(DEFAULT_PACK);
    return {
      rounds,
      allZeroAfterCleanup: samples.every(
        (s) =>
          s.afterCleanup.particles === 0 &&
          s.afterCleanup.shots === 0 &&
          s.afterCleanup.popups === 0 &&
          s.afterCleanup.ripples === 0 &&
          s.afterCleanup.recoils === 0 &&
          s.afterCleanup.flashes === 0,
      ),
      samples,
    };
  },
  get insitu() { return isInsitu(); },
  setPaused: (on: boolean) => { paused = !!on; renderHud(); return paused; },
  /** 世界模式读点（E2E / 宿主侧联调）：战场几何、最近一条 td:field / td:frame、相机，以及用同一相机矩阵算出的屏幕位置 */
  get world() {
    const f = worldField;
    if (!f) return null;
    const cam = hostCamera;
    const screen = (w: WorldPoint | null) => (w && cam ? projectWorld(cam, w.x, w.y, w.z) : null);
    return {
      id: f.id, unit: f.unit, origin: { ox: f.ox, oz: f.oz },
      routes: f.routes.map((r) => ({ len: r.len, pts: r.pts, wd: r.wd })),
      pads: f.pads.map((p, i) => ({ ...p, y: worldPads[i]?.y ?? 0, occupied: padOccupied(i) })),
      spawn: f.spawn, spawn2: f.spawn2, base: f.base,
      camera: cam,
      field: lastFieldMsg, frame: lastFrameMsg, framesSent: worldFramesSent,
      hoverPad: worldHoverPad, ringPad: worldRingPad, popups: worldPopups.length, shots: worldShots.length,
      padScreen: (pad: number) => screen(worldPads[pad] ?? null),
      routeScreen: (branch: number, arc: number) => { const r = f.routes[branch]; return screen(r ? routeWorld(r, arc, groundOf(f, hostGround, branch)) : null); },
      ground: hostGround && hostGround.field === f.id ? hostGround : null,
      enemyScreen: (iid: number) => { const e = state.enemies.find((en) => en.iid === iid); return screen(e ? routeWorldAt(e.branch, e.progress) : null); },
      enemyWorld: (iid: number) => { const e = state.enemies.find((en) => en.iid === iid); return e ? routeWorldAt(e.branch, e.progress) : null; },
    };
  },
  get spatial() {
    if (!isInsitu()) return null;
    if (worldField) {
      // 世界模式没有屏幕投影器：这里只给仍然有意义的字段，战场本身看 __td.world
      const f = worldField, cam = hostCamera;
      return {
        insitu: true,
        mode: 'world',
        canvasBg: 'transparent',
        stage: { w: canvas.width / currentDpr, h: canvas.height / currentDpr, physicalW: canvas.width, physicalH: canvas.height, dpr: currentDpr },
        azimuth: cam?.azimuth ?? null,
        pitch: cam?.pitch ?? null,
        zoom: cam?.zoom ?? null,
        hostMap: bridge.context.map ?? null,
        ambientTrafficCleared: bridge.context.map?.ambientTrafficCleared ?? true,
        enemyModels: pack.enemies.map((e) => ({ id: e.id, name: e.display_name, modelKind: getMinionModelKind(e, activeSkin()), vfx: ['auraRing', 'wakeTrail', 'battleCrest'] })),
        fieldId: f.id,
        routes: f.routes.length,
        tacticalSlots: f.pads.map((p, i) => ({ slot: i, x: pack.map.buildable_cells[i]?.x, y: pack.map.buildable_cells[i]?.y, wx: p.x, wz: p.z, branch: p.branch })),
        craters: state.craters ?? [],
        demolished: state.demolished ?? [],
        slotScreen: (slot: number) => { const p = worldPads[slot]; return p && cam ? projectWorld(cam, p.x, p.y, p.z) : null; },
      };
    }
    if (!currentProjector) syncProjector();
    const p = currentProjector!;
    return {
      insitu: true,
      canvasBg: 'transparent',
      stage: { w: p.viewportW, h: p.viewportH, physicalW: canvas.width, physicalH: canvas.height, dpr: currentDpr },
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
      branchWaypoints: p.branchWaypoints,
      slotDistribution: p.slotDistribution,
      tacticalSlots: p.tacticalSlots.slice(0, 18),
      craters: state.craters ?? [],
      demolished: state.demolished ?? [],
      slotScreen: (slot: number) => { const c = slotCell(pack, slot); return c ? p.cellToScreen(c.x + 0.5, c.y + 0.5) : null; },
      cellScreen: (cx: number, cy: number) => p.cellToScreen(cx + 0.5, cy + 0.5),
    };
  },
  blastRoad: (branch = 1) => blastRoadNow(branch),
  demolishBuilding: (key?: string) => demolishBuildingNow(key),
  restoreDestruction: () => {
    cleanupBattleResources();
    renderHud();
    draw();
    return { craters: state.craters?.length ?? 0, demolished: state.demolished?.length ?? 0 };
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

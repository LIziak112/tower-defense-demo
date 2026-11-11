// 世界模式的线格式与相机投影（大厅 #27514 根治）。
//
// 世界模式下，凡是「长在地图上」的东西（路线、塔位、塔、敌人、弹道、射程圈、起终点）都由宿主画进它自己的三维场景：
// 同一个相机、同一次渲染、有深度遮挡，地图怎么缩放 / 旋转它们都贴在真实道路上。游戏只做三件事：
//   1. 规则模拟（跑在 worldField.ts 生成的真实几何上）；
//   2. 把战场与每个 tick 的状态告诉宿主：td:field（战场，重建时发）、td:frame（状态，每 tick 至多一条）；
//   3. 用宿主每帧推来的相机矩阵（hikos:camera）做两件要像素对得上的事：点哪个塔位（拾取）、跳字画在哪（投影）。
// 线格式的权威说明在 docs/hikos-world-protocol.md。这里全是纯函数：不读时钟、不碰 DOM，vitest 直接测。

import type { BattleState, ContentPack } from '../runtime/types';
import { CELL, computeFormationSynergies, pathLength } from '../runtime/sim';
import { routePoint, type FieldRoute, type WorldField } from './worldField';
import { getMinionModelKind } from './spatialMap';

export const WORLD_PROTOCOL = 1;

/** 宿主相机（hikos:camera）。m：世界坐标 (x, y, z, 1) → 游戏舞台 CSS 像素 (sx, sy, 深度, w) 的 4×4 矩阵，行主序，已含视口变换与画布偏移。 */
export interface HostCamera {
  seq: number;
  /** 舞台（iframe）CSS 宽高 */
  w: number;
  h: number;
  m: number[];
  /** 地面上 1 个世界单位在屏幕水平方向上的像素数（正交相机：处处相同） */
  ppu: number;
  azimuth: number;
  pitch: number;
  zoom: number;
}

const clampNum = (v: unknown, fb: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb;

/** 校验一条 hikos:camera（不可信输入）。矩阵必须是 16 个有限数；其余字段缺了给缺省。 */
export function parseCamera(raw: unknown): HostCamera | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const m = c.m;
  if (!Array.isArray(m) || m.length !== 16) return null;
  for (const v of m) if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e9) return null;
  // 没有 ppu 时从矩阵里量：屏幕 x 那一行的三维长度 = 沿相机右轴走 1 个世界单位在屏幕上移动的像素数（正交下与位置无关）
  const measured = Math.hypot(m[0] as number, m[1] as number, m[2] as number);
  return {
    seq: clampNum(c.seq, 0, 0, Number.MAX_SAFE_INTEGER),
    w: clampNum(c.w, 0, 0, 16384),
    h: clampNum(c.h, 0, 0, 16384),
    m: (m as number[]).slice(),
    ppu: clampNum(c.ppu, measured > 1e-6 ? measured : 1, 1e-4, 1e4),
    azimuth: clampNum(c.azimuth, 0, -10, 10),
    pitch: clampNum(c.pitch, 0.78, 0, Math.PI),
    zoom: clampNum(c.zoom, 1, 1e-3, 1e3),
  };
}

/** 世界坐标 → 舞台 CSS 像素。与宿主画这一帧用的是同一个矩阵，所以和三维画面逐像素一致。 */
export function projectWorld(cam: HostCamera, x: number, y: number, z: number): { x: number; y: number } {
  const m = cam.m;
  const w = m[12] * x + m[13] * y + m[14] * z + m[15];
  const k = Math.abs(w) > 1e-9 ? 1 / w : 1;
  return { x: (m[0] * x + m[1] * y + m[2] * z + m[3]) * k, y: (m[4] * x + m[5] * y + m[6] * z + m[7]) * k };
}

export interface WorldPoint { x: number; y: number; z: number }

/**
 * 宿主回的真实高度（hikos:ground）：它收到 td:field 后，按自己场景的地形量出每个塔位的地面高度、每条路线每个折点的路面高度。
 * 游戏只拿它做两件要像素对得上的事（点哪个塔位、跳字画在哪）；没收到之前用宿主导出道路时带的参考高度。
 *
 * step / profile（可选，游戏 0.9.2 起认）：每条路线沿路的高度剖面——从起点起每隔 step 个世界单位一个样点，最后一个样点在终点。
 * 宿主摆敌人用的就是这一组样点（样点之间线性插值），所以照着它取高度，跳字和敌人就站在同一个高度上。
 * 只有折点高度时，两个折点之间的台阶 / 桥面 / 路缘被一条直线抹平：都会滨水最多差 0.5，哥特教堂最多差 0.88。
 */
export interface HostGround { field: string; pads: number[]; routes: number[][]; step?: number; profile?: number[][] }

/** 一条路线上可用的真实高度。ys：每个折点一个；step / profile：沿路剖面，宿主给了、而且正好盖住这条路线才有 */
export interface RouteGround { ys: number[]; step?: number; profile?: number[] }

/** 剖面每条路线最多这么多个样点（step = 0.5 时是 8 公里长的路线，远超任何一块战场） */
const PROFILE_MAX = 16384;

/** 校验一条 hikos:ground（不可信输入）：只留有限数字；数组长度是否对得上由使用处核对 */
export function parseGround(raw: unknown): HostGround | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.field !== 'string' || !g.field || g.field.length > 64) return null;
  const nums = (a: unknown, max: number): number[] | null => {
    if (!Array.isArray(a) || a.length > max) return null;
    const out: number[] = [];
    for (const v of a) { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e5) return null; out.push(v); }
    return out;
  };
  const pads = nums(g.pads, 256);
  if (!pads || !Array.isArray(g.routes) || g.routes.length > 8) return null;
  const routes: number[][] = [];
  for (const r of g.routes) { const ys = nums(r, 1024); if (!ys) return null; routes.push(ys); }
  const out: HostGround = { field: g.field, pads, routes };
  // 沿路剖面是可选的加项：不成形就当没给（照旧在折点之间插值），不连累前面那几样
  if (typeof g.step === 'number' && Number.isFinite(g.step) && g.step >= 0.05 && g.step <= 100 && Array.isArray(g.profile) && g.profile.length === routes.length) {
    const profile: number[][] = [];
    for (const r of g.profile) { const ys = nums(r, PROFILE_MAX); if (!ys || ys.length < 2) return out; profile.push(ys); }
    out.step = g.step;
    out.profile = profile;
  }
  return out;
}

/** 折线的长度，累加的写法与宿主 arcade-field.js 的 buildRoute 相同（同一组折点、同一个顺序），两边算出来是同一个数 */
const lengthCache = new WeakMap<object, number>();
function polylineLength(route: FieldRoute): number {
  let len = lengthCache.get(route.pts);
  if (len === undefined) {
    len = 0;
    for (let i = 1; i < route.pts.length; i++) len += Math.hypot(route.pts[i][0] - route.pts[i - 1][0], route.pts[i][2] - route.pts[i - 1][2]);
    lengthCache.set(route.pts, len);
  }
  return len;
}

/** 这份剖面是不是正好盖住这条路线：倒数第二个样点还在路线上，最后一个样点落在终点（宿主取样的写法：count = max(2, ceil(len / step) + 1)） */
function profileFits(route: FieldRoute, step: number, profile: number[]): boolean {
  const len = polylineLength(route), n = profile.length;
  return n >= 2 && (n - 2) * step < len + 1e-6 && (n - 1) * step > len - 1e-6;
}

const groundCache = new WeakMap<HostGround, (RouteGround | null)[]>();

/** 这条路线可用的真实高度；宿主还没回 / 对不上这块战场时为 null。同一条回执只核对一次（敌人、跳字每帧都来问） */
export function groundOf(field: WorldField, ground: HostGround | null | undefined, ri: number): RouteGround | null {
  if (!ground || ground.field !== field.id) return null;
  let per = groundCache.get(ground);
  if (!per) {
    per = field.routes.map((route, i): RouteGround | null => {
      const ys = ground.routes[i];
      if (!ys || ys.length !== route.pts.length) return null;
      const profile = ground.step && ground.profile ? ground.profile[i] : undefined;
      return profile && profileFits(route, ground.step!, profile) ? { ys, step: ground.step, profile } : { ys };
    });
    groundCache.set(ground, per);
  }
  return per[ri] ?? null;
}

/**
 * 路线上弧长 s 处的路面高度，按手上有什么依次取：
 * 1. 宿主给了沿路剖面：在相邻两个样点之间线性插值——与宿主摆敌人的 along() 是同一个算式，所以跳字与敌人同高；
 * 2. 只有每个折点的真实高度（ys，也可以直接传数组）：在折点之间线性插值；
 * 3. 都没有：用宿主导出道路时带的参考高度，引道段没有参考值时取路线上最近的有高度的点。
 */
export function routeHeight(route: FieldRoute, s: number, ground?: RouteGround | number[] | null): number {
  const g: RouteGround | null = Array.isArray(ground) ? { ys: ground } : ground ?? null;
  if (g && g.profile && g.step) {
    const P = g.profile, n = P.length, step = g.step, len = polylineLength(route), c = Math.max(0, Math.min(len, s));
    const i = Math.min(n - 2, Math.floor(c / step)), span = (i === n - 2 ? len - i * step : step) || step;
    return P[i] + (P[i + 1] - P[i]) * Math.max(0, Math.min(1, (c - i * step) / span));
  }
  const q = routePoint(route, s), ys = g ? g.ys : null;
  if (ys && ys.length === route.pts.length) {
    const a = route.pts[q.seg], b = route.pts[q.seg + 1];
    if (!b) return ys[q.seg] ?? 0;
    const l = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const t = l > 1e-9 ? Math.max(0, Math.min(1, Math.hypot(q.x - a[0], q.z - a[2]) / l)) : 0;
    return ys[q.seg] + (ys[q.seg + 1] - ys[q.seg]) * t;
  }
  if (q.y !== null) return q.y;
  let best = 0, bd = Infinity;
  for (const p of route.pts) {
    if (p[1] === null) continue;
    const d = (p[0] - q.x) * (p[0] - q.x) + (p[2] - q.z) * (p[2] - q.z);
    if (d < bd) { bd = d; best = p[1]; }
  }
  return best;
}

/** 路线上弧长 s 处的世界坐标（含高度；ground 见 routeHeight） */
export function routeWorld(route: FieldRoute, s: number, ground?: RouteGround | number[] | null): WorldPoint {
  const q = routePoint(route, s);
  return { x: q.x, y: routeHeight(route, s, ground), z: q.z };
}

/**
 * 路线附近一点 (x, z) 的路面高度（命中点、被推倒的建筑、塔位旁边的字都落在路面附近）。
 * 宿主给了沿路剖面：取离它最近的那个路线点上的高度。只有折点高度 / 参考高度：取最近的那个折点的高度（0.9.1 及以前一直如此）。
 */
export function heightNear(field: WorldField, ground: HostGround | null | undefined, x: number, z: number): number {
  let y = 0, bd = Infinity;
  field.routes.forEach((route, ri) => {
    const g = groundOf(field, ground, ri), P = route.pts;
    if (g && g.profile) {
      let cum = 0;
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i], dx = b[0] - a[0], dz = b[2] - a[2], l2 = dx * dx + dz * dz, l = Math.sqrt(l2);
        const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / l2)) : 0;
        const ex = x - a[0] - dx * t, ez = z - a[2] - dz * t, d = ex * ex + ez * ez;
        if (d < bd) { bd = d; y = routeHeight(route, cum + t * l, g); }
        cum += l;
      }
      return;
    }
    P.forEach((q, i) => {
      const h = g ? g.ys[i] : q[1];
      if (h === null) return;
      const d = (q[0] - x) * (q[0] - x) + (q[2] - z) * (q[2] - z);
      if (d < bd) { bd = d; y = h; }
    });
  });
  return y;
}

/** 每个塔位的世界坐标。高度：宿主回了就用真实地面高度；否则取它旁边那段路面的参考高度（塔位就在路缘外一两个单位） */
export function padPoints(field: WorldField, ground?: HostGround | null): WorldPoint[] {
  const ys = ground && ground.field === field.id && ground.pads.length === field.pads.length ? ground.pads : null;
  return field.pads.map((p, i) => {
    const ri = field.routes[p.branch] ? p.branch : 0;
    return { x: p.x, y: ys ? ys[i] : routeHeight(field.routes[ri], p.s, groundOf(field, ground, ri)), z: p.z };
  });
}

/**
 * 屏幕上点了哪个塔位：投影后取最近的一个，且要在拾取半径内。
 * 半径 = max(minPx, 1.7 × 塔座半径的屏幕尺寸)：地图缩得很小时仍然点得中，放大后要点在塔座附近。点空返回 -1。
 */
export function pickPad(cam: HostCamera, pads: WorldPoint[], sx: number, sy: number, minPx = 26): number {
  const reach = Math.max(minPx, 1.7 * cam.ppu);
  let best = -1, bd = reach * reach;
  for (let i = 0; i < pads.length; i++) {
    const q = projectWorld(cam, pads[i].x, pads[i].y, pads[i].z);
    const d = (q.x - sx) * (q.x - sx) + (q.y - sy) * (q.y - sy);
    if (d <= bd) { bd = d; best = i; }
  }
  return best;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** 模拟里的分支号 → 战场路线下标（0 主线；k ≥ 1 轮转到各分支，与 runtime 的 pathForBranch 同一规则） */
export function routeIndex(field: Pick<WorldField, 'routes'>, branch: number | undefined): number {
  const n = field.routes.length - 1;
  if (!branch || n < 1) return 0;
  return 1 + ((branch - 1) % n);
}

/** 各路线的模拟长度（毫格），下标与 field.routes 一致 */
export function routeMilli(pack: ContentPack): number[] {
  return [pack.map.path, ...(pack.map.branch_paths ?? [])].map((p) => pathLength(p));
}

/** 模拟进度（毫格）→ 路线上的世界弧长（按总长归一：起点对起点、终点对终点） */
export function arcOf(field: Pick<WorldField, 'routes'>, milli: number[], ri: number, progress: number): number {
  const len = field.routes[ri]?.len ?? 0, total = milli[ri] ?? 0;
  return total > 0 ? Math.max(0, Math.min(len, (progress / total) * len)) : 0;
}

/** 塔的外形档：宿主按它选三维模型（速射 / 溅射 / 重炮），与内容包里塔的顺序无关 */
export function towerModel(def: { id: string; damage: number; range: number; interval_ticks: number }, index: number): 'rapid' | 'area' | 'heavy' {
  if (/catapult|stone|siege|cannon|mortar/i.test(def.id) || def.interval_ticks >= 40) return 'heavy';
  if (/fire|brazier|poison|flame|mist|coil/i.test(def.id) || def.interval_ticks <= 12) return 'area';
  return index % 3 === 2 ? 'heavy' : index % 3 === 1 ? 'area' : 'rapid';
}

export interface FieldMessageOptions {
  skin: string | null;
  lang: 'zh' | 'en';
  level: number;
  /** 起点 / 终点铭牌的前缀（按皮肤的文化设定，如「起点」「终点」） */
  spawnTitle: string;
  baseTitle: string;
  palette: { accent: string; danger: string; ok: string; paper: string; ink: string };
}

/** td:field：一块战场的全部静态内容（几何用世界坐标）。几何相同则 id 相同，宿主据此决定是重建三维物件还是只换文案 / 配色。 */
export function encodeField(field: WorldField, pack: ContentPack, o: FieldMessageOptions): Record<string, unknown> {
  const u = field.unit;
  const anchor = (a: { label: string; key: string | null; x: number; z: number }, title: string) => ({
    key: a.key, label: a.label, title: a.label ? `${title}·${a.label}` : title, x: a.x, z: a.z,
  });
  return {
    type: 'td:field', v: WORLD_PROTOCOL, id: field.id, unit: u, padR: field.padR, level: o.level, skin: o.skin, lang: o.lang,
    routes: field.routes.map((r, i) => ({ branch: i, len: r2(r.len), w: r2(Math.max(...r.wd)), pts: r.pts, wd: r.wd, fl: r.fl })),
    pads: field.pads.map((p) => [p.x, p.z]),
    spawn: anchor(field.spawn, o.spawnTitle),
    spawn2: field.spawn2 ? anchor(field.spawn2, o.spawnTitle) : null,
    base: anchor(field.base, o.baseTitle),
    towers: pack.towers.map((t, i) => ({ id: t.id, name: t.display_name, color: t.color, cost: t.cost, range: r2((t.range / CELL) * u), model: towerModel(t, i) })),
    enemies: pack.enemies.map((e) => ({
      id: e.id, name: e.display_name, color: e.color, model: getMinionModelKind(e, o.skin),
      // 体型：按血量分三档，宿主拿去缩放模型
      scale: e.hp >= 200 ? 1.35 : e.hp >= 90 ? 1.1 : 0.9,
    })),
    palette: o.palette,
  };
}

export type FramePhase = 'lobby' | 'build' | 'wave' | 'won' | 'lost';

/** 一次性事件 [种类, 世界 x, 世界 z]：die 击破 · leak 漏到终点 · blast 炸路 · demolish 推倒建筑 · build 塔落成。宿主拿去放一次特效，不认识的种类忽略。 */
export type WorldFx = [string, number, number];

export interface FrameUi {
  phase: FramePhase;
  paused: boolean;
  /** 鼠标悬停的塔位（-1 没有） */
  hoverPad: number;
  /** 军师建议的塔位 */
  advisedPads: Iterable<number>;
  /** 正在推演（卡片上悬停的那个方案）的塔位 */
  previewPads: Iterable<number>;
  /** 射程圈 [塔位, 世界半径]；没有为 null */
  ring: [number, number] | null;
  /** 塔位上的铭牌文字 [塔位, 文字]（军师建议「A·磁暴弩塔」、悬停「磁暴弩塔 60 CP」） */
  tips: [number, string][];
  recoil: (towerIid: number) => boolean;
  flash: (enemyIid: number) => boolean;
  /** 仍在显示的弹道 [塔 iid, 敌 iid, 命中点世界 x, 命中点世界 z] */
  shots: [number, number, number, number][];
  /** 上一条 td:frame 之后发生的一次性事件 */
  fx: WorldFx[];
}

/**
 * td:frame：这一刻战场上的全部动态内容。敌人位置用「所在路线 + 世界弧长」表示，宿主沿自己手里的同一条折线取位置、高度与朝向。
 * 塔位状态串每个塔位一个字符：0 空 · 1 悬停 · 2 军师建议 · 3 推演 · 4 已占。
 */
export function encodeFrame(state: BattleState, pack: ContentPack, field: WorldField, ui: FrameUi): Record<string, unknown> {
  const cells = pack.map.buildable_cells;
  const padOf = new Map<string, number>();
  cells.forEach((c, i) => padOf.set(`${c.x},${c.y}`, i));
  const pads: string[] = new Array<string>(field.pads.length).fill('0');
  for (const i of ui.advisedPads) if (i >= 0 && i < pads.length) pads[i] = '2';
  for (const i of ui.previewPads) if (i >= 0 && i < pads.length) pads[i] = '3';
  if (ui.hoverPad >= 0 && ui.hoverPad < pads.length && pads[ui.hoverPad] === '0') pads[ui.hoverPad] = '1';

  const defIdx = new Map<string, number>();
  pack.towers.forEach((t, i) => defIdx.set(t.id, i));
  const syn = computeFormationSynergies(state.towers);
  const padByIid = new Map<number, number>();
  const towers: number[][] = [];
  for (const t of state.towers) {
    const pad = padOf.get(`${t.cx},${t.cy}`);
    if (pad === undefined) continue;
    padByIid.set(t.iid, pad);
    if (pad < pads.length) pads[pad] = '4';
    const s = syn.get(t.iid);
    towers.push([t.iid, pad, defIdx.get(t.def) ?? 0, (t.life === 'pending' ? 1 : 0) | (ui.recoil(t.iid) ? 2 : 0) | (s && s.kind !== 'none' ? 4 : 0)]);
  }
  const links: (number | string)[][] = [];
  for (const s of syn.values()) for (const l of s.links) {
    const a = padByIid.get(s.towerIid), b = padByIid.get(l.toIid);
    if (a !== undefined && b !== undefined) links.push([a, b, l.kind]);
  }

  const enemyIdx = new Map<string, number>();
  pack.enemies.forEach((e, i) => enemyIdx.set(e.id, i));
  const milli = routeMilli(pack);
  const craters = (state.craters ?? []).map((cr) => { const ri = routeIndex(field, cr.branch); return [ri, r2(arcOf(field, milli, ri, cr.progress))]; });
  const enemies: number[][] = [];
  for (const e of state.enemies) {
    if (e.life !== 'alive' && e.life !== 'dying') continue;
    const di = enemyIdx.get(e.def) ?? 0, def = pack.enemies[di];
    const ri = routeIndex(field, e.branch);
    const slowed = (state.craters ?? []).some((cr) => routeIndex(field, cr.branch) === ri && Math.abs(e.progress - cr.progress) <= 1500);
    enemies.push([e.iid, di, ri, r2(arcOf(field, milli, ri, e.progress)), r3(Math.max(0, Math.min(1, e.hp / Math.max(1, def?.hp ?? 1)))), (ui.flash(e.iid) ? 1 : 0) | (slowed ? 2 : 0) | (e.life === 'dying' ? 4 : 0)]);
  }
  return {
    type: 'td:frame', v: WORLD_PROTOCOL, field: field.id, tick: state.tick, phase: ui.phase, paused: ui.paused,
    pads: pads.join(''), towers, enemies,
    shots: ui.shots.map((s) => [s[0], s[1], r2(s[2]), r2(s[3])]),
    ring: ui.ring ? [ui.ring[0], r2(ui.ring[1])] : null,
    links, craters, tips: ui.tips,
    fx: ui.fx.map((e) => [e[0], r2(e[1]), r2(e[2])]),
    demolished: (state.demolished ?? []).map((d) => d.key),
    base: [state.base_hp, pack.map.base_hp],
    wave: [state.wave_index, pack.waves.length],
  };
}

// 空间皮肤地图原位投影与透明图层渲染（任务 94bbcebe）。
// 将塔防的确定性逻辑格坐标 (cx, cy) / 毫格坐标 (mx, my) 实时正逆投影到宿主 #hub-view 空间皮肤地图（KMSpatial 正交相机）的场景地面坐标上，
// 去掉独立浮层灰盒棋盘背景，直接在空间皮肤地图上绘制行军路线、沿途建塔点位、2.5D 塔台、敌军与军师落点建议。
import { CELL } from '../runtime/sim';
import type { BattleState, Cell, ContentPack } from '../runtime/types';
import { reachTable, slotCell } from '../advisor/snapshot';
import type { AdvisorView } from '../advisor/session';
import type { Palette } from './palettes';

export interface HostSpatialNode {
  key: string;
  kind: 'landmark' | 'entity';
  label: string;
  group?: string | null;
  color?: string | null;
  x: number;
  y: number;
  wx?: number;
  wz?: number;
}

export interface HostSpatialMap {
  skin: string | null;
  layout: string | null;
  w: number;
  h: number;
  azimuth: number;
  pitch: number;
  zoom: number;
  focus?: [number, number, number];
  worldWidth?: number;
  worldDepth?: number;
  center: { x: number; y: number };
  home: HostSpatialNode | null;
  landmarks: HostSpatialNode[];
  nodes: HostSpatialNode[];
}

export interface TacticalSlot {
  slot: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  adjacentToPath: boolean;
  reach: number;
}

export interface SpatialProjector {
  readonly width: number;
  readonly height: number;
  readonly viewportW: number;
  readonly viewportH: number;
  readonly azimuth: number;
  readonly pitch: number;
  readonly zoom: number;
  readonly origin: { x: number; y: number };
  readonly cellPx: number;
  readonly tacticalSlots: TacticalSlot[];
  readonly hostMap: HostSpatialMap | null;
  /** 逻辑连续格坐标 (gx, gy)（格中心为 cx+0.5, cy+0.5）→ 空间地图画布像素坐标 (x, y) */
  cellToScreen(gx: number, gy: number): { x: number; y: number };
  /** 毫格坐标 (mx, my) → 空间地图画布像素坐标 (x, y) */
  milliToScreen(mx: number, my: number): { x: number; y: number };
  /** 单个逻辑格 (cx, cy) 在空间地图地面上的四个等轴测顶点 */
  cellCorners(cx: number, cy: number, inset?: number): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  /** 空间地图画布像素坐标 (sx, sy) → 逻辑格坐标 (cx, cy) 与槽位下标 slot（优先吸附半径内的建塔点位） */
  screenToCell(sx: number, sy: number): { cx: number; cy: number; gx: number; gy: number; inBounds: boolean; slot: number };
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function parseNode(raw: unknown): HostSpatialNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || typeof r.x !== 'number' || typeof r.y !== 'number') return null;
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) return null;
  return {
    key: r.key.slice(0, 128),
    kind: r.kind === 'landmark' ? 'landmark' : 'entity',
    label: typeof r.label === 'string' ? r.label.slice(0, 64) : r.key.slice(0, 32),
    group: typeof r.group === 'string' ? r.group.slice(0, 64) : null,
    color: typeof r.color === 'string' ? r.color.slice(0, 32) : null,
    x: Math.round(r.x),
    y: Math.round(r.y),
    wx: typeof r.wx === 'number' && Number.isFinite(r.wx) ? r.wx : 0,
    wz: typeof r.wz === 'number' && Number.isFinite(r.wz) ? r.wz : 0,
  };
}

export function parseSpatialMap(raw: unknown, prev: HostSpatialMap | null = null): HostSpatialMap | null {
  if (raw === undefined) return prev;
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const w = num(m.w, prev?.w ?? 960, 200, 4096);
  const h = num(m.h, prev?.h ?? 640, 200, 4096);
  const home = parseNode(m.home);
  const landmarks = Array.isArray(m.landmarks) ? m.landmarks.map(parseNode).filter((x): x is HostSpatialNode => x !== null).slice(0, 16) : (prev?.landmarks ?? []);
  const nodes = Array.isArray(m.nodes) ? m.nodes.map(parseNode).filter((x): x is HostSpatialNode => x !== null).slice(0, 48) : (prev?.nodes ?? []);
  const cRaw = m.center && typeof m.center === 'object' ? (m.center as Record<string, unknown>) : null;
  const center = {
    x: num(cRaw?.x, home?.x ?? Math.round(w * 0.52), 0, w),
    y: num(cRaw?.y, home?.y ?? Math.round(h * 0.48), 0, h),
  };
  return {
    skin: typeof m.skin === 'string' ? m.skin : (prev?.skin ?? null),
    layout: typeof m.layout === 'string' ? m.layout : (prev?.layout ?? null),
    w,
    h,
    azimuth: num(m.azimuth, prev?.azimuth ?? -0.38, -Math.PI * 2, Math.PI * 2),
    pitch: num(m.pitch, prev?.pitch ?? 0.78, 0.35, 1.45),
    zoom: num(m.zoom, prev?.zoom ?? 1, 0.35, 12),
    focus: Array.isArray(m.focus) && m.focus.length === 3 ? [num(m.focus[0], 0, -2000, 2000), num(m.focus[1], 0, -2000, 2000), num(m.focus[2], 0, -2000, 2000)] : prev?.focus,
    worldWidth: num(m.worldWidth, prev?.worldWidth ?? 120, 20, 2000),
    worldDepth: num(m.worldDepth, prev?.worldDepth ?? 90, 20, 2000),
    center,
    home,
    landmarks,
    nodes,
  };
}

function expandPathSet(path: Cell[]): Set<string> {
  const out = new Set<string>();
  if (!path.length) return out;
  out.add(`${path[0].x},${path[0].y}`);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
    let x = a.x, y = a.y;
    while (x !== b.x || y !== b.y) {
      x += dx;
      y += dy;
      out.add(`${x},${y}`);
    }
  }
  return out;
}

export function createSpatialProjector(
  pack: ContentPack,
  viewportW: number,
  viewportH: number,
  hostMap: HostSpatialMap | null = null,
): SpatialProjector {
  const W = pack.map.width;
  const H = pack.map.height;
  const vw = Math.max(320, viewportW);
  const vh = Math.max(240, viewportH);
  const azimuth = hostMap ? hostMap.azimuth : -0.38;
  const pitch = hostMap ? Math.max(0.48, Math.min(1.32, hostMap.pitch)) : 0.78;
  const zoom = hostMap ? Math.max(0.55, Math.min(3.2, hostMap.zoom)) : 1;

  const cosA = Math.cos(azimuth);
  const sinA = Math.sin(azimuth);
  const sinP = Math.sin(pitch);

  // 计算旋转与俯仰后的战场包络，留出顶部 HUD、左侧军师卡与底部 dock 的安全边距
  const spanX = Math.max(4, W * Math.abs(cosA) + H * Math.abs(sinA));
  const spanY = Math.max(3, (W * Math.abs(sinA) + H * Math.abs(cosA)) * sinP);
  const safeW = Math.max(240, vw * 0.68);
  const safeH = Math.max(180, vh * 0.62);
  const baseCell = Math.min(safeW / spanX, safeH / spanY);
  const cellPx = Math.max(24, Math.min(84, baseCell * Math.pow(zoom, 0.45)));

  // 战场中心锚定在宿主空间地图的中心 / 母星地标附近，并夹在安全视口内以免被顶栏或底栏遮挡
  const defaultOriginX = Math.round(vw * 0.53);
  const defaultOriginY = Math.round(vh * 0.47);
  const rawX = hostMap?.center ? hostMap.center.x * (vw / Math.max(1, hostMap.w)) : defaultOriginX;
  const rawY = hostMap?.center ? hostMap.center.y * (vh / Math.max(1, hostMap.h)) : defaultOriginY;
  const origin = {
    x: Math.round(Math.max(vw * 0.34, Math.min(vw * 0.68, rawX * 0.55 + defaultOriginX * 0.45))),
    y: Math.round(Math.max(vh * 0.34, Math.min(vh * 0.62, rawY * 0.55 + defaultOriginY * 0.45))),
  };

  const cellToScreen = (gx: number, gy: number): { x: number; y: number } => {
    const u = (gx - W / 2) * cellPx;
    const v = (gy - H / 2) * cellPx;
    return {
      x: origin.x + u * cosA - v * sinA,
      y: origin.y + (u * sinA + v * cosA) * sinP,
    };
  };

  const milliToScreen = (mx: number, my: number): { x: number; y: number } =>
    cellToScreen(mx / CELL, my / CELL);

  const cellCorners = (cx: number, cy: number, inset = 0): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] => [
    cellToScreen(cx + inset, cy + inset),
    cellToScreen(cx + 1 - inset, cy + inset),
    cellToScreen(cx + 1 - inset, cy + 1 - inset),
    cellToScreen(cx + inset, cy + 1 - inset),
  ];

  const pathSet = expandPathSet(pack.map.path);
  const reaches = reachTable(pack);
  const slotByKey = new Map<string, number>();
  const tacticalSlots: TacticalSlot[] = [];

  pack.map.buildable_cells.forEach((c, idx) => {
    slotByKey.set(`${c.x},${c.y}`, idx);
    let adjacentToPath = false;
    for (let dy = -1; dy <= 1 && !adjacentToPath; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (pathSet.has(`${c.x + dx},${c.y + dy}`)) {
          adjacentToPath = true;
          break;
        }
      }
    }
    const row = reaches[idx] || {};
    const reach = Math.max(0, ...Object.values(row));
    const pt = cellToScreen(c.x + 0.5, c.y + 0.5);
    if (adjacentToPath || reach > 0) {
      tacticalSlots.push({
        slot: idx,
        x: c.x,
        y: c.y,
        sx: Math.round(pt.x * 10) / 10,
        sy: Math.round(pt.y * 10) / 10,
        adjacentToPath,
        reach,
      });
    }
  });
  tacticalSlots.sort((a, b) => Number(b.adjacentToPath) - Number(a.adjacentToPath) || b.reach - a.reach || a.slot - b.slot);

  const screenToCell = (sx: number, sy: number) => {
    const dx = sx - origin.x;
    const dy = (sy - origin.y) / sinP;
    const u = dx * cosA + dy * sinA;
    const v = -dx * sinA + dy * cosA;
    const gx = u / cellPx + W / 2;
    const gy = v / cellPx + H / 2;
    let cx = Math.floor(gx);
    let cy = Math.floor(gy);
    let slot = slotByKey.get(`${cx},${cy}`) ?? -1;

    // 若点击位置靠近沿途建塔点位基座中心，优先吸附到该槽位（提升等轴测点位点击手感）
    if (slot < 0) {
      const snapRadius = cellPx * 0.58;
      let bestDist = snapRadius * snapRadius;
      for (const ts of tacticalSlots) {
        const d2 = (sx - ts.sx) * (sx - ts.sx) + (sy - ts.sy) * (sy - ts.sy);
        if (d2 <= bestDist) {
          bestDist = d2;
          cx = ts.x;
          cy = ts.y;
          slot = ts.slot;
        }
      }
    }

    const inBounds = cx >= 0 && cx < W && cy >= 0 && cy < H;
    return { cx, cy, gx, gy, inBounds, slot };
  };

  return {
    width: W,
    height: H,
    viewportW: vw,
    viewportH: vh,
    azimuth,
    pitch,
    zoom,
    origin,
    cellPx,
    tacticalSlots,
    hostMap,
    cellToScreen,
    milliToScreen,
    cellCorners,
    screenToCell,
  };
}

function rgba(hex: string | undefined, alpha: number, fallback = '100,140,160'): string {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return `rgba(${fallback},${alpha})`;
  const s = hex.slice(1);
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function tracePoly(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

export interface SpatialDrawOptions {
  pathCells: Set<string>;
  cardView: AdvisorView;
  selectedTowerId: string;
  hoverCell: { cx: number; cy: number; slot: number } | null;
  shots: { fx: number; fy: number; tx: number; ty: number; until: number }[];
  particles: { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; color: string }[];
  now: number;
  inLobby: boolean;
  lang: 'zh' | 'en';
  heldText: string;
  fellText: string;
}

export function drawSpatialBattlefield(
  ctx: CanvasRenderingContext2D,
  state: BattleState,
  pack: ContentPack,
  theme: Palette,
  proj: SpatialProjector,
  opts: SpatialDrawOptions,
) {
  const { width, height } = ctx.canvas;
  // 1. 透明画布清屏：不画整块灰盒棋盘背景，直接透出底下 #hub-view 的 3D 空间皮肤地图
  ctx.clearRect(0, 0, width, height);

  const accent = theme.accent ?? theme.base ?? '#356d73';
  const ink = theme.ink ?? theme.text ?? '#263443';
  const paper = theme.paper ?? '#f3f5eb';
  const danger = theme.danger ?? '#c03221';
  const okColor = theme.ok ?? '#338a72';

  // 2. 空间皮肤地图场景节点锚定引线（将宿主 3D 场景中的母星与站点地标同防线相连）
  if (proj.hostMap) {
    const scaleX = width / Math.max(1, proj.hostMap.w);
    const scaleY = height / Math.max(1, proj.hostMap.h);
    const endCell = pack.map.path[pack.map.path.length - 1];
    const basePt = proj.cellToScreen(endCell.x + 0.5, endCell.y + 0.5);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = rgba(accent, 0.35);
    for (const lm of proj.hostMap.landmarks.slice(0, 4)) {
      const lx = lm.x * scaleX;
      const ly = lm.y * scaleY;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(basePt.x, basePt.y);
      ctx.stroke();
      ctx.fillStyle = rgba(accent, 0.22);
      ctx.beginPath();
      ctx.arc(lx, ly, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // 3. 战区等轴测轻边界框（只勾勒防区地界，不遮挡 3D 城市建筑与道路）
  ctx.save();
  const boundary = [
    proj.cellToScreen(0, 0),
    proj.cellToScreen(pack.map.width, 0),
    proj.cellToScreen(pack.map.width, pack.map.height),
    proj.cellToScreen(0, pack.map.height),
  ];
  tracePoly(ctx, boundary);
  ctx.strokeStyle = rgba(accent, 0.26);
  ctx.lineWidth = 1.25;
  ctx.setLineDash([6, 5]);
  ctx.stroke();
  ctx.restore();

  // 4. 行军路线（等轴测半透明路基 + 发光航线折线 + 动态行军箭头 + 出兵口/母星基地标识）
  ctx.save();
  for (const key of opts.pathCells) {
    const [xs, ys] = key.split(',');
    const cx = Number(xs), cy = Number(ys);
    const corners = proj.cellCorners(cx, cy, 0.04);
    tracePoly(ctx, corners);
    ctx.fillStyle = rgba(theme.path, 0.42, '113,126,125');
    ctx.fill();
    ctx.strokeStyle = rgba(accent, 0.34);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const waypoints = pack.map.path.map((c) => proj.cellToScreen(c.x + 0.5, c.y + 0.5));
  if (waypoints.length >= 2) {
    // 路线外发光与主干线
    ctx.beginPath();
    ctx.moveTo(waypoints[0].x, waypoints[0].y);
    for (let i = 1; i < waypoints.length; i++) ctx.lineTo(waypoints[i].x, waypoints[i].y);
    ctx.strokeStyle = rgba(danger, 0.25, '192,50,33');
    ctx.lineWidth = Math.max(6, proj.cellPx * 0.22);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(waypoints[0].x, waypoints[0].y);
    for (let i = 1; i < waypoints.length; i++) ctx.lineTo(waypoints[i].x, waypoints[i].y);
    ctx.strokeStyle = rgba(accent, 0.82);
    ctx.lineWidth = 2.4;
    ctx.setLineDash([10, 6]);
    ctx.lineDashOffset = -((opts.now * 0.03) % 16);
    ctx.stroke();
    ctx.setLineDash([]);

    // 沿途方向箭头
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1], b = waypoints[i];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const sz = Math.max(5, proj.cellPx * 0.14);
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(-sz, -sz * 0.7);
      ctx.lineTo(sz * 0.5, 0);
      ctx.lineTo(-sz, sz * 0.7);
      ctx.strokeStyle = rgba(paper, 0.9, '255,255,255');
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    // 出兵口（起点）与母星基地（终点）
    const startPt = waypoints[0];
    ctx.fillStyle = rgba(danger, 0.88, '192,50,33');
    ctx.beginPath();
    ctx.arc(startPt.x, startPt.y, Math.max(7, proj.cellPx * 0.18), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = paper;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.lang === 'zh' ? '出兵口' : 'Spawn', startPt.x, startPt.y - Math.max(11, proj.cellPx * 0.25));

    const endCell = pack.map.path[pack.map.path.length - 1];
    const endCorners = proj.cellCorners(endCell.x, endCell.y, 0.08);
    tracePoly(ctx, endCorners);
    ctx.fillStyle = rgba(accent, 0.85);
    ctx.fill();
    ctx.strokeStyle = paper;
    ctx.lineWidth = 2;
    ctx.stroke();
    const endPt = waypoints[waypoints.length - 1];
    ctx.fillStyle = paper;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.lang === 'zh' ? '母星基地' : 'Base', endPt.x, endPt.y + 4);
  }
  ctx.restore();

  // 5. 建塔点位（直接在空间皮肤地图坐标上绘制沿途等轴测建塔基座与槽位号）
  const occupiedSet = new Set(state.occupied);
  const primarySlots = proj.tacticalSlots.filter((ts) => ts.adjacentToPath).slice(0, 28);
  const primarySet = new Set(primarySlots.map((ts) => ts.slot));

  ctx.save();
  for (const ts of primarySlots) {
    const key = `${ts.x},${ts.y}`;
    if (occupiedSet.has(key)) continue;
    const isHovered = opts.hoverCell && opts.hoverCell.cx === ts.x && opts.hoverCell.cy === ts.y;
    const corners = proj.cellCorners(ts.x, ts.y, 0.16);
    tracePoly(ctx, corners);
    ctx.fillStyle = isHovered ? rgba(accent, 0.36) : rgba(paper, 0.22, '240,244,240');
    ctx.fill();
    ctx.strokeStyle = isHovered ? accent : rgba(accent, 0.58);
    ctx.lineWidth = isHovered ? 2.2 : 1.3;
    ctx.stroke();

    // 基座中心十字/圆环与槽位编号
    ctx.fillStyle = isHovered ? accent : rgba(ink, 0.78);
    ctx.font = `${isHovered ? 'bold ' : ''}10px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`#${ts.slot}`, ts.sx, ts.sy + 3.5);
  }

  // 若鼠标悬停在非主推但合法的可建格上，同样高亮其等轴测建塔基座与射程椭圆
  if (opts.hoverCell) {
    const { cx, cy, slot } = opts.hoverCell;
    if (slot >= 0 && !occupiedSet.has(`${cx},${cy}`)) {
      if (!primarySet.has(slot)) {
        const corners = proj.cellCorners(cx, cy, 0.14);
        tracePoly(ctx, corners);
        ctx.fillStyle = rgba(accent, 0.34);
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      const towerDef = pack.towers.find((t) => t.id === opts.selectedTowerId) ?? pack.towers[0];
      if (towerDef) {
        const center = proj.cellToScreen(cx + 0.5, cy + 0.5);
        const rx = (towerDef.range / CELL) * proj.cellPx;
        const ry = rx * Math.sin(proj.pitch);
        ctx.beginPath();
        ctx.ellipse(center.x, center.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = rgba(accent, 0.10);
        ctx.fill();
        ctx.strokeStyle = rgba(accent, 0.55);
        ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  ctx.restore();

  // 6. 军师建议落点叠层（a/b/c 选项直接标在空间地图对应建塔点位上）
  if (opts.cardView.current && (state.phase === 'build' || state.phase === 'wave')) {
    const cur = opts.cardView.current;
    ctx.save();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    const seen = new Map<string, number>();
    for (const o of cur.advice.options) {
      for (const m of o.moves) {
        const c = slotCell(pack, m.slot);
        if (!c) continue;
        const k = `${c.x},${c.y}`;
        const count = seen.get(k) ?? 0;
        seen.set(k, count + 1);
        const corners = proj.cellCorners(c.x, c.y, 0.10);
        ctx.globalAlpha = cur.adopted.includes(o.id) ? 0.4 : 0.95;
        ctx.setLineDash(o.id === 'a' ? [] : [4, 3]);
        tracePoly(ctx, corners);
        ctx.stroke();
        const pt = proj.cellToScreen(c.x + 0.5, c.y + 0.5);
        ctx.setLineDash([]);
        ctx.fillText(`${o.id}(#${m.slot})`, pt.x + count * 14, pt.y - proj.cellPx * 0.24);
      }
    }
    ctx.restore();
  }

  // 7. 已建防御塔（2.5D 等轴测塔座 + 炮台）
  for (const tw of state.towers) {
    const def = pack.towers.find((d) => d.id === tw.def)!;
    const corners = proj.cellCorners(tw.cx, tw.cy, 0.14);
    const center = proj.cellToScreen(tw.cx + 0.5, tw.cy + 0.5);
    const towerColor = def.color ?? accent;
    ctx.save();
    ctx.globalAlpha = tw.life === 'pending' ? 0.55 : 1;
    tracePoly(ctx, corners);
    ctx.fillStyle = theme.tower ?? paper;
    ctx.fill();
    ctx.strokeStyle = towerColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 2.5D 塔身立柱
    const lift = Math.max(8, proj.cellPx * 0.24);
    ctx.fillStyle = towerColor;
    ctx.beginPath();
    ctx.arc(center.x, center.y - lift * 0.45, Math.max(8, proj.cellPx * 0.22), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = paper;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.fillStyle = paper;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(def.display_name[0], center.x, center.y - lift * 0.45 + 4);
    ctx.restore();
  }

  // 8. 行军中的敌军与血条（按毫格坐标实时投影到空间地图路线上）
  for (const e of state.enemies) {
    const def = pack.enemies.find((d) => d.id === e.def)!;
    const pt = proj.milliToScreen(e.x, e.y);
    const r = Math.max(6, proj.cellPx * 0.18);
    ctx.save();
    ctx.fillStyle = danger;
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y - r * 1.25);
    ctx.lineTo(pt.x + r, pt.y);
    ctx.lineTo(pt.x, pt.y + r * 0.85);
    ctx.lineTo(pt.x - r, pt.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = paper;
    ctx.lineWidth = 1.3;
    ctx.stroke();

    // 血条
    const bw = 26, bh = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(pt.x - bw / 2, pt.y - r * 1.25 - 9, bw, bh);
    ctx.fillStyle = okColor;
    ctx.fillRect(pt.x - bw / 2, pt.y - r * 1.25 - 9, bw * Math.max(0, e.hp) / def.hp, bh);
    ctx.restore();
  }

  // 9. 粒子与攻击弹道
  ctx.save();
  for (const p of opts.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = theme.shot ?? accent;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = opts.shots.length - 1; i >= 0; i--) {
    const sh = opts.shots[i];
    if (opts.now > sh.until) {
      opts.shots.splice(i, 1);
      continue;
    }
    const f = proj.milliToScreen(sh.fx, sh.fy);
    const t = proj.milliToScreen(sh.tx, sh.ty);
    ctx.globalAlpha = Math.max(0, (sh.until - opts.now) / 90);
    ctx.beginPath();
    ctx.moveTo(f.x, f.y - 6);
    ctx.lineTo(t.x, t.y - 4);
    ctx.stroke();
  }
  ctx.restore();

  // 10. 胜负结算横幅
  if (state.phase === 'won' || state.phase === 'lost') {
    ctx.save();
    ctx.fillStyle = 'rgba(12, 18, 26, 0.52)';
    ctx.fillRect(0, height / 2 - 48, width, 96);
    ctx.fillStyle = paper;
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(state.phase === 'won' ? opts.heldText : opts.fellText, width / 2, height / 2 + 12);
    ctx.restore();
  }
}

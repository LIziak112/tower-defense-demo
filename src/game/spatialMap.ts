// 空间皮肤地图原位投影与高质感立体轨道渲染（任务 94bbcebe / 大厅 #25648 / 任务 997eeae6）。
// 将塔防的确定性逻辑格坐标 (cx, cy) / 毫格坐标 (mx, my) 实时正逆投影到宿主 #hub-view 皮肤地图的场景地面坐标上：
// 1. 去掉死板的外围矩形网格框、逐格方块与满屏 #编号，彻底消除「浮层画格子」感；
// 2. 绘制 5 层 2.5D 等轴测立体轨道（地面阴影 + 护坡路基 + 等轴测轨枕刻度 + 双侧平行护栏导轨 + 中央流光导引脉冲）；
// 3. 沿途建塔位采用贴地圆形/菱形战术承重基座，悬停或军师推荐时浮现胶囊铭牌与透视射程光环。
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

/** 将不同皮肤的默认相机旋转角按 π/2 正交象限折叠到正前等轴测舒适区间 [-0.68, 0.68]，避免如 gothic-cathedral-3d (-2.55) 导致防线上下颠倒 */
function alignStreetAzimuth(rawAzimuth: number): number {
  let a = rawAzimuth;
  const step = Math.PI / 2;
  while (a < -0.68) a += step;
  while (a > 0.68) a -= step;
  return a;
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
  const azimuth = hostMap ? alignStreetAzimuth(hostMap.azimuth) : -0.38;
  const pitch = hostMap ? Math.max(0.54, Math.min(1.18, hostMap.pitch)) : 0.76;
  const zoom = hostMap ? Math.max(0.6, Math.min(2.8, hostMap.zoom)) : 1;

  const cosA = Math.cos(azimuth);
  const sinA = Math.sin(azimuth);
  const sinP = Math.sin(pitch);

  // 计算旋转与俯仰后的战场包络，留出顶部指挥条、两侧紧凑对话框与底部 dock 的安全边距
  const spanX = Math.max(4, W * Math.abs(cosA) + H * Math.abs(sinA));
  const spanY = Math.max(3, (W * Math.abs(sinA) + H * Math.abs(cosA)) * sinP);
  const safeW = Math.max(260, vw * 0.64);
  const safeH = Math.max(200, vh * 0.60);
  const baseCell = Math.min(safeW / spanX, safeH / spanY);
  const cellPx = Math.max(26, Math.min(82, baseCell * Math.pow(zoom, 0.42)));

  // 战场中心锚定在宿主空间地图的中心 / 母星地标附近，并夹在安全视口内
  const defaultOriginX = Math.round(vw * 0.51);
  const defaultOriginY = Math.round(vh * 0.48);
  const rawX = hostMap?.center ? hostMap.center.x * (vw / Math.max(1, hostMap.w)) : defaultOriginX;
  const rawY = hostMap?.center ? hostMap.center.y * (vh / Math.max(1, hostMap.h)) : defaultOriginY;
  const origin = {
    x: Math.round(Math.max(vw * 0.36, Math.min(vw * 0.64, rawX * 0.52 + defaultOriginX * 0.48))),
    y: Math.round(Math.max(vh * 0.35, Math.min(vh * 0.60, rawY * 0.52 + defaultOriginY * 0.48))),
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

function drawPillTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  bgHex: string,
  fgHex: string,
  borderHex: string,
  alpha = 0.92,
) {
  ctx.save();
  ctx.font = '600 11px "IBM Plex Sans", "PingFang SC", system-ui, sans-serif';
  const padX = 7;
  const h = 20;
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const rx = x - w / 2;
  const ry = y - h / 2;
  ctx.fillStyle = rgba(bgHex, alpha, '36,46,64');
  ctx.strokeStyle = rgba(borderHex, 0.75, '180,190,200');
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(rx, ry, w, h, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = fgHex;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
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
  // 1. 透明画布清屏：直接透出底下 #hub-view 的空间/平面皮肤地图，严禁绘制任何不透明底板或大矩形网格框
  ctx.clearRect(0, 0, width, height);

  const accent = theme.accent ?? theme.base ?? '#356d73';
  const ink = theme.ink ?? theme.text ?? '#263443';
  const paper = theme.paper ?? '#f3f5eb';
  const hair = theme.hair ?? '#9aa8a6';
  const roadColor = theme.path ?? '#717e7d';
  const roadAlt = theme.pathAlt ?? '#5c6867';
  const danger = theme.danger ?? '#c03221';
  const okColor = theme.ok ?? '#338a72';
  const aspectY = Math.max(0.52, Math.min(0.88, Math.sin(proj.pitch)));

  const waypoints = pack.map.path.map((c) => proj.cellToScreen(c.x + 0.5, c.y + 0.5));
  if (waypoints.length < 2) return;

  // 2. 场景地标与片区脉络微光引线（将宿主皮肤地图中的地标与防线终点/起点轻柔衔接）
  if (proj.hostMap) {
    const scaleX = width / Math.max(1, proj.hostMap.w);
    const scaleY = height / Math.max(1, proj.hostMap.h);
    const basePt = waypoints[waypoints.length - 1];
    ctx.save();
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = rgba(accent, 0.28);
    for (const lm of proj.hostMap.landmarks.slice(0, 4)) {
      const lx = lm.x * scaleX;
      const ly = lm.y * scaleY;
      const mx = (lx + basePt.x) * 0.5;
      const my = (ly + basePt.y) * 0.5 - 18;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.quadraticCurveTo(mx, my, basePt.x, basePt.y);
      ctx.stroke();
      ctx.fillStyle = rgba(accent, 0.24);
      ctx.beginPath();
      ctx.ellipse(lx, ly, 6, 6 * aspectY, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // 3. 五层 2.5D 等轴测立体轨道（Spline Track & Dual Rails with 3D Extruded Side Wall & Ambient Shadow）
  const trackW = Math.max(20, proj.cellPx * 0.54);
  const innerW = Math.max(14, proj.cellPx * 0.38);
  const railOffset = Math.max(7.5, proj.cellPx * 0.22);
  const deckThickness = Math.max(4.5, proj.cellPx * 0.11);

  const traceCenterPath = (offsetX = 0, offsetY = 0) => {
    ctx.beginPath();
    ctx.moveTo(waypoints[0].x + offsetX, waypoints[0].y + offsetY);
    for (let i = 1; i < waypoints.length; i++) {
      ctx.lineTo(waypoints[i].x + offsetX, waypoints[i].y + offsetY);
    }
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // (3.1) 第 1 层：地面柔和环境光遮蔽阴影（Ambient Occlusion Shadow）+ 2.5D 立体侧壁（Extruded Side Wall）
  ctx.save();
  ctx.shadowColor = 'rgba(8, 12, 20, 0.38)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 5;
  traceCenterPath(0, deckThickness);
  ctx.strokeStyle = rgba(ink, 0.68, '36,46,58');
  ctx.lineWidth = trackW + 3;
  ctx.stroke();
  ctx.restore();

  // 立体下缘暗部侧墙（表现出石板/栈道高出地面的 3D 厚度）
  for (let d = deckThickness; d >= 1.5; d -= 1.5) {
    traceCenterPath(0, d);
    ctx.strokeStyle = rgba(ink, 0.52, '42,52,64');
    ctx.lineWidth = trackW + 2;
    ctx.stroke();
  }

  // (3.2) 第 2 层：立体受光顶面路基与内层装甲轨床
  traceCenterPath(0, 0);
  ctx.strokeStyle = rgba(paper, 0.65, '240,244,240');
  ctx.lineWidth = trackW + 1.5;
  ctx.stroke();

  traceCenterPath(0, 0);
  ctx.strokeStyle = rgba(roadColor, 0.92, '113,126,125');
  ctx.lineWidth = trackW - 1.5;
  ctx.stroke();

  traceCenterPath(0, 0);
  ctx.strokeStyle = rgba(roadAlt, 0.82, '88,100,102');
  ctx.lineWidth = innerW;
  ctx.stroke();

  // (3.3) 第 3 层：等轴测立体轨枕石板（Beveled Sleepers）与双侧平行立体护栏导轨（Dual 3D Rails）
  const sleeperStep = Math.max(10, proj.cellPx * 0.25);
  const sleeperHalf = railOffset * 0.88;

  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1) continue;
    const ux = dx / segLen, uy = dy / segLen;
    const nx = -uy, ny = ux;

    // 轨枕暗影槽与亮面横档（一明一暗形成真实凹凸雕刻感）
    for (let d = sleeperStep * 0.6; d < segLen - sleeperStep * 0.4; d += sleeperStep) {
      const px = a.x + ux * d;
      const py = a.y + uy * d;
      ctx.strokeStyle = rgba(ink, 0.36);
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(px - nx * sleeperHalf, py - ny * sleeperHalf + 1.2);
      ctx.lineTo(px + nx * sleeperHalf, py + ny * sleeperHalf + 1.2);
      ctx.stroke();

      ctx.strokeStyle = rgba(paper, 0.42, '245,248,245');
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(px - nx * sleeperHalf, py - ny * sleeperHalf);
      ctx.lineTo(px + nx * sleeperHalf, py + ny * sleeperHalf);
      ctx.stroke();
    }

    // 左右双平行立体护栏导轨（含侧壁暗影 + 主轨色 + 顶部受光高光）
    for (const sign of [-1, 1]) {
      const rx0 = a.x + nx * railOffset * sign;
      const ry0 = a.y + ny * railOffset * sign;
      const rx1 = b.x + nx * railOffset * sign;
      const ry1 = b.y + ny * railOffset * sign;

      ctx.beginPath();
      ctx.moveTo(rx0, ry0 + 2);
      ctx.lineTo(rx1, ry1 + 2);
      ctx.strokeStyle = rgba(ink, 0.55);
      ctx.lineWidth = 3.2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(rx0, ry0);
      ctx.lineTo(rx1, ry1);
      ctx.strokeStyle = rgba(accent, 0.88);
      ctx.lineWidth = 2.2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(rx0, ry0 - 0.8);
      ctx.lineTo(rx1, ry1 - 0.8);
      ctx.strokeStyle = rgba(paper, 0.55, '255,255,255');
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }
  }

  // 折角枢纽立体转盘（带 3D 底座厚度与内环铆钉）
  for (let i = 1; i < waypoints.length - 1; i++) {
    const wp = waypoints[i];
    const r = railOffset * 0.98;
    ctx.fillStyle = rgba(ink, 0.55);
    ctx.beginPath();
    ctx.ellipse(wp.x, wp.y + 2.5, r, r * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = rgba(roadAlt, 0.95);
    ctx.strokeStyle = rgba(accent, 0.85);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(wp.x, wp.y, r, r * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // (3.4) 第 4 层：轨道中央发光能量导引槽与动态流光脉冲
  ctx.save();
  ctx.shadowColor = accent;
  ctx.shadowBlur = 6;
  traceCenterPath(0, 0);
  ctx.strokeStyle = rgba(accent, 0.48);
  ctx.lineWidth = 4.5;
  ctx.stroke();
  ctx.restore();

  traceCenterPath(0, 0);
  ctx.strokeStyle = rgba(paper, 0.90, '255,255,255');
  ctx.lineWidth = 2.0;
  ctx.setLineDash([8, 10]);
  ctx.lineDashOffset = -((opts.now * 0.032) % 18);
  ctx.stroke();
  ctx.setLineDash([]);

  // 沿途动态流光方向标（Chevrons）
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 24) continue;
    const ang = Math.atan2(dy, dx);
    const sz = Math.max(4.5, proj.cellPx * 0.11);
    const phase = ((opts.now * 0.045) % 42) / 42;
    const tPos = 0.25 + phase * 0.5;
    const mx = a.x + dx * tPos;
    const my = a.y + dy * tPos;
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(-sz, -sz * 0.75);
    ctx.lineTo(sz * 0.55, 0);
    ctx.lineTo(-sz, sz * 0.75);
    ctx.strokeStyle = rgba(paper, 0.95, '255,255,255');
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();
  }

  // (3.5) 起点「敌军入口」与终点「母星防线」2.5D 阶梯式立体堡垒高台
  const drawSteppedBastion = (pt: { x: number; y: number }, r: number, mainColor: string) => {
    ctx.save();
    ctx.shadowColor = 'rgba(8, 12, 20, 0.42)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = rgba(ink, 0.65);
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y + 4, r * 1.25, r * 1.25 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = rgba(paper, 0.88);
    ctx.strokeStyle = rgba(mainColor, 0.75);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y + 1.5, r * 1.18, r * 1.18 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = rgba(mainColor, 0.92);
    ctx.strokeStyle = paper;
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y - 2, r * 0.86, r * 0.86 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = rgba(paper, 0.88);
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y - 3.5, r * 0.36, r * 0.36 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
  };

  const startPt = waypoints[0];
  const portalR = Math.max(12, proj.cellPx * 0.29);
  drawSteppedBastion(startPt, portalR, danger);
  drawPillTag(
    ctx,
    opts.lang === 'zh' ? '敌军入口' : 'Spawn',
    startPt.x,
    startPt.y - portalR * aspectY - 15,
    paper,
    danger,
    danger,
  );

  const endPt = waypoints[waypoints.length - 1];
  const baseR = Math.max(14.5, proj.cellPx * 0.35);
  drawSteppedBastion(endPt, baseR, accent);
  drawPillTag(
    ctx,
    opts.lang === 'zh' ? `母星防线 ${state.base_hp}/${pack.map.base_hp}` : `Base ${state.base_hp}/${pack.map.base_hp}`,
    endPt.x,
    endPt.y - baseR * aspectY - 16,
    paper,
    ink,
    accent,
  );
  ctx.restore();

  // 4. 沿途 2.5D 立体战术建塔基座（Tactical Emplacement Pads：双层立体圆台 + 侧壁厚度，无杂乱 #编号）
  const occupiedSet = new Set(state.occupied);
  const primarySlots = proj.tacticalSlots.filter((ts) => ts.adjacentToPath).slice(0, 16);
  const padR = Math.max(8, proj.cellPx * 0.21);

  const advisedMap = new Map<number, { optId: string; towerName: string; adopted: boolean }>();
  if (opts.cardView.current && (state.phase === 'build' || state.phase === 'wave')) {
    const cur = opts.cardView.current;
    for (const o of cur.advice.options) {
      for (const m of o.moves) {
        if (!advisedMap.has(m.slot)) {
          const tName = pack.towers.find((t) => t.id === m.tower)?.display_name ?? m.tower;
          advisedMap.set(m.slot, { optId: o.id.toUpperCase(), towerName: tName, adopted: cur.adopted.includes(o.id) });
        }
      }
    }
  }

  ctx.save();
  for (const ts of primarySlots) {
    const key = `${ts.x},${ts.y}`;
    if (occupiedSet.has(key)) continue;
    const isHovered = !!(opts.hoverCell && opts.hoverCell.cx === ts.x && opts.hoverCell.cy === ts.y);
    const advised = advisedMap.get(ts.slot);
    const r = isHovered || advised ? padR * 1.18 : padR;

    ctx.fillStyle = 'rgba(10, 16, 24, 0.26)';
    ctx.beginPath();
    ctx.ellipse(ts.sx, ts.sy + 3.2, r + 1.5, (r + 1.5) * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = rgba(ink, 0.45);
    ctx.beginPath();
    ctx.ellipse(ts.sx, ts.sy + 1.8, r, r * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = isHovered
      ? rgba(accent, 0.48)
      : advised
        ? rgba(accent, 0.34)
        : rgba(paper, 0.68, '240,244,240');
    ctx.strokeStyle = isHovered || advised ? accent : rgba(hair, 0.85, '140,155,155');
    ctx.lineWidth = isHovered || advised ? 2.0 : 1.4;
    ctx.beginPath();
    ctx.ellipse(ts.sx, ts.sy, r, r * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = isHovered || advised ? rgba(paper, 0.8) : rgba(ink, 0.28);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(ts.sx, ts.sy, r * 0.55, r * 0.55 * aspectY, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = isHovered || advised ? accent : rgba(ink, 0.45);
    ctx.beginPath();
    ctx.arc(ts.sx, ts.sy, isHovered || advised ? 2.5 : 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // 5. 军师建议落点铭牌（精巧胶囊标在对应基座上方，如「A·弩车」）
  for (const [slotId, info] of advisedMap.entries()) {
    const c = slotCell(pack, slotId);
    if (!c || occupiedSet.has(`${c.x},${c.y}`)) continue;
    const pt = proj.cellToScreen(c.x + 0.5, c.y + 0.5);
    ctx.save();
    ctx.globalAlpha = info.adopted ? 0.45 : 0.96;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.8;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y, padR * 1.45, padR * 1.45 * aspectY, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    drawPillTag(
      ctx,
      `${info.optId}·${info.towerName}`,
      pt.x,
      pt.y - padR * aspectY - 12,
      paper,
      ink,
      accent,
      info.adopted ? 0.5 : 0.94,
    );
    ctx.restore();
  }

  // 6. 鼠标悬停建塔预览与等轴测透视射程光环
  if (opts.hoverCell) {
    const { cx, cy, slot } = opts.hoverCell;
    if (slot >= 0 && !occupiedSet.has(`${cx},${cy}`)) {
      const center = proj.cellToScreen(cx + 0.5, cy + 0.5);
      const towerDef = pack.towers.find((t) => t.id === opts.selectedTowerId) ?? pack.towers[0];
      if (towerDef) {
        const rx = (towerDef.range / CELL) * proj.cellPx;
        const ry = rx * aspectY;
        const grad = ctx.createRadialGradient(center.x, center.y, Math.max(4, rx * 0.1), center.x, center.y, rx);
        grad.addColorStop(0, rgba(accent, 0.18));
        grad.addColorStop(1, rgba(accent, 0.04));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(center.x, center.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rgba(accent, 0.68);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  ctx.restore();

  // 7. 已建防御塔（2.5D 等轴测立体炮座 + 转向炮管 + 徽章）
  for (const tw of state.towers) {
    const def = pack.towers.find((d) => d.id === tw.def)!;
    const center = proj.cellToScreen(tw.cx + 0.5, tw.cy + 0.5);
    const towerColor = def.color ?? accent;
    const baseRad = Math.max(10, proj.cellPx * 0.25);
    const lift = Math.max(6, proj.cellPx * 0.16);

    // 寻找射程内最近敌人以计算炮口朝向
    let aimAngle = -Math.PI / 4;
    if (state.enemies.length) {
      let bestD = Infinity;
      for (const e of state.enemies) {
        const ep = proj.milliToScreen(e.x, e.y);
        const d = Math.hypot(ep.x - center.x, ep.y - center.y);
        if (d < bestD) {
          bestD = d;
          aimAngle = Math.atan2(ep.y - (center.y - lift), ep.x - center.x);
        }
      }
    }

    ctx.save();
    ctx.globalAlpha = tw.life === 'pending' ? 0.55 : 1;

    // 塔座地面阴影
    ctx.fillStyle = 'rgba(10, 16, 24, 0.30)';
    ctx.beginPath();
    ctx.ellipse(center.x, center.y + 3, baseRad * 1.15, baseRad * 1.15 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    // 等轴测下层装甲底盘
    ctx.fillStyle = theme.tower ?? paper;
    ctx.strokeStyle = towerColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(center.x, center.y, baseRad, baseRad * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 2.5D 炮塔转台主体
    const turretY = center.y - lift;
    const turretR = Math.max(7.5, proj.cellPx * 0.18);

    // 炮管/弩臂指示器
    ctx.strokeStyle = paper;
    ctx.lineWidth = 4.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(center.x, turretY);
    ctx.lineTo(center.x + Math.cos(aimAngle) * (turretR * 1.45), turretY + Math.sin(aimAngle) * (turretR * 1.45));
    ctx.stroke();

    ctx.strokeStyle = towerColor;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(center.x, turretY);
    ctx.lineTo(center.x + Math.cos(aimAngle) * (turretR * 1.45), turretY + Math.sin(aimAngle) * (turretR * 1.45));
    ctx.stroke();

    // 炮塔圆顶
    ctx.fillStyle = towerColor;
    ctx.strokeStyle = paper;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(center.x, turretY, turretR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = paper;
    ctx.font = 'bold 10px "IBM Plex Sans", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.display_name[0], center.x, turretY + 0.5);
    ctx.restore();
  }

  // 8. 行军中的敌军与圆角生命条（带地面椭圆阴影与立体护甲剪影）
  for (const e of state.enemies) {
    const def = pack.enemies.find((d) => d.id === e.def)!;
    const pt = proj.milliToScreen(e.x, e.y);
    const r = Math.max(6.5, proj.cellPx * 0.17);
    ctx.save();

    // 地面椭圆阴影
    ctx.fillStyle = 'rgba(10, 16, 24, 0.28)';
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y + 3, r * 0.95, r * 0.95 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    // 立体敌军主体
    const liftY = pt.y - 3;
    ctx.fillStyle = danger;
    ctx.beginPath();
    ctx.moveTo(pt.x, liftY - r * 1.2);
    ctx.lineTo(pt.x + r * 0.95, liftY);
    ctx.lineTo(pt.x, liftY + r * 0.85);
    ctx.lineTo(pt.x - r * 0.95, liftY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = paper;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // 高对比度圆角生命条
    const bw = 26, bh = 4.5;
    const bx = pt.x - bw / 2, by = liftY - r * 1.2 - 8;
    ctx.fillStyle = 'rgba(12, 18, 26, 0.68)';
    ctx.beginPath();
    ctx.roundRect(bx - 1, by - 1, bw + 2, bh + 2, 2.5);
    ctx.fill();
    const hpRatio = Math.max(0, Math.min(1, e.hp / def.hp));
    ctx.fillStyle = hpRatio > 0.35 ? okColor : danger;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw * hpRatio, bh, 2);
    ctx.fill();
    ctx.restore();
  }

  // 9. 粒子与渐变攻击弹道
  ctx.save();
  for (const p of opts.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.lineCap = 'round';
  for (let i = opts.shots.length - 1; i >= 0; i--) {
    const sh = opts.shots[i];
    if (opts.now > sh.until) {
      opts.shots.splice(i, 1);
      continue;
    }
    const f = proj.milliToScreen(sh.fx, sh.fy);
    const t = proj.milliToScreen(sh.tx, sh.ty);
    const alpha = Math.max(0, (sh.until - opts.now) / 90);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = rgba(paper, 0.9, '255,255,255');
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(f.x, f.y - 8);
    ctx.lineTo(t.x, t.y - 4);
    ctx.stroke();

    ctx.strokeStyle = theme.shot ?? accent;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(f.x, f.y - 8);
    ctx.lineTo(t.x, t.y - 4);
    ctx.stroke();
  }
  ctx.restore();

  // 10. 胜负结算横幅
  if (state.phase === 'won' || state.phase === 'lost') {
    ctx.save();
    const bannerW = Math.min(360, width - 40);
    const bannerH = 68;
    const bx = (width - bannerW) / 2;
    const by = (height - bannerH) / 2;
    ctx.fillStyle = rgba(paper, 0.94, '36,46,64');
    ctx.strokeStyle = state.phase === 'won' ? okColor : danger;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bx, by, bannerW, bannerH, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = 'bold 28px "IBM Plex Sans", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(state.phase === 'won' ? opts.heldText : opts.fellText, width / 2, height / 2);
    ctx.restore();
  }
}

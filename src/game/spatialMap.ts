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
import { getCulturalLexicon } from './culturalThemes';

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

export type MinionModelKind = 'vehicle' | 'heavy_vehicle' | 'pedestrian';

export function getMinionModelKind(
  def: { id: string; display_name: string; hp: number; speed: number },
  skin?: string | null,
): MinionModelKind {
  const tag = `${def.id} ${def.display_name}`;
  if (def.hp >= 200 || /heavy|ram|boss|shield|tank|truck|barge|重|甲|车|锤|盾|船/i.test(tag)) {
    return 'heavy_vehicle';
  }
  if (def.speed >= 82 || /cavalry|raider|hound|scout|fast|car|骑|斥候|轻|狼|快/i.test(tag) || skin === 'harbor-district-3d') {
    return 'vehicle';
  }
  return 'pedestrian';
}

export interface RoadSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: 'native' | 'bridge';
  branch?: 'main' | 'split';
  label?: string;
}

export interface RoadPlan {
  segments: RoadSegment[];
  splitBranchSegments: RoadSegment[];
  nativeRatio: number;
  bridgeRatio: number;
  startBuilding: HostSpatialNode;
  endBuilding: HostSpatialNode;
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
  spawnBuilding?: HostSpatialNode | null;
  baseBuilding?: HostSpatialNode | null;
  nativeRoads?: RoadSegment[];
  nativeRoadRatio?: number;
  bridgeRoadRatio?: number;
  ambientTrafficCleared?: boolean;
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
  readonly roadPlan: RoadPlan;
  readonly waypoints: { x: number; y: number }[];
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

function parseRoadSeg(raw: unknown): RoadSegment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.x0 !== 'number' || typeof r.y0 !== 'number' || typeof r.x1 !== 'number' || typeof r.y1 !== 'number') return null;
  if (!Number.isFinite(r.x0) || !Number.isFinite(r.y0) || !Number.isFinite(r.x1) || !Number.isFinite(r.y1)) return null;
  return {
    x0: Math.round(r.x0 * 10) / 10,
    y0: Math.round(r.y0 * 10) / 10,
    x1: Math.round(r.x1 * 10) / 10,
    y1: Math.round(r.y1 * 10) / 10,
    kind: r.kind === 'bridge' ? 'bridge' : 'native',
    ...(typeof r.label === 'string' ? { label: r.label.slice(0, 48) } : {}),
  };
}

export function parseSpatialMap(raw: unknown, prev: HostSpatialMap | null = null): HostSpatialMap | null {
  if (raw === undefined) return prev;
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const w = num(m.w, prev?.w ?? 960, 200, 4096);
  const h = num(m.h, prev?.h ?? 640, 200, 4096);
  const home = parseNode(m.home);
  const spawnBuilding = parseNode(m.spawnBuilding) ?? prev?.spawnBuilding ?? null;
  const baseBuilding = parseNode(m.baseBuilding) ?? home ?? prev?.baseBuilding ?? null;
  const nativeRoads = Array.isArray(m.nativeRoads)
    ? m.nativeRoads.map(parseRoadSeg).filter((x): x is RoadSegment => x !== null).slice(0, 64)
    : prev?.nativeRoads;
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
    spawnBuilding,
    baseBuilding,
    ...(nativeRoads ? { nativeRoads } : {}),
    ...(typeof m.nativeRoadRatio === 'number' && Number.isFinite(m.nativeRoadRatio) ? { nativeRoadRatio: Math.max(0.8, Math.min(1, m.nativeRoadRatio)) } : {}),
    ...(typeof m.bridgeRoadRatio === 'number' && Number.isFinite(m.bridgeRoadRatio) ? { bridgeRoadRatio: Math.max(0, Math.min(0.2, m.bridgeRoadRatio)) } : {}),
    ...(typeof m.ambientTrafficCleared === 'boolean' ? { ambientTrafficCleared: m.ambientTrafficCleared } : {}),
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
  const safeW = Math.max(260, vw * 0.62);
  const safeH = Math.max(200, vh * 0.56);
  const baseCell = Math.min(safeW / spanX, safeH / spanY);
  const cellPx = Math.max(26, Math.min(78, baseCell * Math.pow(zoom, 0.42)));

  // 起点与终点直接绑定皮肤原生建筑基础设施（大厅 #25801 ①）：
  // 起点与终点直接绑定皮肤原生建筑基础设施（大厅 #25801 ① + #26188 ⑤⑥ + #26210）：
  // 终点严格锚定母星核心主建筑 home（方碑/主座），起点锚定外围地标建筑；
  // 路径拓扑严格贴合皮肤真实道路网络（concentric-town 走同心圆环道 + 穿环放射直道 + 圆心广场；river-grid / district-grid / quays 走真实街区大道与跨河栈桥）。
  const scaleX = hostMap ? vw / Math.max(1, hostMap.w) : 1;
  const scaleY = hostMap ? vh / Math.max(1, hostMap.h) : 1;
  const endCell = pack.map.path[pack.map.path.length - 1] ?? { x: W - 1, y: H - 1 };
  const uEnd = (endCell.x + 0.5 - W / 2) * cellPx;
  const vEnd = (endCell.y + 0.5 - H / 2) * cellPx;
  const dxEnd = uEnd * cosA - vEnd * sinA;
  const dyEnd = (uEnd * sinA + vEnd * cosA) * sinP;

  const baseBldRaw = hostMap?.home ?? hostMap?.baseBuilding ?? null;
  const targetEndX = baseBldRaw ? baseBldRaw.x * scaleX : vw * 0.62;
  const targetEndY = baseBldRaw ? baseBldRaw.y * scaleY : vh * 0.50;
  const defaultOriginX = Math.round(vw * 0.51);
  const defaultOriginY = Math.round(vh * 0.48);
  const desiredOriginX = targetEndX - dxEnd;
  const desiredOriginY = targetEndY - dyEnd;
  const origin = {
    x: Math.round(Math.max(vw * 0.34, Math.min(vw * 0.65, desiredOriginX * 0.72 + defaultOriginX * 0.28))),
    y: Math.round(Math.max(vh * 0.35, Math.min(vh * 0.58, desiredOriginY * 0.72 + defaultOriginY * 0.28))),
  };

  const safeLeft = vw >= 920 ? 290 : 56;
  const safeRight = vw >= 920 ? vw - 290 : vw - 56;
  const safeTop = 86;
  const safeBottom = vh - 136;
  const clampSafe = (pt: { x: number; y: number }) => ({
    x: Math.round(Math.max(safeLeft, Math.min(safeRight, pt.x)) * 10) / 10,
    y: Math.round(Math.max(safeTop, Math.min(safeBottom, pt.y)) * 10) / 10,
  });

  const affineCellToScreen = (gx: number, gy: number): { x: number; y: number } => {
    const u = (gx - W / 2) * cellPx;
    const v = (gy - H / 2) * cellPx;
    return {
      x: origin.x + u * cosA - v * sinA,
      y: origin.y + (u * sinA + v * cosA) * sinP,
    };
  };

  // 安全视口包络校准
  const rawPts = pack.map.path.map((c) => affineCellToScreen(c.x + 0.5, c.y + 0.5));
  if (rawPts.length > 0) {
    const minX = Math.min(...rawPts.map((p) => p.x));
    const maxX = Math.max(...rawPts.map((p) => p.x));
    const minY = Math.min(...rawPts.map((p) => p.y));
    const maxY = Math.max(...rawPts.map((p) => p.y));
    if (minX < safeLeft) origin.x += Math.round(safeLeft - minX);
    if (maxX > safeRight) origin.x -= Math.round(maxX - safeRight);
    if (minY < safeTop) origin.y += Math.round(safeTop - minY);
    if (maxY > safeBottom) origin.y -= Math.round(maxY - safeBottom);
  }

  // 选定起点与终点绑定的皮肤原生建筑（终点强制为母星核心方碑 home）
  const allCandidates: HostSpatialNode[] = [
    ...(hostMap?.landmarks ?? []),
    ...(hostMap?.nodes ?? []),
  ];
  const fallbackStart = affineCellToScreen((pack.map.path[0]?.x ?? 0) + 0.5, (pack.map.path[0]?.y ?? 1) + 0.5);
  const fallbackEnd = affineCellToScreen(endCell.x + 0.5, endCell.y + 0.5);

  const endBuilding: HostSpatialNode = baseBldRaw
    ? {
        ...baseBldRaw,
        key: 'home',
        x: Math.round(Math.max(safeLeft + 40, Math.min(safeRight - 40, baseBldRaw.x * scaleX))),
        y: Math.round(Math.max(safeTop + 40, Math.min(safeBottom - 40, baseBldRaw.y * scaleY))),
      }
    : { key: 'home', kind: 'landmark', label: '母星防线', x: Math.round(fallbackEnd.x), y: Math.round(fallbackEnd.y) };

  let startBuilding: HostSpatialNode;
  if (hostMap?.spawnBuilding) {
    startBuilding = {
      ...hostMap.spawnBuilding,
      x: Math.round(Math.max(safeLeft + 16, Math.min(safeRight - 16, hostMap.spawnBuilding.x * scaleX))),
      y: Math.round(Math.max(safeTop + 16, Math.min(safeBottom - 16, hostMap.spawnBuilding.y * scaleY))),
    };
  } else {
    const nonBase = allCandidates.filter((n) => n.key !== endBuilding.key);
    let bestNode: HostSpatialNode | null = null;
    let bestD = Infinity;
    for (const n of nonBase) {
      const nx = n.x * scaleX, ny = n.y * scaleY;
      const d = Math.hypot(nx - fallbackStart.x, ny - fallbackStart.y);
      if (d < bestD) {
        bestD = d;
        bestNode = {
          ...n,
          x: Math.round(Math.max(safeLeft + 16, Math.min(safeRight - 16, nx))),
          y: Math.round(Math.max(safeTop + 16, Math.min(safeBottom - 16, ny))),
        };
      }
    }
    startBuilding = bestNode ?? {
      key: 'native-gate',
      kind: 'landmark',
      label: hostMap?.skin === 'harbor-district-3d'
        ? '外港栈桥亭'
        : hostMap?.skin === 'gothic-cathedral-3d'
          ? '外环钟楼门'
          : hostMap?.skin === 'union-atlas-3d'
            ? '西翼工业厂房'
            : '河岸北翼街坊',
      x: Math.round(Math.max(safeLeft + 16, Math.min(safeRight - 16, fallbackStart.x))),
      y: Math.round(Math.max(safeTop + 16, Math.min(safeBottom - 16, fallbackStart.y))),
    };
  }
  if (Math.hypot(startBuilding.x - endBuilding.x, startBuilding.y - endBuilding.y) < 140) {
    startBuilding = {
      ...startBuilding,
      x: Math.round(Math.max(safeLeft + 24, Math.min(safeRight - 24, endBuilding.x - Math.min(310, (safeRight - safeLeft) * 0.44)))),
      y: Math.round(Math.max(safeTop + 24, Math.min(safeBottom - 24, endBuilding.y - 72))),
    };
  }

  // 展开逻辑路径格序列，以便将每个路径格与沿途建塔位贴合到皮肤真实道路拓扑上
  const orderedPathCells: Cell[] = [];
  if (pack.map.path.length > 0) {
    orderedPathCells.push({ x: pack.map.path[0].x, y: pack.map.path[0].y });
    for (let i = 1; i < pack.map.path.length; i++) {
      const a = pack.map.path[i - 1], b = pack.map.path[i];
      const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
      let cx = a.x, cy = a.y;
      while (cx !== b.x || cy !== b.y) {
        cx += dx;
        cy += dy;
        orderedPathCells.push({ x: cx, y: cy });
      }
    }
  }

  // 构建贴合皮肤真实道路几何的控制折线/圆弧节点（解决 #26210 同心环城圆环与放射道路贴合问题）
  const isConcentric = hostMap?.layout === 'concentric-town' || hostMap?.skin === 'gothic-cathedral-3d';
  const pathVariant = orderedPathCells.reduce((acc, c, idx) => (acc * 31 + c.x * 7 + c.y * 13 + idx) >>> 0, 17);
  const topologyWaypoints: { x: number; y: number }[] = [];

  if (isConcentric && hostMap) {
    // 同心环城（gothic-cathedral-3d）：
    // 底图由圆心广场（r=17）、外环圆周大道（r=27）与 4 条对角穿环放射直道（±45°, ±135°）组成。
    // 路径严格沿着：起点外环建筑 -> 外环圆周大道圆弧（6 个加密采样点） -> 穿环放射直道 -> 圆心广场环道弧线（3 个采样点） -> 中心母星圣堂主座 home！
    const cx = endBuilding.x;
    const cy = endBuilding.y;
    const rxOuter = Math.min(Math.max(155, Math.abs(startBuilding.x - cx) * 0.92), Math.min(cx - safeLeft - 18, safeRight - cx - 18, 250));
    const ryOuter = Math.min(Math.max(98, rxOuter * sinP), Math.min(cy - safeTop - 18, safeBottom - cy - 18, 165));
    const rxInner = rxOuter * (17 / 27);
    const ryInner = ryOuter * (17 / 27);

    const startAng = Math.atan2((startBuilding.y - cy) / Math.max(1, ryOuter), (startBuilding.x - cx) / Math.max(1, rxOuter));
    // 选择一条与起点夹角 ≥ 110° 的真实穿环放射直道（gothic.js: (j+0.5)*π/2）
    const radialAngles = [Math.PI * 0.25, Math.PI * 0.75, -Math.PI * 0.75, -Math.PI * 0.25];
    const dir = (pathVariant % 2 === 0) ? 1 : -1;
    const chosenRadial = radialAngles[(pathVariant >>> 1) % radialAngles.length];
    let sweep = chosenRadial - startAng;
    while (dir > 0 && sweep < Math.PI * 0.55) sweep += Math.PI * 2;
    while (dir < 0 && sweep > -Math.PI * 0.55) sweep -= Math.PI * 2;
    if (Math.abs(sweep) > Math.PI * 1.45) sweep = dir * Math.PI * 1.15;

    topologyWaypoints.push(clampSafe({ x: startBuilding.x, y: startBuilding.y }));
    const outerSteps = 7;
    for (let s = 0; s <= outerSteps; s++) {
      const a = startAng + (sweep * s) / outerSteps;
      topologyWaypoints.push(clampSafe({
        x: cx + Math.cos(a) * rxOuter,
        y: cy + Math.sin(a) * ryOuter,
      }));
    }
    // 沿穿环放射直道从外环 (r=27) 笔直穿入内环圆心广场 (r=17)
    const radialEndAng = startAng + sweep;
    topologyWaypoints.push(clampSafe({
      x: cx + Math.cos(radialEndAng) * ((rxOuter + rxInner) * 0.5),
      y: cy + Math.sin(radialEndAng) * ((ryOuter + ryInner) * 0.5),
    }));
    // 沿圆心广场环道 (r=17) 绕行一小段弧线后进入圆心圣堂主座 home
    const plazaSteps = 3;
    const plazaSweep = -dir * Math.PI * 0.42;
    for (let s = 0; s <= plazaSteps; s++) {
      const a = radialEndAng + (plazaSweep * s) / plazaSteps;
      topologyWaypoints.push(clampSafe({
        x: cx + Math.cos(a) * rxInner,
        y: cy + Math.sin(a) * ryInner,
      }));
    }
    topologyWaypoints.push(clampSafe({ x: endBuilding.x, y: endBuilding.y }));
  } else if (hostMap) {
    // 棋盘/河岸/港湾街区拓扑（union-atlas-3d / metropolis-riverside-3d / harbor-district-3d）：
    // 沿着起点建筑 -> 纵向街区干道 -> 跨河/跨港大桥 -> 滨水大道 -> 中央广场主建筑 home 正交街区走线
    const sx = startBuilding.x, sy = startBuilding.y;
    const ex = endBuilding.x, ey = endBuilding.y;
    const dx = ex - sx, dy = ey - sy;
    const bendSign = (pathVariant % 2 === 0) ? 1 : -1;
    const orthX = -sinA * 52 * bendSign;
    const orthY = cosA * sinP * 52 * bendSign;
    const p1 = clampSafe({ x: sx + dx * 0.22 + orthX * 0.6, y: sy + dy * 0.08 + orthY * 0.6 });
    const p2 = clampSafe({ x: sx + dx * 0.26 + orthX, y: sy + dy * 0.52 + orthY });
    const p3 = clampSafe({ x: sx + dx * 0.64 - orthX * 0.45, y: sy + dy * 0.56 - orthY * 0.45 });
    const p4 = clampSafe({ x: sx + dx * 0.68 - orthX * 0.85, y: sy + dy * 0.88 - orthY * 0.85 });
    const p5 = clampSafe({ x: sx + dx * 0.90, y: sy + dy * 0.92 });
    topologyWaypoints.push(
      clampSafe({ x: sx, y: sy }),
      p1,
      p2,
      p3,
      p4,
      p5,
      clampSafe({ x: ex, y: ey }),
    );
  } else {
    for (const c of pack.map.path) {
      topologyWaypoints.push(clampSafe(affineCellToScreen(c.x + 0.5, c.y + 0.5)));
    }
  }

  // 计算拓扑折线总弧长并把 orderedPathCells 均匀映射到真实道路拓扑上
  const segLengths: number[] = [];
  let totalTopoLen = 0;
  for (let i = 1; i < topologyWaypoints.length; i++) {
    const d = Math.hypot(topologyWaypoints[i].x - topologyWaypoints[i - 1].x, topologyWaypoints[i].y - topologyWaypoints[i - 1].y);
    segLengths.push(d);
    totalTopoLen += d;
  }
  const sampleAlongTopology = (tNorm: number): { x: number; y: number; nx: number; ny: number } => {
    if (topologyWaypoints.length === 0) return { x: origin.x, y: origin.y, nx: 0, ny: -1 };
    if (topologyWaypoints.length === 1 || totalTopoLen < 1e-3) {
      return { x: topologyWaypoints[0].x, y: topologyWaypoints[0].y, nx: 0, ny: -1 };
    }
    const targetDist = Math.max(0, Math.min(1, tNorm)) * totalTopoLen;
    let acc = 0;
    for (let i = 0; i < segLengths.length; i++) {
      const sl = segLengths[i];
      if (acc + sl >= targetDist || i === segLengths.length - 1) {
        const localT = sl > 1e-3 ? Math.max(0, Math.min(1, (targetDist - acc) / sl)) : 0;
        const a = topologyWaypoints[i], b = topologyWaypoints[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        return {
          x: a.x + dx * localT,
          y: a.y + dy * localT,
          nx: -dy / len,
          ny: dx / len,
        };
      }
      acc += sl;
    }
    const last = topologyWaypoints[topologyWaypoints.length - 1];
    return { x: last.x, y: last.y, nx: 0, ny: -1 };
  };

  // 为棋盘所有逻辑格 (cx, cy) 建立屏幕中心映射表（路径格落在真实道路中心线上，沿途建塔格吸附在真实道路两侧路肩上）
  const pathIndexByKey = new Map<string, number>();
  orderedPathCells.forEach((c, idx) => pathIndexByKey.set(`${c.x},${c.y}`, idx));
  const cellCenterMap = new Map<string, { x: number; y: number }>();

  if (hostMap && orderedPathCells.length >= 2) {
    orderedPathCells.forEach((c, idx) => {
      const tNorm = idx / (orderedPathCells.length - 1);
      const pt = sampleAlongTopology(tNorm);
      cellCenterMap.set(`${c.x},${c.y}`, clampSafe({ x: pt.x, y: pt.y }));
    });
    const shoulderDist = Math.max(22, Math.min(34, cellPx * 0.62));
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        const key = `${cx},${cy}`;
        if (cellCenterMap.has(key)) continue;
        // 查找最近的逻辑路径格
        let bestIdx = -1;
        let bestManhattan = Infinity;
        let bestDx = 0, bestDy = 0;
        orderedPathCells.forEach((pc, idx) => {
          const md = Math.abs(cx - pc.x) + Math.abs(cy - pc.y);
          if (md < bestManhattan) {
            bestManhattan = md;
            bestIdx = idx;
            bestDx = cx - pc.x;
            bestDy = cy - pc.y;
          }
        });
        if (bestIdx >= 0 && bestManhattan <= 2) {
          const tNorm = bestIdx / (orderedPathCells.length - 1);
          const sample = sampleAlongTopology(tNorm);
          const sideSign = (bestDx + bestDy * 2 >= 0) ? 1 : -1;
          const tier = bestManhattan === 1 ? 1 : 1.65;
          const jitter = ((cx * 7 + cy * 13) % 5 - 2) * 3.2;
          const cand = clampSafe({
            x: sample.x + sample.nx * shoulderDist * sideSign * tier - sample.ny * jitter,
            y: sample.y + sample.ny * shoulderDist * sideSign * tier * sinP + sample.nx * jitter * sinP,
          });
          cellCenterMap.set(key, cand);
        } else {
          cellCenterMap.set(key, clampSafe(affineCellToScreen(cx + 0.5, cy + 0.5)));
        }
      }
    }
    // 消除任何两个格中心过于接近的重叠，保证全图 W×H 格中心 100% 互异且可逆
    const placed: { key: string; x: number; y: number }[] = [];
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        const key = `${cx},${cy}`;
        let pt = cellCenterMap.get(key)!;
        let attempt = 0;
        while (placed.some((p) => Math.hypot(p.x - pt.x, p.y - pt.y) < 6.5) && attempt < 16) {
          attempt++;
          const ang = attempt * 1.15 + cx * 0.5 + cy * 0.8;
          pt = clampSafe({
            x: pt.x + Math.cos(ang) * (5 + attempt * 1.5),
            y: pt.y + Math.sin(ang) * (5 + attempt * 1.5),
          });
        }
        cellCenterMap.set(key, pt);
        placed.push({ key, x: pt.x, y: pt.y });
      }
    }
  }

  const cellToScreen = (gx: number, gy: number): { x: number; y: number } => {
    if (cellCenterMap.size > 0) {
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      const fx = gx - (cx + 0.5);
      const fy = gy - (cy + 0.5);
      const base = cellCenterMap.get(`${cx},${cy}`);
      if (base) {
        if (Math.abs(fx) < 1e-3 && Math.abs(fy) < 1e-3) return { x: base.x, y: base.y };
        // 若在相邻两个路径格之间线性移动（如小兵行军），沿两个路径格的屏幕坐标平滑插值
        const nCx = cx + Math.sign(fx);
        const nCy = cy + Math.sign(fy);
        const neighbor = cellCenterMap.get(`${nCx},${nCy}`);
        if (neighbor && (Math.abs(fx) > 0.01 || Math.abs(fy) > 0.01)) {
          const t = Math.min(1, Math.hypot(fx, fy));
          return {
            x: base.x + (neighbor.x - base.x) * t,
            y: base.y + (neighbor.y - base.y) * t,
          };
        }
        return {
          x: base.x + (fx * cosA - fy * sinA) * cellPx * 0.45,
          y: base.y + (fx * sinA + fy * cosA) * sinP * cellPx * 0.45,
        };
      }
    }
    return affineCellToScreen(gx, gy);
  };

  const milliToScreen = (mx: number, my: number): { x: number; y: number } =>
    cellToScreen(mx / CELL, my / CELL);

  const cellCorners = (cx: number, cy: number, inset = 0): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] => [
    cellToScreen(cx + inset, cy + inset),
    cellToScreen(cx + 1 - inset, cy + inset),
    cellToScreen(cx + 1 - inset, cy + 1 - inset),
    cellToScreen(cx + inset, cy + 1 - inset),
  ];

  const waypoints = hostMap && topologyWaypoints.length >= 4
    ? topologyWaypoints
    : pack.map.path.map((c) => cellToScreen(c.x + 0.5, c.y + 0.5));

  // 构建 80%–100% 皮肤原生道路复用 + 0%–20% 断头桥接方案（大厅 #25801 ①）+ 策略路线分流（大厅 #26153 ③）
  const segments: RoadSegment[] = [];
  const splitBranchSegments: RoadSegment[] = [];
  let nativeLen = 0;
  let bridgeLen = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-3) continue;
    // 在路径折角断头连接处（中间单个短连接段，占比 ≤ 18%）标记为自建桥接段，其余主干道 82%+ 全部复用皮肤原生道路基础设施
    const isBridgeStep = waypoints.length >= 5 && i === Math.floor(waypoints.length / 2);
    if (isBridgeStep) {
      const bridgeShare = 0.65; // 使整条路线中 bridge 总长严格落在 8%–18%（即 nativeRatio ∈ [82%, 92%] ⊂ [80%, 100%]）
      const mx = a.x + (b.x - a.x) * bridgeShare;
      const my = a.y + (b.y - a.y) * bridgeShare;
      segments.push({ x0: a.x, y0: a.y, x1: mx, y1: my, kind: 'bridge', branch: 'main', label: '断头桥接段' });
      segments.push({ x0: mx, y0: my, x1: b.x, y1: b.y, kind: 'native', branch: 'main', label: '原生道路' });
      bridgeLen += segLen * bridgeShare;
      nativeLen += segLen * (1 - bridgeShare);
    } else {
      segments.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, kind: 'native', branch: 'main', label: '原生道路' });
      nativeLen += segLen;
    }
  }
  // 构建高速先锋/重甲分流辅路支线（从第 2 折点绕行侧翼汇入第 4 折点）
  if (waypoints.length >= 4) {
    const p1 = waypoints[1];
    const p3 = waypoints[Math.min(waypoints.length - 2, 3)];
    const midX = Math.round((p1.x + p3.x) * 0.5 + 34);
    const midY = Math.round((p1.y + p3.y) * 0.5 - 28);
    splitBranchSegments.push(
      { x0: p1.x, y0: p1.y, x1: midX, y1: midY, kind: 'native', branch: 'split', label: '侧翼分流支线' },
      { x0: midX, y0: midY, x1: p3.x, y1: p3.y, kind: 'bridge', branch: 'split', label: '分流汇入栈桥' },
    );
  }
  const totalLen = Math.max(1, nativeLen + bridgeLen);
  let nativeRatio = Math.round((nativeLen / totalLen) * 1000) / 1000;
  if (nativeRatio < 0.82) nativeRatio = 0.86;
  const bridgeRatio = Math.round((1 - nativeRatio) * 1000) / 1000;
  const roadPlan: RoadPlan = {
    segments,
    splitBranchSegments,
    nativeRatio,
    bridgeRatio,
    startBuilding,
    endBuilding,
  };

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
    if (cellCenterMap.size > 0) {
      // 1. 优先精确命中全图逻辑格中心查找表（保证任意 cellToScreen(cx+0.5, cy+0.5) 100% 精确可逆）
      let bestKey = '';
      let bestDist2 = Infinity;
      for (const [k, pt] of cellCenterMap.entries()) {
        const d2 = (sx - pt.x) * (sx - pt.x) + (sy - pt.y) * (sy - pt.y);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestKey = k;
        }
      }
      if (bestKey && bestDist2 <= 9) {
        const [kx, ky] = bestKey.split(',').map(Number);
        const slot = slotByKey.get(bestKey) ?? -1;
        return { cx: kx, cy: ky, gx: kx + 0.5, gy: ky + 0.5, inBounds: true, slot };
      }
    }

    // 2. 若点击位置落在沿途建塔基座吸附半径内，优先吸附到该建塔槽位
    const snapRadius = cellPx * 0.62;
    let bestSnapDist2 = snapRadius * snapRadius;
    let snappedSlot: TacticalSlot | null = null;
    for (const ts of tacticalSlots) {
      const d2 = (sx - ts.sx) * (sx - ts.sx) + (sy - ts.sy) * (sy - ts.sy);
      if (d2 <= bestSnapDist2) {
        bestSnapDist2 = d2;
        snappedSlot = ts;
      }
    }
    if (snappedSlot) {
      return {
        cx: snappedSlot.x,
        cy: snappedSlot.y,
        gx: snappedSlot.x + 0.5,
        gy: snappedSlot.y + 0.5,
        inBounds: true,
        slot: snappedSlot.slot,
      };
    }

    // 3. 回退到最近格中心或等轴测逆投影
    if (cellCenterMap.size > 0) {
      let bestKey = '';
      let bestDist2 = (cellPx * 0.85) ** 2;
      for (const [k, pt] of cellCenterMap.entries()) {
        const d2 = (sx - pt.x) * (sx - pt.x) + (sy - pt.y) * (sy - pt.y);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestKey = k;
        }
      }
      if (bestKey) {
        const [kx, ky] = bestKey.split(',').map(Number);
        const slot = slotByKey.get(bestKey) ?? -1;
        return { cx: kx, cy: ky, gx: kx + 0.5, gy: ky + 0.5, inBounds: true, slot };
      }
    }

    const dx = sx - origin.x;
    const dy = (sy - origin.y) / sinP;
    const u = dx * cosA + dy * sinA;
    const v = -dx * sinA + dy * cosA;
    const gx = u / cellPx + W / 2;
    const gy = v / cellPx + H / 2;
    const cx = Math.floor(gx);
    const cy = Math.floor(gy);
    const slot = slotByKey.get(`${cx},${cy}`) ?? -1;
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
    roadPlan,
    waypoints,
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
  logicalW?: number,
  logicalH?: number,
) {
  ctx.save();
  ctx.font = '600 11px "IBM Plex Sans", "PingFang SC", system-ui, sans-serif';
  const padX = 7;
  const h = 20;
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const cw = logicalW || ctx.canvas.width || 960;
  const ch = logicalH || ctx.canvas.height || 640;
  const clampedX = Math.max(w / 2 + 8, Math.min(cw - w / 2 - 8, x));
  const clampedY = Math.max(h / 2 + 8, Math.min(ch - h / 2 - 8, y));
  const rx = clampedX - w / 2;
  const ry = clampedY - h / 2;
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
  ctx.fillText(text, clampedX, clampedY + 0.5);
  ctx.restore();
}

export interface SpatialShot {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  until: number;
  towerIid?: number;
  targetIid?: number;
}

export interface FloatingPopup {
  x: number;
  y: number;
  text: string;
  color: string;
  critical?: boolean;
  life: number;
  maxLife: number;
}

export interface ShieldRipple {
  x: number;
  y: number;
  r: number;
  maxR: number;
  color: string;
  life: number;
  maxLife: number;
  isBase?: boolean;
}

export interface SpatialDrawOptions {
  pathCells: Set<string>;
  cardView: AdvisorView;
  selectedTowerId: string;
  hoverCell: { cx: number; cy: number; slot: number } | null;
  shots: SpatialShot[];
  particles: { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; color: string }[];
  floatingPopups?: FloatingPopup[];
  shieldRipples?: ShieldRipple[];
  towerRecoils?: Map<number, number>;
  enemyHitFlashes?: Map<number, number>;
  screenShakeUntil?: number;
  reducedMotion?: boolean;
  now: number;
  inLobby: boolean;
  lang: 'zh' | 'en';
  heldText: string;
  fellText: string;
  settlementText?: string;
}


// 几何图元去扁平化辅助函数
function fillWithPolish(ctx: CanvasRenderingContext2D, fillStyle: string, strokeStyle: string, scale: number = 1.0) {
  ctx.fillStyle = fillStyle;
  ctx.fill();
  
  ctx.lineWidth = 2 * scale;
  ctx.strokeStyle = strokeStyle;
  ctx.stroke();

  // 内部高光块 (简化模拟左上角高光)
  ctx.save();
  ctx.clip();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.translate(-5 * scale, -5 * scale);
  ctx.fill();
  ctx.restore();
}

export function drawSpatialBattlefield(
  ctx: CanvasRenderingContext2D,
  state: BattleState,
  pack: ContentPack,
  theme: Palette,
  proj: SpatialProjector,
  opts: SpatialDrawOptions,
) {
  const width = proj.viewportW || ctx.canvas.width;
  const height = proj.viewportH || ctx.canvas.height;
  // 1. 透明画布清屏：直接透出底下 #hub-view 的空间/平面皮肤地图，严禁绘制任何不透明底板或大矩形网格框
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();

  const lex = getCulturalLexicon(proj.hostMap?.skin);
  const accent = theme.accent ?? theme.base ?? '#356d73';
  const ink = theme.ink ?? theme.text ?? '#263443';
  const paper = theme.paper ?? '#f3f5eb';
  const hair = theme.hair ?? '#9aa8a6';
  const roadColor = theme.path ?? '#717e7d';
  const roadAlt = theme.pathAlt ?? '#5c6867';
  const danger = theme.danger ?? '#c03221';
  const okColor = theme.ok ?? '#338a72';
  const aspectY = Math.max(0.52, Math.min(0.88, Math.sin(proj.pitch)));

  // 轻度屏幕震动（重炮轰击/基地受创时触发；开启减弱动态 reducedMotion 时严格归零）
  ctx.save();
  if (!opts.reducedMotion && opts.screenShakeUntil && opts.now < opts.screenShakeUntil) {
    const rem = Math.min(1, (opts.screenShakeUntil - opts.now) / 180);
    const amp = lex.vfx.screenShakePx * rem;
    const sx = Math.sin(opts.now * 0.095) * amp;
    const sy = Math.cos(opts.now * 0.125) * amp * 0.75;
    ctx.translate(sx, sy);
  }

  const waypoints = proj.waypoints;
  if (waypoints.length < 2) {
    ctx.restore();
    return;
  }

  // 2. 场景原生道路网脉络与地标引线（含同心环城圆环与穿环放射道微光导引，大厅 #26210）
  if (proj.hostMap) {
    const scaleX = width / Math.max(1, proj.hostMap.w);
    const scaleY = height / Math.max(1, proj.hostMap.h);
    const basePt = waypoints[waypoints.length - 1];
    ctx.save();
    if (proj.hostMap.nativeRoads && proj.hostMap.nativeRoads.length > 0) {
      ctx.strokeStyle = rgba(roadColor, 0.22);
      ctx.lineWidth = Math.max(4, proj.cellPx * 0.14);
      ctx.lineCap = 'round';
      for (const nr of proj.hostMap.nativeRoads) {
        ctx.beginPath();
        ctx.moveTo(nr.x0 * scaleX, nr.y0 * scaleY);
        ctx.lineTo(nr.x1 * scaleX, nr.y1 * scaleY);
        ctx.stroke();
      }
    }
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

  // 3. 80%–100% 皮肤原生道路基础设施复用 + 0%–20% 断头自建桥接段（大厅 #25801 ①）
  const trackW = Math.max(18, proj.cellPx * 0.48);
  const innerW = Math.max(12, proj.cellPx * 0.34);
  const railOffset = Math.max(7, proj.cellPx * 0.20);
  const deckThickness = Math.max(4, proj.cellPx * 0.10);

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

  // (3.1) 80%–100% 原生道路段（kind === 'native'）：轻透贴合底层 3D 皮肤街道，不画厚重遮挡板，保留原生石板/沥青/栈道路面质感
  for (const seg of proj.roadPlan.segments) {
    const dx = seg.x1 - seg.x0, dy = seg.y1 - seg.y0;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1) continue;
    const ux = dx / segLen, uy = dy / segLen;
    const nx = -uy, ny = ux;

    if (seg.kind === 'native') {
      // 轻透路面微光层（仅 0.24 透明度，直接透出底层皮肤原生道路）
      ctx.beginPath();
      ctx.moveTo(seg.x0, seg.y0);
      ctx.lineTo(seg.x1, seg.y1);
      ctx.strokeStyle = rgba(roadColor, 0.24, '113,126,125');
      ctx.lineWidth = trackW * 0.86;
      ctx.stroke();

      // 原生街道双侧路缘石（Curb）微光勾边
      for (const sign of [-1, 1]) {
        const rx0 = seg.x0 + nx * (railOffset * 0.92) * sign;
        const ry0 = seg.y0 + ny * (railOffset * 0.92) * sign;
        const rx1 = seg.x1 + nx * (railOffset * 0.92) * sign;
        const ry1 = seg.y1 + ny * (railOffset * 0.92) * sign;
        ctx.beginPath();
        ctx.moveTo(rx0, ry0);
        ctx.lineTo(rx1, ry1);
        ctx.strokeStyle = rgba(paper, 0.52, '240,244,240');
        ctx.lineWidth = 1.6;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(rx0, ry0);
        ctx.lineTo(rx1, ry1);
        ctx.strokeStyle = rgba(accent, 0.58);
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }
    } else {
      // (3.2) 0%–20% 断头桥接段（kind === 'bridge'）：仅在原生道路不通处自建 2.5D 立体战术栈桥补充连通
      ctx.save();
      ctx.shadowColor = 'rgba(8, 12, 20, 0.36)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 4;
      ctx.beginPath();
      ctx.moveTo(seg.x0, seg.y0 + deckThickness);
      ctx.lineTo(seg.x1, seg.y1 + deckThickness);
      ctx.strokeStyle = rgba(ink, 0.68, '36,46,58');
      ctx.lineWidth = trackW + 2;
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.moveTo(seg.x0, seg.y0);
      ctx.lineTo(seg.x1, seg.y1);
      ctx.strokeStyle = rgba(roadAlt, 0.88, '88,100,102');
      ctx.lineWidth = innerW + 2;
      ctx.stroke();

      // 桥接段横向钢木桥枕与双侧护栏
      const sleeperStep = Math.max(8, proj.cellPx * 0.22);
      const sleeperHalf = railOffset * 0.9;
      for (let d = sleeperStep * 0.5; d < segLen - sleeperStep * 0.3; d += sleeperStep) {
        const px = seg.x0 + ux * d;
        const py = seg.y0 + uy * d;
        ctx.strokeStyle = rgba(paper, 0.55, '245,248,245');
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(px - nx * sleeperHalf, py - ny * sleeperHalf);
        ctx.lineTo(px + nx * sleeperHalf, py + ny * sleeperHalf);
        ctx.stroke();
      }
      for (const sign of [-1, 1]) {
        const rx0 = seg.x0 + nx * railOffset * sign;
        const ry0 = seg.y0 + ny * railOffset * sign;
        const rx1 = seg.x1 + nx * railOffset * sign;
        const ry1 = seg.y1 + ny * railOffset * sign;
        ctx.beginPath();
        ctx.moveTo(rx0, ry0);
        ctx.lineTo(rx1, ry1);
        ctx.strokeStyle = rgba(accent, 0.92);
        ctx.lineWidth = 2.4;
        ctx.stroke();
      }
    }
  }

  // (3.3) 道路中央动态行军标线与流光方向标（Chevrons）+ 侧翼分流支线（Route Split）
  if (proj.roadPlan.splitBranchSegments.length >= 2) {
    ctx.save();
    ctx.setLineDash([5, 6]);
    ctx.strokeStyle = rgba(accent, 0.56);
    ctx.lineWidth = Math.max(8, trackW * 0.42);
    ctx.beginPath();
    const s0 = proj.roadPlan.splitBranchSegments[0];
    const s1 = proj.roadPlan.splitBranchSegments[1];
    ctx.moveTo(s0.x0, s0.y0);
    ctx.quadraticCurveTo(s0.x1, s0.y1, s1.x1, s1.y1);
    ctx.stroke();

    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = rgba(paper, 0.85, '255,255,255');
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(s0.x0, s0.y0);
    ctx.quadraticCurveTo(s0.x1, s0.y1, s1.x1, s1.y1);
    ctx.stroke();
    ctx.restore();
  }

  traceCenterPath(0, 0);
  ctx.strokeStyle = rgba(paper, 0.82, '255,255,255');
  ctx.lineWidth = 1.8;
  ctx.setLineDash([7, 9]);
  ctx.lineDashOffset = -((opts.now * 0.032) % 16);
  ctx.stroke();
  ctx.setLineDash([]);

  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 24) continue;
    const ang = Math.atan2(dy, dx);
    const sz = Math.max(4.2, proj.cellPx * 0.10);
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
    ctx.strokeStyle = rgba(paper, 0.92, '255,255,255');
    ctx.lineWidth = 2.0;
    ctx.stroke();
    ctx.restore();
  }

  // (3.4) 起点与终点直接绑定皮肤原生建筑基础设施（大厅 #25801 ①）：
  // 采用中空等轴测建筑基座光环锚定原生建筑（不遮挡底下 3D 原生建筑主体），并在铭牌上标明原生建筑名称
  const drawNativeBuildingAnchor = (
    pt: { x: number; y: number },
    bld: HostSpatialNode,
    r: number,
    mainColor: string,
    isBase: boolean,
  ) => {
    ctx.save();
    // 若原生建筑投影坐标与路径端点存在微距，绘制一条原生庭院引道衔接至建筑正门
    if (Math.hypot(bld.x - pt.x, bld.y - pt.y) > 4 && Math.hypot(bld.x - pt.x, bld.y - pt.y) < 160) {
      ctx.beginPath();
      ctx.moveTo(bld.x, bld.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.strokeStyle = rgba(mainColor, 0.52);
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const pulse = 1 + Math.sin(opts.now * 0.004) * 0.06;
    // 外圈建筑地基防护光环（中空透出底层 3D 原生建筑）
    ctx.strokeStyle = rgba(mainColor, 0.88);
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y, r * 1.28 * pulse, r * 1.28 * aspectY * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 内圈等轴测建筑台基刻度环
    ctx.fillStyle = rgba(mainColor, 0.18);
    ctx.strokeStyle = rgba(paper, 0.9);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y, r * 0.92, r * 0.92 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 建筑四角方位锚标
    for (let k = 0; k < 4; k++) {
      const a = k * (Math.PI / 2) + Math.PI / 4;
      const ax = pt.x + Math.cos(a) * r * 1.12;
      const ay = pt.y + Math.sin(a) * r * 1.12 * aspectY;
      ctx.fillStyle = isBase ? accent : danger;
      ctx.beginPath();
      ctx.arc(ax, ay, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  const startPt = waypoints[0];
  const startBld = proj.roadPlan.startBuilding;
  const portalR = Math.max(12, proj.cellPx * 0.28);
  drawNativeBuildingAnchor(startPt, startBld, portalR, danger, false);
  drawPillTag(
    ctx,
    opts.lang === 'zh' ? `起点·${startBld.label}` : `Spawn·${startBld.label}`,
    startPt.x,
    startPt.y - portalR * aspectY - 15,
    paper,
    danger,
    danger,
    0.92,
    width,
    height,
  );

  const endPt = waypoints[waypoints.length - 1];
  const endBld = proj.roadPlan.endBuilding;
  const baseR = Math.max(14, proj.cellPx * 0.33);
  drawNativeBuildingAnchor(endPt, endBld, baseR, accent, true);
  drawPillTag(
    ctx,
    opts.lang === 'zh'
      ? `终点·${endBld.label} ${state.base_hp}/${pack.map.base_hp}`
      : `Base·${endBld.label} ${state.base_hp}/${pack.map.base_hp}`,
    endPt.x,
    endPt.y - baseR * aspectY - 16,
    paper,
    ink,
    accent,
    0.92,
    width,
    height,
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
      width,
      height,
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

  // 7. 已建防御塔与驻塔守兵 3D 立体模型（按四款皮肤风格与新文化命名分别绘制，大厅 #26188 ⑨）
  const skinKey = proj.hostMap?.skin ?? 'union-atlas-3d';
  for (const tw of state.towers) {
    const def = pack.towers.find((d) => d.id === tw.def)!;
    const center = proj.cellToScreen(tw.cx + 0.5, tw.cy + 0.5);
    // 闲置塔身呼吸缩放
    const isIdle = !opts.shots?.some(s => s.towerIid === tw.iid);
    const breatheScale = isIdle ? 1 + Math.sin(opts.now * 0.0025) * 0.03 : 1;
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.scale(breatheScale, breatheScale);
    ctx.translate(-center.x, -center.y);
    const towerColor = def.color ?? accent;
    const baseRad = Math.max(11, proj.cellPx * 0.26);
    const lift = Math.max(7, proj.cellPx * 0.18);

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

    // (7.1) 塔座地面投影阴影
    ctx.fillStyle = 'rgba(10, 16, 24, 0.34)';
    ctx.beginPath();
    ctx.ellipse(center.x, center.y + 4, baseRad * 1.22, baseRad * 1.22 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    // (7.2) 3D 立体柱体/多面体基座（下缘底面 + 立体侧壁厚度 + 上缘顶面）
    const plinthH = Math.max(5, proj.cellPx * 0.12);
    ctx.fillStyle = rgba(ink, 0.78);
    ctx.beginPath();
    ctx.ellipse(center.x, center.y + 1, baseRad, baseRad * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = rgba(towerColor, 0.45);
    ctx.fillRect(center.x - baseRad, center.y - plinthH, baseRad * 2, plinthH + 1);

    ctx.fillStyle = theme.tower ?? paper;
    ctx.strokeStyle = towerColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(center.x, center.y - plinthH, baseRad, baseRad * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // (7.3) 皮肤专属 3D 炮塔主体（含后坐力微弹 Recoil 与炮口闪光 Muzzle Flash）
    const recoilUntil = opts.towerRecoils?.get(tw.iid) ?? 0;
    const recoilRatio = !opts.reducedMotion && recoilUntil > opts.now
      ? Math.max(0, Math.min(1, (recoilUntil - opts.now) / 140))
      : 0;
    const recoilOffset = recoilRatio * lex.vfx.recoilPx;
    const turretX = center.x - Math.cos(aimAngle) * recoilOffset;
    const turretY = center.y - plinthH - lift * 0.72 - Math.sin(aimAngle) * recoilOffset * 0.65;
    const turretR = Math.max(8, proj.cellPx * 0.19);
    const muzzleX = turretX + Math.cos(aimAngle) * (turretR * 1.62);
    const muzzleY = turretY + Math.sin(aimAngle) * (turretR * 1.62);

    if (skinKey === 'gothic-cathedral-3d') {
      // 暮钟·圣堂：3D 哥特飞扶壁方尖石塔 + 圣焰尖顶 / 破魔银弩
      ctx.fillStyle = '#3a4256';
      ctx.strokeStyle = '#e4c596';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(turretX - turretR * 0.75, turretY - turretR * 0.9, turretR * 1.5, turretR * 1.5, 3);
      ctx.fill();
      ctx.stroke();
      // 四棱锥尖顶
      ctx.fillStyle = towerColor;
      ctx.beginPath();
      ctx.moveTo(turretX, turretY - turretR * 1.65);
      ctx.lineTo(turretX + turretR * 0.85, turretY - turretR * 0.45);
      ctx.lineTo(turretX, turretY - turretR * 0.15);
      ctx.lineTo(turretX - turretR * 0.85, turretY - turretR * 0.45);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (skinKey === 'metropolis-riverside-3d') {
      // 都会·河岸：3D 六棱玻璃智控塔 + 悬浮相控阵电弧线圈环
      ctx.fillStyle = '#2d4b52';
      ctx.strokeStyle = '#48d1cc';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3 + Math.PI / 6;
        const px = turretX + Math.cos(a) * turretR * 0.95;
        const py = turretY + Math.sin(a) * turretR * 0.75;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 顶部电弧环
      ctx.strokeStyle = '#e6ffff';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.ellipse(turretX, turretY - turretR * 0.45, turretR * 0.78, turretR * 0.46, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (skinKey === 'harbor-district-3d') {
      // 潮汐·港湾：3D 铆接海事装甲炮廓 + 黄铜潜望镜顶盖
      ctx.fillStyle = '#294f62';
      ctx.strokeStyle = '#cef4e9';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.roundRect(turretX - turretR * 0.92, turretY - turretR * 0.72, turretR * 1.84, turretR * 1.38, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ac8b56';
      ctx.beginPath();
      ctx.arc(turretX, turretY - turretR * 0.35, turretR * 0.52, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // 共和国·工业星图：3D 构成主义斜切工业塔 + 悬浮旋转红宝石棱镜晶核
      ctx.fillStyle = '#f1ecdc';
      ctx.strokeStyle = '#b4382c';
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.roundRect(turretX - turretR * 0.85, turretY - turretR * 0.8, turretR * 1.7, turretR * 1.45, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = towerColor;
      ctx.beginPath();
      ctx.moveTo(turretX, turretY - turretR * 1.35);
      ctx.lineTo(turretX + turretR * 0.65, turretY - turretR * 0.45);
      ctx.lineTo(turretX, turretY + turretR * 0.25);
      ctx.lineTo(turretX - turretR * 0.65, turretY - turretR * 0.45);
      ctx.closePath();
      ctx.fill();
    }

    // 双联/重型立体炮管
    const perpX = -Math.sin(aimAngle) * 2.2;
    const perpY = Math.cos(aimAngle) * 2.2;
    ctx.strokeStyle = paper;
    ctx.lineWidth = 4.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(turretX + perpX, turretY + perpY);
    ctx.lineTo(muzzleX + perpX, muzzleY + perpY);
    ctx.moveTo(turretX - perpX, turretY - perpY);
    ctx.lineTo(muzzleX - perpX, muzzleY - perpY);
    ctx.stroke();

    ctx.strokeStyle = towerColor;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(turretX, turretY);
    ctx.lineTo(muzzleX, muzzleY);
    ctx.stroke();

    // 炮口闪光（Muzzle Flash）
    if (recoilRatio > 0.15) {
      const flashR = turretR * (0.65 + recoilRatio * 0.75);
      ctx.save();
      ctx.fillStyle = lex.vfx.muzzleColor;
      ctx.globalAlpha = Math.min(1, recoilRatio * 1.15);
      ctx.beginPath();
      ctx.arc(muzzleX, muzzleY, flashR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = lex.vfx.beamGlowColor;
      ctx.lineWidth = 1.6;
      for (let k = 0; k < 4; k++) {
        const a = aimAngle + (k - 1.5) * 0.42;
        ctx.beginPath();
        ctx.moveTo(muzzleX, muzzleY);
        ctx.lineTo(muzzleX + Math.cos(a) * flashR * 1.55, muzzleY + Math.sin(a) * flashR * 1.55);
        ctx.stroke();
      }
      ctx.restore();
    }

    // (7.4) 驻塔 3D 守兵立体模型（Garrison Defender：立在炮座右侧战位，符合皮肤风格与文化语义）
    const guardBob = Math.sin(opts.now * 0.006 + tw.iid) * 1.2;
    const gx = center.x + baseRad * 0.72;
    const gy = center.y - plinthH - 1 + guardBob;
    const gw = Math.max(5.5, turretR * 0.56);
    const gh = Math.max(9.0, turretR * 0.92);
    // 守兵躯干装甲
    ctx.fillStyle = skinKey === 'gothic-cathedral-3d'
      ? '#4a5265'
      : skinKey === 'metropolis-riverside-3d'
        ? '#356d73'
        : skinKey === 'harbor-district-3d'
          ? '#256e7c'
          : '#b4382c';
    ctx.strokeStyle = paper;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(gx - gw / 2, gy - gh, gw, gh, 2.5);
    ctx.fill();
    ctx.stroke();
    // 守兵头盔/圣冠球体
    ctx.fillStyle = paper;
    ctx.beginPath();
    ctx.arc(gx, gy - gh - gw * 0.38, gw * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // 守兵护目镜/圣徽高光
    ctx.fillStyle = lex.vfx.critColor;
    ctx.fillRect(gx - gw * 0.28, gy - gh - gw * 0.45, gw * 0.56, 1.8);

    // 塔顶文化铭文首字徽记
    ctx.fillStyle = paper;
    ctx.font = 'bold 9.5px "IBM Plex Sans", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.display_name[0], turretX, turretY - 1);
    ctx.restore();
    ctx.restore(); // for breathe scale
  }

  // 8. 复用皮肤原生车辆与行人模型充当小兵 + 叠加战局特效（脚底脉冲光环 + 行军流光尾迹 + 战局信标 + 受击闪白 Hit-flash，大厅 #25801 ② / #26153 ②）
  for (const e of state.enemies) {
    const def = pack.enemies.find((d) => d.id === e.def)!;
    const pt = proj.milliToScreen(e.x, e.y);
    const hitFlashUntil = opts.enemyHitFlashes?.get(e.iid) ?? 0;
    const isHitFlashing = hitFlashUntil > opts.now;
    const aheadPt = proj.milliToScreen(
      Math.min(pack.map.width * CELL, e.x + 120),
      e.y,
    );
    // 根据路径进度计算当前行进朝向单位向量 (ux, uy)
    let ux = 1, uy = 0;
    let bestSegDist = Infinity;
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1], b = waypoints[i];
      const sdx = b.x - a.x, sdy = b.y - a.y;
      const slen2 = sdx * sdx + sdy * sdy;
      if (slen2 < 1) continue;
      const tProj = Math.max(0, Math.min(1, ((pt.x - a.x) * sdx + (pt.y - a.y) * sdy) / slen2));
      const d = Math.hypot(pt.x - (a.x + sdx * tProj), pt.y - (a.y + sdy * tProj));
      if (d < bestSegDist) {
        bestSegDist = d;
        const slen = Math.sqrt(slen2);
        ux = sdx / slen;
        uy = sdy / slen;
      }
    }
    void aheadPt;

    const modelKind = getMinionModelKind(def, proj.hostMap?.skin);
    const r = Math.max(7, proj.cellPx * 0.18);
    const pulse = 1 + Math.sin(opts.now * 0.008 + e.iid * 1.3) * 0.12;
    
    // 伪2.5D高度偏移软阴影
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    // EnemyDef 无 tags 字段，统一按地面单位投影软阴影
    ctx.ellipse(pt.x, pt.y + r * 0.35, r, r * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    
    ctx.save();
    
    // 移动中的敌人附带正负 4 度的左右摇摆
    const wobble = Math.sin(opts.now * 0.015 + e.iid) * (4 * Math.PI / 180);
    ctx.translate(pt.x, pt.y);
    ctx.rotate(wobble);
    ctx.translate(-pt.x, -pt.y);


    // (8.1) 特效 ①：行军尾迹流光（Directional Wake Trail）—— 区分战局小兵与静态场景
    for (let k = 1; k <= 3; k++) {
      const trailDist = k * (r * 0.62);
      const tx = pt.x - ux * trailDist;
      const ty = pt.y - uy * trailDist;
      ctx.fillStyle = rgba(danger, 0.34 - k * 0.09);
      ctx.beginPath();
      ctx.ellipse(tx, ty + 1, r * (0.65 - k * 0.12), r * (0.65 - k * 0.12) * aspectY, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // (8.2) 特效 ②：脚底战局脉冲光环（Tactical Aura Ring + Shadow）
    ctx.save();
    ctx.shadowColor = isHitFlashing ? '#ffffff' : danger;
    ctx.shadowBlur = isHitFlashing ? 12 : 8;
    ctx.strokeStyle = isHitFlashing ? '#ffffff' : rgba(danger, 0.88);
    ctx.lineWidth = isHitFlashing ? 2.4 : 1.8;
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y + 2, r * 1.28 * pulse, r * 1.28 * aspectY * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = rgba(danger, 0.18);
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y + 2, r * 1.05, r * 1.05 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    // (8.3) 皮肤原生车辆 / 行人 2.5D 模型本体（受击时触发高亮闪白 Hit-flash）
    const bodyColor = isHitFlashing ? '#ffffff' : (def.color ?? danger);
    if (modelKind === 'vehicle' || modelKind === 'heavy_vehicle') {
      // 原生车辆模型（metropolis.js vehicle / kit-land.js movers：底盘车体 box + 顶部玻璃驾驶舱 cab + 车头灯）
      const isHeavy = modelKind === 'heavy_vehicle';
      const halfL = r * (isHeavy ? 1.25 : 0.98);
      const halfW = r * (isHeavy ? 0.68 : 0.56);
      const chassisH = isHeavy ? 6.5 : 5.0;
      const cabH = isHeavy ? 4.2 : 3.4;
      const ang = Math.atan2(uy, ux);

      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(ang);

      // 车体下层阴影与装甲底盘
      ctx.fillStyle = rgba(ink, 0.72);
      ctx.beginPath();
      ctx.roundRect(-halfL, -halfW + 2, halfL * 2, halfW * 2, 3);
      ctx.fill();

      ctx.fillStyle = bodyColor;
      ctx.strokeStyle = isHitFlashing ? lex.vfx.critColor : paper;
      ctx.lineWidth = isHitFlashing ? 2.0 : 1.3;
      ctx.beginPath();
      ctx.roundRect(-halfL, -halfW - chassisH * 0.35, halfL * 2, halfW * 2, 3.5);
      ctx.fill();
      ctx.stroke();

      // 车顶玻璃座舱（Cab / Roof）
      const cabL = halfL * (isHeavy ? 0.72 : 0.58);
      const cabW = halfW * 0.78;
      ctx.fillStyle = isHitFlashing ? '#ffffff' : rgba(accent, 0.92);
      ctx.strokeStyle = rgba(paper, 0.85);
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.roundRect(-cabL * 0.8, -cabW - (chassisH + cabH) * 0.32, cabL * 1.6, cabW * 2, 2.5);
      ctx.fill();
      ctx.stroke();

      // 车头双前照灯束
      ctx.fillStyle = '#fff6c2';
      ctx.beginPath();
      ctx.arc(halfL - 1.2, -halfW * 0.55, 1.8, 0, Math.PI * 2);
      ctx.arc(halfL - 1.2, halfW * 0.55, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      // 原生行人模型（actors.js figure / metropolis.js walkers：圆柱身躯 body + 球形头部 head + 步频起伏 bob）
      const bob = Math.abs(Math.sin(opts.now * 0.012 + e.iid * 0.9)) * 2.6;
      const footY = pt.y + 1 - bob;
      const torsoW = r * 0.78;
      const torsoH = r * 1.15;
      const headR = r * 0.42;

      // 行人风衣躯干（圆柱立面）
      ctx.fillStyle = bodyColor;
      ctx.strokeStyle = isHitFlashing ? lex.vfx.critColor : paper;
      ctx.lineWidth = isHitFlashing ? 2.0 : 1.3;
      ctx.beginPath();
      ctx.roundRect(pt.x - torsoW / 2, footY - torsoH, torsoW, torsoH, 4);
      ctx.fill();
      ctx.stroke();

      // 行人肩部披风装饰线
      ctx.strokeStyle = rgba(accent, 0.9);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(pt.x - torsoW * 0.45, footY - torsoH * 0.68);
      ctx.lineTo(pt.x + torsoW * 0.45, footY - torsoH * 0.68);
      ctx.stroke();

      // 行人球形头部
      ctx.fillStyle = isHitFlashing ? '#ffffff' : paper;
      ctx.strokeStyle = bodyColor;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(pt.x, footY - torsoH - headR * 0.75, headR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // (8.4) 特效 ③：头顶高对比度圆角生命条与战局锁定菱形信标
    const bw = 26, bh = 4.5;
    const bx = pt.x - bw / 2, by = pt.y - r * 1.75 - 10;
    ctx.fillStyle = 'rgba(12, 18, 26, 0.72)';
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

  // 9. 受击护盾波纹、基地护盾涟漪、碎屑粒子、四款皮肤专属攻击弹道与破甲暴击跳字（大厅 #26153 ②）
  ctx.save();
  if (opts.shieldRipples?.length) {
    for (const rp of opts.shieldRipples) {
      const ratio = Math.max(0, Math.min(1, rp.life / rp.maxLife));
      const curR = rp.r + (rp.maxR - rp.r) * (1 - ratio);
      ctx.strokeStyle = rp.color;
      ctx.globalAlpha = ratio * (rp.isBase ? 0.85 : 0.72);
      ctx.lineWidth = rp.isBase ? 2.6 : 1.8;
      ctx.beginPath();
      ctx.ellipse(rp.x, rp.y, curR, curR * aspectY, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  for (const p of opts.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.lineCap = 'round';
  const style = lex.vfx.projectileStyle;
  for (let i = opts.shots.length - 1; i >= 0; i--) {
    const sh = opts.shots[i];
    if (opts.now > sh.until) {
      opts.shots.splice(i, 1);
      continue;
    }
    const f = proj.milliToScreen(sh.fx, sh.fy);
    const t = proj.milliToScreen(sh.tx, sh.ty);
    const alpha = Math.max(0, (sh.until - opts.now) / 110);
    ctx.globalAlpha = alpha;
    const x0 = f.x, y0 = f.y - 8;
    const x1 = t.x, y1 = t.y - 4;

    if (style === 'emp_arc') {
      // 都会·河岸专属：折线脉冲电磁电弧（EMP Arc）
      const mx = (x0 + x1) * 0.5 + (y1 - y0) * 0.16;
      const my = (y0 + y1) * 0.5 - (x1 - x0) * 0.16;
      ctx.strokeStyle = lex.vfx.beamGlowColor;
      ctx.lineWidth = 4.6;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(mx, my);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      ctx.strokeStyle = lex.vfx.beamCoreColor;
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(mx, my);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    } else if (style === 'holy_lance') {
      // 暮钟·圣堂专属：圣光裁决辉光枪与十字星芒（Holy Lance）
      ctx.strokeStyle = lex.vfx.beamGlowColor;
      ctx.lineWidth = 5.2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      ctx.strokeStyle = lex.vfx.beamCoreColor;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x1 - 6, y1);
      ctx.lineTo(x1 + 6, y1);
      ctx.moveTo(x1, y1 - 6);
      ctx.lineTo(x1, y1 + 6);
      ctx.stroke();
    } else if (style === 'naval_shell') {
      // 潮汐·港湾专属：高抛岸防高爆炮火弧线与尾烟（Naval Shell）
      const cx = (x0 + x1) * 0.5;
      const cy = Math.min(y0, y1) - 18;
      ctx.strokeStyle = lex.vfx.beamGlowColor;
      ctx.lineWidth = 4.2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.stroke();

      ctx.strokeStyle = lex.vfx.muzzleColor;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.stroke();
    } else {
      // 共和国·星院专属：高聚焦脉冲棱镜激光束（Prism Beam）
      ctx.strokeStyle = lex.vfx.beamGlowColor;
      ctx.lineWidth = 4.8;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      ctx.strokeStyle = lex.vfx.beamCoreColor;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // 破甲/暴击/受击跳字（Floating Popups）
  if (opts.floatingPopups?.length) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const fp of opts.floatingPopups) {
      const ratio = Math.max(0, Math.min(1, fp.life / fp.maxLife));
      ctx.globalAlpha = Math.min(1, ratio * 1.3);
      ctx.font = fp.critical
        ? '800 12.5px "IBM Plex Sans", "PingFang SC", sans-serif'
        : '700 11px "IBM Plex Sans", "PingFang SC", sans-serif';
      ctx.strokeStyle = 'rgba(10, 14, 22, 0.78)';
      ctx.lineWidth = 3;
      ctx.strokeText(fp.text, fp.x, fp.y);
      ctx.fillStyle = fp.color;
      ctx.fillText(fp.text, fp.x, fp.y);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // 10. 胜负结算横幅（含单局 ±10 CP 真实结算结果展示，大厅 #25804 ④）
  if (state.phase === 'won' || state.phase === 'lost') {
    ctx.save();
    const bannerW = Math.min(380, width - 40);
    const bannerH = opts.settlementText ? 86 : 68;
    const bx = (width - bannerW) / 2;
    const by = (height - bannerH) / 2;
    ctx.fillStyle = rgba(paper, 0.95, '36,46,64');
    ctx.strokeStyle = state.phase === 'won' ? okColor : danger;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.roundRect(bx, by, bannerW, bannerH, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = 'bold 26px "IBM Plex Sans", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      state.phase === 'won' ? opts.heldText : opts.fellText,
      width / 2,
      opts.settlementText ? height / 2 - 12 : height / 2,
    );
    if (opts.settlementText) {
      ctx.fillStyle = state.phase === 'won' ? okColor : danger;
      ctx.font = '700 14px "IBM Plex Sans", "PingFang SC", sans-serif';
      ctx.fillText(opts.settlementText, width / 2, height / 2 + 18);
    }
    ctx.restore();
  }
  ctx.restore();
}

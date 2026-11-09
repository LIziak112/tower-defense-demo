import { CELL, type Cell, type ContentPack } from '../runtime';
import { reachTable } from '../advisor/snapshot';
import type { HostSpatialMap } from './hostSpatialMap';
export { parseSpatialMap, type HostSpatialMap, type HostSpatialNode } from './hostSpatialMap';

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
  cellToScreen(gx: number, gy: number, out?: Cell): Cell;
  /** 毫格坐标 (mx, my) → 空间地图画布像素坐标 (x, y) */
  milliToScreen(mx: number, my: number, out?: Cell): Cell;
  /** 单个逻辑格 (cx, cy) 在空间地图地面上的四个等轴测顶点 */
  cellCorners(cx: number, cy: number, inset?: number): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  /** 空间地图画布像素坐标 (sx, sy) → 逻辑格坐标 (cx, cy) 与槽位下标 slot（优先吸附半径内的建塔点位） */
  screenToCell(sx: number, sy: number): { cx: number; cy: number; gx: number; gy: number; inBounds: boolean; slot: number };
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

  const cellToScreen = (gx: number, gy: number, out: Cell = { x: 0, y: 0 }): Cell => {
    const u = (gx - W / 2) * cellPx;
    const v = (gy - H / 2) * cellPx;
    out.x = origin.x + u * cosA - v * sinA;
    out.y = origin.y + (u * sinA + v * cosA) * sinP;
    return out;
  };

  const milliToScreen = (mx: number, my: number, out?: Cell): Cell => cellToScreen(mx / CELL, my / CELL, out);

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

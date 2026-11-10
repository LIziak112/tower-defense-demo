// 世界坐标战场（大厅 #27514 根治）：把宿主地图的真实道路网变成一局塔防的战场。
//
// 以前的做法是在屏幕上按百分比排一条折线、再把逻辑棋盘按弧长贴上去——地图一缩放 / 旋转，战场就和地图脱开。
// 现在反过来：宿主把场景的真实几何（道路中心线、建筑占位、水域）用世界坐标给过来（hikos:map 的 world 字段），
// 这里在道路图上选路线、在路边真实空地上排塔位，直接生成「自由几何」的 MapDef（runtime/types.ts 的 free）：
// 模拟跑在真实几何上（射程按世界距离算，所见即所算），画面由宿主画进它自己的 3D 场景（td:field / td:frame）。
//
// 纯函数、确定性（不读时钟、不用 Math.random）、不碰 DOM：vitest 直接测。

import type { Cell, ContentPack, MapDef } from '../runtime/types';
import { CELL, milliOf, pathLength, pathSamples } from '../runtime/sim';

/** 世界坐标点 [x, y, z]；y = null 表示「地面高度由宿主按场景取」（入口引道、塔位） */
export type WorldPt = [number, number | null, number];

export interface WorldRoad {
  id: string;
  /** avenue / street / boulevard / quay / bridge / ring / radial / path / pontoon … 只用于呈现与日志 */
  kind: string;
  /** 路面宽度（世界单位） */
  w: number;
  /** 中心线折线，y = 路面高度 */
  pts: [number, number, number][];
  /** 场景里原本没有、开战时由宿主搭出来的连接段（如港湾的浮桥） */
  virtual?: boolean;
}
export interface WorldPlace {
  key: string;
  kind: 'home' | 'landmark' | 'entity';
  label: string;
  x: number;
  z: number;
  /** 占位半径（世界单位） */
  r: number;
}
export interface HostWorldMap {
  v: number;
  skin: string | null;
  layout: string | null;
  scene: string | null;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  roads: WorldRoad[];
  places: WorldPlace[];
  /** 其它不能压的东西（装饰建筑、行道树…）：[x, z, r] */
  blocks: [number, number, number][];
  /** 水域带：中心线 + 宽度 */
  water: { pts: [number, number][]; w: number }[];
  /** 有这个字段时，塔位必须落在其中一块陆地矩形里 [minX, minZ, maxX, maxZ]（港湾：只有码头是陆地） */
  land: [number, number, number, number][] | null;
}

const LIM = { roads: 256, pts: 200, places: 160, blocks: 2400, water: 32, land: 96, coord: 1e5 };
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIM.coord;
const str = (v: unknown, max: number, fb = ''): string => (typeof v === 'string' ? v.slice(0, max) : fb);

/** 校验并规整宿主送来的 world（不可信输入：只留有限数字、限量、限长）。不合法 / 没有道路时返回 null（退回旧的屏幕坐标模式）。 */
export function parseWorldMap(raw: unknown): HostWorldMap | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const b = (m.bounds && typeof m.bounds === 'object' ? m.bounds : {}) as Record<string, unknown>;
  const roads: WorldRoad[] = [];
  for (const r0 of Array.isArray(m.roads) ? m.roads.slice(0, LIM.roads) : []) {
    if (!r0 || typeof r0 !== 'object') continue;
    const r = r0 as Record<string, unknown>;
    const pts: [number, number, number][] = [];
    for (const p of Array.isArray(r.pts) ? r.pts.slice(0, LIM.pts) : []) {
      if (Array.isArray(p) && fin(p[0]) && fin(p[1]) && fin(p[2])) pts.push([p[0], p[1], p[2]]);
    }
    const w = fin(r.w) ? Math.max(0.4, Math.min(40, r.w)) : 0;
    if (pts.length >= 2 && w > 0) roads.push({ id: str(r.id, 48, `r${roads.length}`), kind: str(r.kind, 24, 'street'), w, pts, ...(r.virtual === true ? { virtual: true } : {}) });
  }
  if (!roads.length) return null;
  const places: WorldPlace[] = [];
  for (const p0 of Array.isArray(m.places) ? m.places.slice(0, LIM.places) : []) {
    if (!p0 || typeof p0 !== 'object') continue;
    const p = p0 as Record<string, unknown>;
    if (!fin(p.x) || !fin(p.z)) continue;
    const kind = p.kind === 'home' || p.kind === 'landmark' ? p.kind : 'entity';
    places.push({ key: str(p.key, 96, `p${places.length}`), kind, label: str(p.label, 48), x: p.x, z: p.z, r: fin(p.r) ? Math.max(0.5, Math.min(40, p.r)) : 3 });
  }
  const blocks: [number, number, number][] = [];
  for (const c of Array.isArray(m.blocks) ? m.blocks.slice(0, LIM.blocks) : []) {
    if (Array.isArray(c) && fin(c[0]) && fin(c[1]) && fin(c[2]) && c[2] > 0) blocks.push([c[0], c[1], Math.min(60, c[2])]);
  }
  const water: HostWorldMap['water'] = [];
  for (const w0 of Array.isArray(m.water) ? m.water.slice(0, LIM.water) : []) {
    if (!w0 || typeof w0 !== 'object') continue;
    const w = w0 as Record<string, unknown>;
    const pts: [number, number][] = [];
    for (const p of Array.isArray(w.pts) ? w.pts.slice(0, LIM.pts) : []) if (Array.isArray(p) && fin(p[0]) && fin(p[1])) pts.push([p[0], p[1]]);
    if (pts.length >= 2 && fin(w.w) && w.w > 0) water.push({ pts, w: Math.min(400, w.w) });
  }
  let land: HostWorldMap['land'] = null;
  if (Array.isArray(m.land)) {
    land = [];
    for (const q of m.land.slice(0, LIM.land)) if (Array.isArray(q) && fin(q[0]) && fin(q[1]) && fin(q[2]) && fin(q[3]) && q[2] > q[0] && q[3] > q[1]) land.push([q[0], q[1], q[2], q[3]]);
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of roads) for (const p of r.pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]); }
  return {
    v: fin(m.v) ? m.v : 2,
    skin: typeof m.skin === 'string' ? m.skin.slice(0, 64) : null,
    layout: typeof m.layout === 'string' ? m.layout.slice(0, 64) : null,
    scene: typeof m.scene === 'string' ? m.scene.slice(0, 64) : null,
    bounds: {
      minX: fin(b.minX) ? Math.min(b.minX, minX) : minX, maxX: fin(b.maxX) ? Math.max(b.maxX, maxX) : maxX,
      minZ: fin(b.minZ) ? Math.min(b.minZ, minZ) : minZ, maxZ: fin(b.maxZ) ? Math.max(b.maxZ, maxZ) : maxZ,
    },
    roads, places, blocks, water, land,
  };
}

// ------------------------------------------------------------------------------------------------ 道路图

interface GNode { x: number; z: number; y: number }
interface GEdge { a: number; b: number; len: number; w: number; virtual: boolean; road: number; dead?: boolean }
export interface RoadGraph { nodes: GNode[]; edges: GEdge[]; adj: number[][] }

const MERGE = 0.3;
const dist2 = (ax: number, az: number, bx: number, bz: number) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

/** 点到线段的最近点参数与距离（XZ 平面） */
function projectOn(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { t: number; d: number; x: number; z: number } {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  const x = ax + dx * t, z = az + dz * t;
  return { t, d: Math.sqrt(dist2(px, pz, x, z)), x, z };
}

/** 把道路折线拆成图：交叉口、丁字口（端点落在另一条路的路面里）都成为节点。 */
export function buildRoadGraph(roads: WorldRoad[]): RoadGraph {
  interface Seg { road: number; ax: number; ay: number; az: number; bx: number; by: number; bz: number; w: number; virtual: boolean; len: number; cuts: number[] }
  const segs: Seg[] = [];
  roads.forEach((r, ri) => {
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i], len = Math.sqrt(dist2(a[0], a[2], b[0], b[2]));
      if (len < 1e-6) continue;
      segs.push({ road: ri, ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], w: r.w, virtual: !!r.virtual, len, cuts: [0, 1] });
    }
  });
  const nodes: GNode[] = [];
  const nodeAt = (x: number, z: number, y: number): number => {
    for (let i = 0; i < nodes.length; i++) if (dist2(nodes[i].x, nodes[i].z, x, z) <= MERGE * MERGE) return i;
    nodes.push({ x, z, y });
    return nodes.length - 1;
  };
  const edges: GEdge[] = [];
  const addEdge = (a: number, b: number, w: number, virtual: boolean, road: number) => {
    if (a === b) return;
    if (edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))) return;
    edges.push({ a, b, len: Math.sqrt(dist2(nodes[a].x, nodes[a].z, nodes[b].x, nodes[b].z)), w, virtual, road });
  };
  const links: { ax: number; ay: number; az: number; bx: number; by: number; bz: number; w: number; virtual: boolean; road: number }[] = [];
  for (let i = 0; i < segs.length; i++) {
    const A = segs[i];
    for (let j = i + 1; j < segs.length; j++) {
      const B = segs[j];
      const tol = Math.max(0.6, 0.5 * Math.max(A.w, B.w));
      // 包围盒快速排除
      if (Math.min(A.ax, A.bx) - tol > Math.max(B.ax, B.bx) || Math.max(A.ax, A.bx) + tol < Math.min(B.ax, B.bx)) continue;
      if (Math.min(A.az, A.bz) - tol > Math.max(B.az, B.bz) || Math.max(A.az, A.bz) + tol < Math.min(B.az, B.bz)) continue;
      const d1x = A.bx - A.ax, d1z = A.bz - A.az, d2x = B.bx - B.ax, d2z = B.bz - B.az;
      const den = d1x * d2z - d1z * d2x;
      if (Math.abs(den) > 1e-9 * A.len * B.len) {
        const qx = B.ax - A.ax, qz = B.az - A.az;
        const t = (qx * d2z - qz * d2x) / den, s = (qx * d1z - qz * d1x) / den;
        const ta = tol / A.len, sa = tol / B.len;
        if (t >= -ta && t <= 1 + ta && s >= -sa && s <= 1 + sa) {
          const tc = Math.max(0, Math.min(1, t)), sc = Math.max(0, Math.min(1, s));
          A.cuts.push(tc); B.cuts.push(sc);
          const pax = A.ax + d1x * tc, paz = A.az + d1z * tc, pbx = B.ax + d2x * sc, pbz = B.az + d2z * sc;
          if (dist2(pax, paz, pbx, pbz) > MERGE * MERGE) {
            links.push({ ax: pax, ay: A.ay + (A.by - A.ay) * tc, az: paz, bx: pbx, by: B.by + (B.by - B.ay) * sc, bz: pbz, w: Math.min(A.w, B.w), virtual: A.virtual && B.virtual, road: B.road });
          }
        }
      } else {
        // 平行 / 共线：只把落在对方路面里的端点接上（首尾相接的两条路）
        for (const [P, Q] of [[A, B], [B, A]] as const) {
          for (const [ex, ey, ez] of [[Q.ax, Q.ay, Q.az], [Q.bx, Q.by, Q.bz]] as const) {
            const pr = projectOn(ex, ez, P.ax, P.az, P.bx, P.bz);
            if (pr.d <= tol * 0.5) {
              P.cuts.push(pr.t);
              if (pr.d > MERGE) links.push({ ax: pr.x, ay: P.ay + (P.by - P.ay) * pr.t, az: pr.z, bx: ex, by: ey, bz: ez, w: Math.min(P.w, Q.w), virtual: P.virtual && Q.virtual, road: Q.road });
            }
          }
        }
      }
    }
  }
  for (const S of segs) {
    const ts = [...new Set(S.cuts.map((t) => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b);
    let prev = -1;
    for (const t of ts) {
      const n = nodeAt(S.ax + (S.bx - S.ax) * t, S.az + (S.bz - S.az) * t, S.ay + (S.by - S.ay) * t);
      if (prev >= 0) addEdge(prev, n, S.w, S.virtual, S.road);
      prev = n;
    }
  }
  for (const l of links) addEdge(nodeAt(l.ax, l.az, l.ay), nodeAt(l.bx, l.bz, l.by), l.w, l.virtual, l.road);
  return withAdj({ nodes, edges, adj: [] });
}

function withAdj(g: RoadGraph): RoadGraph {
  g.adj = g.nodes.map(() => []);
  g.edges.forEach((e, i) => { if (!e.dead) { g.adj[e.a].push(i); g.adj[e.b].push(i); } });
  return g;
}

/** 把一个点接到图上最近的路面：必要时把那条边一分为二，返回节点下标与距离。 */
function attach(g: RoadGraph, x: number, z: number, opts: { allowVirtual?: boolean } = {}): { node: number; d: number } | null {
  let best = -1, bt = 0, bd = Infinity, bxp = 0, bzp = 0;
  g.edges.forEach((e, i) => {
    if (e.dead || (e.virtual && !opts.allowVirtual)) return;
    const a = g.nodes[e.a], b = g.nodes[e.b];
    const pr = projectOn(x, z, a.x, a.z, b.x, b.z);
    if (pr.d < bd - 1e-9) { bd = pr.d; best = i; bt = pr.t; bxp = pr.x; bzp = pr.z; }
  });
  if (best < 0) return null;
  const e = g.edges[best], a = g.nodes[e.a], b = g.nodes[e.b];
  if (dist2(bxp, bzp, a.x, a.z) <= 1) return { node: e.a, d: bd };
  if (dist2(bxp, bzp, b.x, b.z) <= 1) return { node: e.b, d: bd };
  g.nodes.push({ x: bxp, z: bzp, y: a.y + (b.y - a.y) * bt });
  const n = g.nodes.length - 1;
  e.dead = true;
  for (const [p, q] of [[e.a, n], [n, e.b]]) g.edges.push({ a: p, b: q, len: Math.sqrt(dist2(g.nodes[p].x, g.nodes[p].z, g.nodes[q].x, g.nodes[q].z)), w: e.w, virtual: e.virtual, road: e.road });
  withAdj(g);
  return { node: n, d: bd };
}

/** Dijkstra（图很小，数组实现）。cost(edgeIndex) 给每条边的额外倍率。 */
function shortest(g: RoadGraph, from: number, mul?: (edge: number) => number): { dist: number[]; prevEdge: number[] } {
  const n = g.nodes.length, dist = new Array<number>(n).fill(Infinity), prevEdge = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false);
  dist[from] = 0;
  for (;;) {
    let u = -1, du = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < du) { du = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = true;
    for (const ei of g.adj[u]) {
      const e = g.edges[ei], v = e.a === u ? e.b : e.a;
      const c = e.len * (e.virtual ? 1.2 : 1) * (mul ? mul(ei) : 1);
      if (du + c < dist[v] - 1e-9) { dist[v] = du + c; prevEdge[v] = ei; }
    }
  }
  return { dist, prevEdge };
}
function tracePath(g: RoadGraph, sp: { prevEdge: number[] }, from: number, to: number): number[] | null {
  const out: number[] = [];
  let cur = to, guard = g.nodes.length + 2;
  while (cur !== from && guard-- > 0) {
    const ei = sp.prevEdge[cur];
    if (ei < 0) return null;
    out.push(ei);
    const e = g.edges[ei];
    cur = e.a === cur ? e.b : e.a;
  }
  return cur === from ? out.reverse() : null;
}

// ------------------------------------------------------------------------------------------------ 路线

export interface FieldRoute {
  /** 世界折线（含起终点的入口引道）；y = null 的点由宿主取地面高度 */
  pts: WorldPt[];
  /** 每个点处的路面宽度 */
  wd: number[];
  /** 世界长度 */
  len: number;
}
export interface FieldPad { x: number; z: number; /** 所在路线（0 主线，1.. 分支） */ branch: number; /** 沿路线的世界弧长 */ s: number; side: 1 | -1 }
export interface FieldAnchor { label: string; key: string | null; x: number; z: number }
export interface WorldField {
  /** 内容指纹：宿主据此判断是不是同一块战场（同一块就不重建三维物件） */
  id: string;
  /** 1 逻辑格 = unit 世界单位；世界 x = ox + 毫格/1000 × unit */
  unit: number;
  ox: number;
  oz: number;
  routes: FieldRoute[];
  pads: FieldPad[];
  spawn: FieldAnchor;
  /** 分支路线的起点（没有分支时为 null） */
  spawn2: FieldAnchor | null;
  base: FieldAnchor;
  /** 给模拟用的自由几何地图（path / branch_paths / buildable_cells 都是这块战场的真实几何） */
  map: Pick<MapDef, 'width' | 'height' | 'path' | 'branch_paths' | 'buildable_cells' | 'free' | 'world'>;
}

export interface FieldOptions {
  /** 战役模板的主线长度（格）：路线按它选长度，行军时间与原设计一致 */
  pathCells: number;
  /** 关卡号：同一张地图不同关换起点 / 走法 */
  level?: number;
  /** 期望的每格世界单位（缺省 5）；实际值按路线长度在 [3.2, 6.8] 里取 */
  unit?: number;
  /** 塔位上限（缺省 24） */
  maxPads?: number;
}

interface Cand { spawnNode: number; place: WorldPlace | null; edges: number[]; len: number; score: number }

const PAD_R = 1.0;          // 塔座占地半径（世界单位）
const PAD_GAP = 1.35;       // 塔位离路缘的距离

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** 从边序列还原节点序列（起点 from） */
function nodesOf(g: RoadGraph, from: number, edges: number[]): number[] {
  const out = [from];
  let cur = from;
  for (const ei of edges) { const e = g.edges[ei]; cur = e.a === cur ? e.b : e.a; out.push(cur); }
  return out;
}

/** 折线清理：去重合点、并共线点、给拐角倒角（单位在三维里不是瞬间直角掉头） */
function tidy(pts: WorldPt[], wd: number[]): { pts: WorldPt[]; wd: number[] } {
  const P: WorldPt[] = [], W: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (P.length && dist2(P[P.length - 1][0], P[P.length - 1][2], p[0], p[2]) < 0.04) continue;
    P.push(p); W.push(wd[i]);
  }
  // 并共线
  for (let i = P.length - 2; i >= 1; i--) {
    const a = P[i - 1], b = P[i], c = P[i + 1];
    const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - b[0], vz = c[2] - b[2];
    const cross = ux * vz - uz * vx, dot = ux * vx + uz * vz;
    if (dot > 0 && Math.abs(cross) <= 0.012 * Math.sqrt((ux * ux + uz * uz) * (vx * vx + vz * vz)) && (a[1] === null) === (b[1] === null) && (b[1] === null) === (c[1] === null) && Math.abs(W[i] - W[i - 1]) < 1e-6) {
      P.splice(i, 1); W.splice(i, 1);
    }
  }
  // 倒角
  const outP: WorldPt[] = [P[0]], outW: number[] = [W[0]];
  for (let i = 1; i < P.length - 1; i++) {
    const a = P[i - 1], b = P[i], c = P[i + 1];
    const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - b[0], vz = c[2] - b[2];
    const lu = Math.sqrt(ux * ux + uz * uz), lv = Math.sqrt(vx * vx + vz * vz);
    const cos = (ux * vx + uz * vz) / (lu * lv);
    const d = Math.min(Math.max(0.8, Math.min(2.2, 0.35 * W[i])), 0.4 * lu, 0.4 * lv);
    if (cos < 0.9 && d > 0.25) {
      outP.push([b[0] - (ux / lu) * d, b[1], b[2] - (uz / lu) * d]); outW.push(W[i - 1]);
      outP.push([b[0] + (vx / lv) * d, b[1], b[2] + (vz / lv) * d]); outW.push(W[i]);
    } else { outP.push(b); outW.push(W[i]); }
  }
  if (P.length > 1) { outP.push(P[P.length - 1]); outW.push(W[W.length - 1]); }
  return { pts: outP, wd: outW };
}

function polyLen(pts: WorldPt[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.sqrt(dist2(pts[i - 1][0], pts[i - 1][2], pts[i][0], pts[i][2]));
  return l;
}

/** 沿折线弧长 s 处的位置、方向与所在段的路宽 */
export function routePoint(route: { pts: WorldPt[]; wd: number[] }, s: number): { x: number; y: number | null; z: number; dx: number; dz: number; w: number; seg: number; approach: boolean } {
  const P = route.pts;
  let left = Math.max(0, s);
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], l = Math.sqrt(dist2(a[0], a[2], b[0], b[2]));
    if (left <= l || i === P.length - 1) {
      const t = l > 1e-9 ? Math.min(1, left / l) : 0;
      const y = a[1] === null || b[1] === null ? (a[1] === null ? b[1] : a[1]) : a[1] + (b[1] - a[1]) * t;
      return { x: a[0] + (b[0] - a[0]) * t, y, z: a[2] + (b[2] - a[2]) * t, dx: l > 1e-9 ? (b[0] - a[0]) / l : 1, dz: l > 1e-9 ? (b[2] - a[2]) / l : 0, w: route.wd[i - 1], seg: i - 1, approach: a[1] === null || b[1] === null };
    }
    left -= l;
  }
  const e = P[P.length - 1];
  return { x: e[0], y: e[1], z: e[2], dx: 1, dz: 0, w: route.wd[route.wd.length - 1] ?? 3, seg: Math.max(0, P.length - 2), approach: e[1] === null };
}

/** 从宿主世界地图生成一块战场；路网不通 / 找不到合适路线时返回 null（调用方退回旧模式）。 */
export function buildWorldField(world: HostWorldMap, opts: FieldOptions): WorldField | null {
  const g = buildRoadGraph(world.roads);
  if (g.edges.length < 2) return null;
  const level = Math.max(1, Math.floor(opts.level ?? 1));
  const uPref = Math.max(3.2, Math.min(6.8, opts.unit ?? 5));
  const Lt = Math.max(60, opts.pathCells * uPref);

  // —— 终点：home（母星 / 中心建筑）最近的路面；没有 home 就取路网中心
  const cx = (world.bounds.minX + world.bounds.maxX) / 2, cz = (world.bounds.minZ + world.bounds.maxZ) / 2;
  const home = world.places.find((p) => p.kind === 'home')
    ?? [...world.places].sort((a, b) => dist2(a.x, a.z, cx, cz) - dist2(b.x, b.z, cx, cz))[0]
    ?? null;
  const baseAt = attach(g, home ? home.x : cx, home ? home.z : cz, { allowVirtual: true });
  if (!baseAt) return null;
  const baseNode = baseAt.node;

  // —— 起点候选：远离终点的原生建筑（各自接到最近的路面），再加路网尽头
  interface SpawnC { node: number; place: WorldPlace | null }
  const spawnC: SpawnC[] = [];
  const seen = new Set<number>([baseNode]);
  const far = world.places
    .filter((p) => p !== home)
    .map((p) => ({ p, d: dist2(p.x, p.z, g.nodes[baseNode].x, g.nodes[baseNode].z) }))
    .sort((a, b) => b.d - a.d || (a.p.key < b.p.key ? -1 : 1))
    .slice(0, 10);
  for (const f of far) {
    const at = attach(g, f.p.x, f.p.z);
    if (!at || at.d > f.p.r + 14 || seen.has(at.node)) continue;
    seen.add(at.node);
    spawnC.push({ node: at.node, place: f.p });
  }
  const fromBase = shortest(g, baseNode);
  const ends = g.nodes.map((_, i) => i)
    .filter((i) => !seen.has(i) && Number.isFinite(fromBase.dist[i]) && g.adj[i].length === 1 && !g.edges[g.adj[i][0]].virtual)
    .sort((a, b) => fromBase.dist[b] - fromBase.dist[a] || a - b)
    .slice(0, 6);
  for (const n of ends) spawnC.push({ node: n, place: null });
  if (!spawnC.length) {
    const any = g.nodes.map((_, i) => i).filter((i) => i !== baseNode && Number.isFinite(fromBase.dist[i])).sort((a, b) => fromBase.dist[b] - fromBase.dist[a] || a - b)[0];
    if (any === undefined) return null;
    spawnC.push({ node: any, place: null });
  }

  // —— 候选路线：直达；太短就绕一个途经点把长度凑到目标（第二段避开第一段走过的边）
  const cands: Cand[] = [];
  const lenOf = (edges: number[]) => edges.reduce((a, ei) => a + g.edges[ei].len, 0);
  const push = (c: SpawnC, edges: number[]) => {
    const len = lenOf(edges);
    if (len < Math.min(40, Lt * 0.35)) return;
    const used = new Set<number>();
    let dup = 0;
    for (const ei of edges) { if (used.has(ei)) dup += g.edges[ei].len; used.add(ei); }
    const virt = edges.reduce((a, ei) => a + (g.edges[ei].virtual ? g.edges[ei].len : 0), 0);
    const score = Math.abs(len - Lt) / Lt + 3 * (dup / len) + 0.35 * (virt / len) + (c.place ? 0 : 0.2);
    cands.push({ spawnNode: c.node, place: c.place, edges, len, score });
  };
  for (const c of spawnC) {
    if (!Number.isFinite(fromBase.dist[c.node])) continue;
    const fromSpawn = shortest(g, c.node);
    const direct = tracePath(g, fromSpawn, c.node, baseNode);
    if (!direct) continue;
    push(c, direct);
    if (lenOf(direct) >= 0.75 * Lt) continue;
    const vias = g.nodes.map((_, i) => i)
      .filter((i) => i !== c.node && i !== baseNode && Number.isFinite(fromSpawn.dist[i]) && Number.isFinite(fromBase.dist[i]) && fromSpawn.dist[i] > 0.2 * Lt && fromBase.dist[i] > 0.15 * Lt)
      .map((i) => ({ i, off: Math.abs(fromSpawn.dist[i] + fromBase.dist[i] - Lt) }))
      .sort((a, b) => a.off - b.off || a.i - b.i)
      .slice(0, 4);
    for (const v of vias) {
      const leg1 = tracePath(g, fromSpawn, c.node, v.i);
      if (!leg1) continue;
      const used = new Set(leg1);
      const fromVia = shortest(g, v.i, (ei) => (used.has(ei) ? 12 : 1));
      const leg2 = tracePath(g, fromVia, v.i, baseNode);
      if (leg2) push(c, [...leg1, ...leg2]);
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.score - b.score || a.spawnNode - b.spawnNode || a.len - b.len);
  // 同一个起点只留最好的一条进「轮换池」；按关卡号轮换，前几名质量相近
  const pool: Cand[] = [];
  for (const c of cands) if (!pool.some((p) => p.spawnNode === c.spawnNode)) pool.push(c);
  const good = pool.filter((c) => c.score <= pool[0].score + 0.45).slice(0, 3);
  const main = good[(level - 1) % good.length];

  // —— 分支：另一个起点的侧翼路线，在终点前汇入主线（重合 ≈ 四成：前段各守各的，后段一座塔两路都照得到）
  const mainSet = new Set(main.edges);
  const shared = (c: Cand) => c.edges.reduce((a, ei) => a + (mainSet.has(ei) ? g.edges[ei].len : 0), 0) / Math.min(c.len, main.len);
  const branch = cands
    .filter((c) => c !== main && c.spawnNode !== main.spawnNode && c.len >= 0.5 * main.len && c.len <= 1.6 * main.len && shared(c) >= 0.12 && shared(c) <= 0.72)
    .sort((a, b) => (Math.abs(shared(a) - 0.42) + a.score * 0.4) - (Math.abs(shared(b) - 0.42) + b.score * 0.4) || a.spawnNode - b.spawnNode)[0]
    ?? cands
      .filter((c) => c !== main && c.spawnNode !== main.spawnNode && c.len >= 0.5 * main.len && c.len <= 1.6 * main.len && shared(c) < 0.9)
      .sort((a, b) => (shared(b) - shared(a)) || a.score - b.score || a.spawnNode - b.spawnNode)[0]
    ?? null;

  // —— 折线：起点建筑门口 → 路面 → … → 终点建筑门口
  const toRoute = (c: Cand): FieldRoute => {
    const ns = nodesOf(g, c.spawnNode, c.edges);
    const pts: WorldPt[] = [], wd: number[] = [];
    const first = g.nodes[ns[0]];
    if (c.place) {
      const d = Math.sqrt(dist2(c.place.x, c.place.z, first.x, first.z));
      if (d - c.place.r > 0.8) { pts.push([c.place.x + ((first.x - c.place.x) / d) * c.place.r, null, c.place.z + ((first.z - c.place.z) / d) * c.place.r]); wd.push(1.8); }
    }
    ns.forEach((n, i) => {
      const nd = g.nodes[n];
      pts.push([nd.x, nd.y, nd.z]);
      wd.push(g.edges[c.edges[Math.min(i, c.edges.length - 1)]].w);
    });
    const last = g.nodes[ns[ns.length - 1]];
    if (home) {
      const d = Math.sqrt(dist2(home.x, home.z, last.x, last.z));
      if (d - home.r > 0.8) { wd[wd.length - 1] = 1.8; pts.push([home.x + ((last.x - home.x) / d) * home.r, null, home.z + ((last.z - home.z) / d) * home.r]); wd.push(1.8); }
    }
    const t = tidy(pts, wd);
    return { pts: t.pts.map((p) => [r2(p[0]), p[1] === null ? null : r2(p[1]), r2(p[2])] as WorldPt), wd: t.wd.map(r2), len: polyLen(t.pts) };
  };
  const routes: FieldRoute[] = [toRoute(main)];
  if (branch) routes.push(toRoute(branch));

  // —— 每格多少世界单位：让主线格数 ≈ 战役模板（行军时间不变）
  const unit = r3(Math.max(3.2, Math.min(6.8, routes[0].len / Math.max(8, opts.pathCells))));

  // —— 塔位：沿路线两侧、路缘外侧的真实空地
  const roadSegs: { ax: number; az: number; bx: number; bz: number; w: number }[] = [];
  const branchSet = new Set(branch ? branch.edges : []);
  g.edges.forEach((e, ei) => {
    // 没被路线用到的「虚拟」连接段（浮桥）并不存在，不占地方
    if (e.dead || (e.virtual && !mainSet.has(ei) && !branchSet.has(ei))) return;
    roadSegs.push({ ax: g.nodes[e.a].x, az: g.nodes[e.a].z, bx: g.nodes[e.b].x, bz: g.nodes[e.b].z, w: e.w });
  });
  for (const rt of routes) for (let i = 1; i < rt.pts.length; i++) if (rt.pts[i - 1][1] === null || rt.pts[i][1] === null) {
    roadSegs.push({ ax: rt.pts[i - 1][0], az: rt.pts[i - 1][2], bx: rt.pts[i][0], bz: rt.pts[i][2], w: 1.8 });
  }
  const B = world.bounds;
  const clear = (x: number, z: number): boolean => {
    if (x < B.minX - 2 || x > B.maxX + 2 || z < B.minZ - 2 || z > B.maxZ + 2) return false;
    if (world.land && !world.land.some((q) => x >= q[0] + PAD_R && x <= q[2] - PAD_R && z >= q[1] + PAD_R && z <= q[3] - PAD_R)) return false;
    for (const s of roadSegs) if (projectOn(x, z, s.ax, s.az, s.bx, s.bz).d < s.w / 2 + PAD_R * 0.9) return false;
    for (const w of world.water) for (let i = 1; i < w.pts.length; i++) if (projectOn(x, z, w.pts[i - 1][0], w.pts[i - 1][1], w.pts[i][0], w.pts[i][1]).d < w.w / 2 + PAD_R) return false;
    for (const p of world.places) if (dist2(x, z, p.x, p.z) < (p.r + PAD_R) * (p.r + PAD_R)) return false;
    for (const c of world.blocks) if (dist2(x, z, c[0], c[1]) < (c[2] + PAD_R) * (c[2] + PAD_R)) return false;
    return true;
  };
  const maxPads = Math.max(6, Math.min(40, opts.maxPads ?? 24));
  const pads: FieldPad[] = [];
  const minGap2 = (1.15 * unit) * (1.15 * unit);
  const tryPad = (rt: FieldRoute, branchIdx: number, s: number, side: 1 | -1): boolean => {
    const p = routePoint(rt, s);
    for (const extra of [0, 0.9, 1.8]) {
      const off = p.w / 2 + PAD_GAP + extra;
      const x = r2(p.x - p.dz * off * side), z = r2(p.z + p.dx * off * side);
      if (!clear(x, z) || pads.some((q) => dist2(q.x, q.z, x, z) < minGap2)) continue;
      pads.push({ x, z, branch: branchIdx, s: r2(s), side });
      return true;
    }
    return false;
  };
  routes.forEach((rt, bi) => {
    const step = 1.5 * unit, quota = bi === 0 ? maxPads - (routes.length > 1 ? Math.min(8, Math.floor(maxPads / 3)) : 0) : maxPads;
    let k = 0;
    for (let s = 1.4 * unit; s <= rt.len - 1.0 * unit && pads.length < quota; s += step, k++) {
      const side: 1 | -1 = k % 2 === 0 ? 1 : -1;
      if (!tryPad(rt, bi, s, side) && !tryPad(rt, bi, s, side === 1 ? -1 : 1) && !tryPad(rt, bi, s + step / 2, side)) tryPad(rt, bi, s + step / 2, side === 1 ? -1 : 1);
    }
  });
  if (pads.length < 4) return null;
  // 槽位号 = 沿主线从前到后（分支上的排在后面）：军师说的「前段 / 后段」和画面一致
  pads.sort((a, b) => a.branch - b.branch || a.s - b.s);

  // —— 逻辑坐标：世界 → 格（小数 3 位）
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const rt of routes) for (const p of rt.pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]); }
  for (const p of pads) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const ox = Math.floor(minX - 2 * unit), oz = Math.floor(minZ - 2 * unit);
  const cell = (x: number, z: number): Cell => ({ x: r3((x - ox) / unit - 0.5), y: r3((z - oz) / unit - 0.5) });
  const cells = (rt: FieldRoute): Cell[] => {
    const out: Cell[] = [];
    for (const p of rt.pts) {
      const c = cell(p[0], p[2]);
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.x - c.x) < 0.002 && Math.abs(prev.y - c.y) < 0.002) continue;
      out.push(c);
    }
    return out;
  };
  const path = cells(routes[0]);
  if (path.length < 2) return null;
  const branch_paths = routes.slice(1).map(cells).filter((p) => p.length >= 2);
  const buildable_cells = pads.map((p) => cell(p.x, p.z));
  const anchor = (place: WorldPlace | null, rt: FieldRoute, end: boolean): FieldAnchor => {
    const p = rt.pts[end ? rt.pts.length - 1 : 0];
    return { label: place?.label ?? '', key: place?.key ?? null, x: p[0], z: p[2] };
  };
  const map: WorldField['map'] = {
    width: Math.ceil((maxX - ox) / unit) + 2,
    height: Math.ceil((maxZ - oz) / unit) + 2,
    path,
    ...(branch_paths.length ? { branch_paths } : {}),
    buildable_cells,
    free: true,
    world: { unit, ox, oz },
  };
  const id = hash32(JSON.stringify([world.skin, world.scene, unit, ox, oz, routes.map((r) => r.pts), pads.map((p) => [p.x, p.z])])).toString(16).padStart(8, '0');
  return {
    id, unit, ox, oz, routes, pads,
    spawn: anchor(main.place, routes[0], false),
    spawn2: branch && routes[1] ? anchor(branch.place, routes[1], false) : null,
    base: anchor(home, routes[0], true),
    map,
  };
}

// ------------------------------------------------------------------------------------------------ 内容包

/** 射程覆盖的平均水平（最好的 n 个塔位、第一种塔，主线与分支都算）：衡量「一座塔能照到多少路」 */
function coverage(map: Pick<MapDef, 'path' | 'branch_paths' | 'buildable_cells'>, range: number, n = 8): number {
  const pts = [map.path, ...(map.branch_paths ?? [])].flatMap((p) => pathSamples(p));
  const scores = map.buildable_cells
    .map((c) => { const sx = milliOf(c.x), sy = milliOf(c.y); return pts.filter((p) => (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy) <= range * range).length; })
    .sort((a, b) => b - a)
    .slice(0, n);
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

/**
 * 把战役内容包搬到真实战场上：换掉地图几何，塔 / 敌人 / 波次原样。
 * 真实街道是长直线，一座塔照不到模板里那种来回折返的两三段路，所以按「覆盖率之比」把敌人血量等比调低（下限 0.45），
 * 让同一关在真实地图上的难度与设计时相当；比值 ≥ 1 时不加血。
 */
export function packForField(pack: ContentPack, field: WorldField): ContentPack {
  const range = pack.towers[0]?.range ?? 2600;
  const before = coverage(pack.map, range), after = coverage(field.map, range);
  const hpScale = before > 0 && after > 0 ? Math.max(0.45, Math.min(1, after / before)) : 1;
  return {
    ...pack,
    enemies: hpScale === 1 ? pack.enemies : pack.enemies.map((e) => ({ ...e, hp: Math.max(1, Math.round(e.hp * hpScale)) })),
    map: { ...field.map, base_hp: pack.map.base_hp, starting_gold: pack.map.starting_gold },
  };
}

/** 模拟坐标（毫格）→ 世界坐标 */
export function milliToWorld(field: Pick<WorldField, 'unit' | 'ox' | 'oz'>, mx: number, my: number): { x: number; z: number } {
  return { x: field.ox + (mx / CELL) * field.unit, z: field.oz + (my / CELL) * field.unit };
}

/** 路线上某个进度（毫格）对应的世界弧长：按总长归一，终点对齐 */
export function progressToArc(pathMilli: number, routeLen: number, progress: number): number {
  return pathMilli > 0 ? Math.max(0, Math.min(routeLen, (progress / pathMilli) * routeLen)) : 0;
}

export { pathLength };

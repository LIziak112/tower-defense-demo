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

/** Dijkstra（图很小，数组实现）。mul(edgeIndex) 给每条边的额外倍率；ban 里的节点不许经过。 */
function shortest(g: RoadGraph, from: number, mul?: (edge: number) => number, ban?: Set<number>): { dist: number[]; prevEdge: number[] } {
  const n = g.nodes.length, dist = new Array<number>(n).fill(Infinity), prevEdge = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false);
  dist[from] = 0;
  for (;;) {
    let u = -1, du = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < du) { du = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = true;
    for (const ei of g.adj[u]) {
      const e = g.edges[ei], v = e.a === u ? e.b : e.a;
      if (ban && ban.has(v)) continue;
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

/** 路段标记（FieldRoute.fl）：引道 = 从路面走到建筑门口的那一小段；浮桥 = 场景里原本没有、开战时宿主搭出来的连接段 */
export const SEG_APPROACH = 1, SEG_VIRTUAL = 2;

export interface FieldRoute {
  /** 世界折线（含起终点的入口引道）；y 只是宿主导出的参考值，画面上的高度一律由宿主按场景取（null = 没有参考值） */
  pts: WorldPt[];
  /** 从第 i 个点出发的那一段的路面宽度 */
  wd: number[];
  /** 从第 i 个点出发的那一段的标记（SEG_APPROACH | SEG_VIRTUAL） */
  fl: number[];
  /** 世界长度 */
  len: number;
}
export interface FieldPad { x: number; z: number; /** 所在路线（0 主线，1.. 分支） */ branch: number; /** 沿路线的世界弧长 */ s: number; side: 1 | -1 }
export interface FieldAnchor { label: string; key: string | null; x: number; z: number }
export interface WorldField {
  /** 内容指纹：宿主据此判断是不是同一块战场（同一块就不重建三维物件） */
  id: string;
  /** 1 逻辑格 = unit 世界单位；世界 x = ox + 毫格/1000 × unit。塔、敌人、塔座的三维尺寸也按它定。 */
  unit: number;
  ox: number;
  oz: number;
  /** 塔座占地半径（世界单位） */
  padR: number;
  routes: FieldRoute[];
  pads: FieldPad[];
  spawn: FieldAnchor;
  /** 分支路线的起点（没有分支时为 null） */
  spawn2: FieldAnchor | null;
  base: FieldAnchor;
  /** 主线实际格数 ÷ 战役模板格数：敌人速度按它缩放，行军时间与原设计一致 */
  paceK: number;
  /** 给模拟用的自由几何地图（path / branch_paths / buildable_cells 都是这块战场的真实几何） */
  map: Pick<MapDef, 'width' | 'height' | 'path' | 'branch_paths' | 'buildable_cells' | 'free' | 'world'>;
}

export interface FieldOptions {
  /** 战役模板的主线长度（格）：路线按它选长度，行军时间与原设计一致 */
  pathCells: number;
  /** 关卡号：同一张地图不同关换起点 / 走法 */
  level?: number;
  /** 每格多少世界单位（缺省 5 ≈ 一栋楼的宽度；塔、敌人的三维尺寸跟着它） */
  unit?: number;
  /** 塔位上限（缺省 24） */
  maxPads?: number;
}

interface Cand { spawnNode: number; place: WorldPlace | null; clear: boolean; edges: number[]; len: number; score: number }

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

interface Poly { pts: WorldPt[]; wd: number[]; fl: number[] }

/** 引道接上路面的倒角：靠引道那一端收进路缘以内这么多（世界单位；坐标取两位小数后仍在路面内） */
const JOIN_INSET = 0.05;

/**
 * 折线清理：去重合点、并共线点、给拐角倒角（单位在三维里不是瞬间直角掉头）。
 *
 * 倒角 = 从拐点沿两边各退一段再连起来，倒角线算路面段。两边都是路面时，退的两段都在路的中心线上，倒角线在路面内。
 * 引道与路面相接的拐角不一样：引道那一边退出去的点在引道线上，路窄的时候（港口栈道宽 1）它还没进路面，
 * 倒角线就有一截露在路缘外面。所以这种拐角引道那一边只退到路缘以内 JOIN_INSET 处；倒角线两端都在这条路的路面里，
 * 路面是凸的，整条倒角线也就在路面里。引道那一端本来就在路面内的（路够宽），原样不动。
 *
 * joinInside = false 时不做这一步收窄（两边照旧退一样远），只用来排塔位，见 buildWorldField 里的 layouts。
 * 返回值的 inset：这条折线上有没有拐角被收窄过。
 */
function tidy(inp: Poly, joinInside = true): Poly & { inset: boolean } {
  const P: WorldPt[] = [], W: number[] = [], F: number[] = [];
  for (let i = 0; i < inp.pts.length; i++) {
    const p = inp.pts[i];
    if (P.length && dist2(P[P.length - 1][0], P[P.length - 1][2], p[0], p[2]) < 0.04) { W[W.length - 1] = inp.wd[i]; F[F.length - 1] = inp.fl[i]; continue; }
    P.push(p); W.push(inp.wd[i]); F.push(inp.fl[i]);
  }
  // 并共线（同宽、同标记的相邻两段）
  for (let i = P.length - 2; i >= 1; i--) {
    const a = P[i - 1], b = P[i], c = P[i + 1];
    const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - b[0], vz = c[2] - b[2];
    const cross = ux * vz - uz * vx, dot = ux * vx + uz * vz;
    if (dot > 0 && Math.abs(cross) <= 0.012 * Math.sqrt((ux * ux + uz * uz) * (vx * vx + vz * vz)) && F[i] === F[i - 1] && Math.abs(W[i] - W[i - 1]) < 1e-6) {
      P.splice(i, 1); W.splice(i, 1); F.splice(i, 1);
    }
  }
  // 倒角
  const out: Poly & { inset: boolean } = { pts: [P[0]], wd: [W[0]], fl: [F[0]], inset: false };
  for (let i = 1; i < P.length - 1; i++) {
    const a = P[i - 1], b = P[i], c = P[i + 1];
    const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - b[0], vz = c[2] - b[2];
    const lu = Math.sqrt(ux * ux + uz * uz), lv = Math.sqrt(vx * vx + vz * vz);
    const cos = (ux * vx + uz * vz) / (lu * lv);
    const d = Math.min(Math.max(0.8, Math.min(2.2, 0.35 * Math.min(W[i - 1], W[i]))), 0.4 * lu, 0.4 * lv);
    // du / dv：进来那一边、出去那一边各退多远。一般两边相同；引道与路面相接时，引道那一边不退出路面
    let du = d, dv = d;
    const apU = (F[i - 1] & SEG_APPROACH) !== 0, apV = (F[i] & SEG_APPROACH) !== 0;
    if (joinInside && apU !== apV && cos < 0.9 && d > 0.25) {
      const half = (apU ? W[i] : W[i - 1]) / 2;   // 接上的那条路的半宽
      // 引道线上退出去的点离这段路的中心线多远：引道从这段路的侧面 / 前方来，量到中心线的垂距；从这段路的起点背后来，量到拐点
      const slope = cos <= 0 ? Math.abs(ux * vz - uz * vx) / (lu * lv) : 1;
      if (d * slope > half + 1e-9) {
        const inside = Math.max(0, half - JOIN_INSET) / slope;
        if (apU) du = inside; else dv = inside;
        out.inset = true;
      }
    }
    // 收窄后退不出 0.25 的（路窄于 0.6）就不倒角：引道走到中心线上再拐
    if (cos < 0.9 && Math.min(du, dv) > 0.25) {
      out.pts.push([b[0] - (ux / lu) * du, b[1], b[2] - (uz / lu) * du]); out.wd.push(Math.min(W[i - 1], W[i])); out.fl.push(F[i - 1] & F[i]);
      out.pts.push([b[0] + (vx / lv) * dv, b[1], b[2] + (vz / lv) * dv]); out.wd.push(W[i]); out.fl.push(F[i]);
    } else { out.pts.push(b); out.wd.push(W[i]); out.fl.push(F[i]); }
  }
  if (P.length > 1) { out.pts.push(P[P.length - 1]); out.wd.push(W[W.length - 2]); out.fl.push(F[F.length - 2]); }
  return out;
}

function polyLen(pts: WorldPt[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.sqrt(dist2(pts[i - 1][0], pts[i - 1][2], pts[i][0], pts[i][2]));
  return l;
}

/** 折线上离 (x, z) 最近的那一点的弧长 */
function arcNear(route: { pts: WorldPt[] }, x: number, z: number): number {
  const P = route.pts;
  let best = 0, bd = Infinity, cum = 0;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], l = Math.sqrt(dist2(a[0], a[2], b[0], b[2]));
    const pr = projectOn(x, z, a[0], a[2], b[0], b[2]);
    if (pr.d < bd - 1e-9) { bd = pr.d; best = cum + pr.t * l; }
    cum += l;
  }
  return best;
}

/**
 * 沿折线弧长 s 处的位置、方向与所在段的路宽 / 标记。
 * y 是宿主导出的参考路面高度（引道段两端有一端没有参考值时取另一端；都没有为 null）——画面上的真实高度以宿主为准。
 */
export function routePoint(route: { pts: WorldPt[]; wd: number[]; fl?: number[] }, s: number): { x: number; y: number | null; z: number; dx: number; dz: number; w: number; seg: number; approach: boolean; virtual: boolean } {
  const P = route.pts;
  let left = Math.max(0, s);
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], l = Math.sqrt(dist2(a[0], a[2], b[0], b[2]));
    if (left <= l || i === P.length - 1) {
      const t = l > 1e-9 ? Math.min(1, left / l) : 0, f = route.fl?.[i - 1] ?? 0;
      const y = a[1] === null || b[1] === null ? (a[1] === null ? b[1] : a[1]) : a[1] + (b[1] - a[1]) * t;
      return { x: a[0] + (b[0] - a[0]) * t, y, z: a[2] + (b[2] - a[2]) * t, dx: l > 1e-9 ? (b[0] - a[0]) / l : 1, dz: l > 1e-9 ? (b[2] - a[2]) / l : 0, w: route.wd[i - 1], seg: i - 1, approach: route.fl ? (f & SEG_APPROACH) !== 0 : a[1] === null || b[1] === null, virtual: (f & SEG_VIRTUAL) !== 0 };
    }
    left -= l;
  }
  const e = P[P.length - 1];
  return { x: e[0], y: e[1], z: e[2], dx: 1, dz: 0, w: route.wd[route.wd.length - 1] ?? 3, seg: Math.max(0, P.length - 2), approach: false, virtual: false };
}

/** 从宿主世界地图生成一块战场；路网不通 / 找不到合适路线时返回 null（调用方退回旧模式）。 */
export function buildWorldField(world: HostWorldMap, opts: FieldOptions): WorldField | null {
  const g = buildRoadGraph(world.roads);
  if (g.edges.length < 2) return null;
  const level = Math.max(1, Math.floor(opts.level ?? 1));
  const unit = r3(Math.max(3.2, Math.min(7.5, opts.unit ?? 5)));
  const pathCells = Math.max(8, opts.pathCells);
  const Lt = pathCells * unit;
  const padR = r2(Math.max(1.1, Math.min(2.1, 0.3 * unit)));

  // —— 建筑的「门口」：到路面的直线引道不能穿过别的建筑 / 装饰 / 水。先对原始路网算好接入点，再统一接进图里。
  interface Dock { x: number; z: number; d: number; clear: boolean }
  const edgeList = g.edges.map((e) => ({ ax: g.nodes[e.a].x, az: g.nodes[e.a].z, bx: g.nodes[e.b].x, bz: g.nodes[e.b].z, len: e.len, virtual: e.virtual }));
  const waterHit = (x: number, z: number, pad: number): boolean => {
    for (const w of world.water) for (let i = 1; i < w.pts.length; i++) if (projectOn(x, z, w.pts[i - 1][0], w.pts[i - 1][1], w.pts[i][0], w.pts[i][1]).d < w.w / 2 + pad) return true;
    return false;
  };
  const dock = (place: WorldPlace, allowVirtual: boolean): Dock | null => {
    const reach = place.r + 26;
    const near: [number, number, number][] = [];
    for (const p of world.places) if (p !== place && dist2(p.x, p.z, place.x, place.z) < (reach + p.r) * (reach + p.r)) near.push([p.x, p.z, p.r + 0.9]);
    for (const c of world.blocks) if (dist2(c[0], c[1], place.x, place.z) < (reach + c[2]) * (reach + c[2])) near.push([c[0], c[1], c[2] + 0.6]);
    let best: Dock | null = null;
    const better = (c: Dock) => !best || (c.clear !== best.clear ? c.clear : c.d < best.d - 1e-6);
    for (const e of edgeList) {
      if (e.virtual && !allowVirtual) continue;
      const pr = projectOn(place.x, place.z, e.ax, e.az, e.bx, e.bz);
      if (pr.d > reach) continue;
      const n = Math.max(1, Math.ceil(e.len / 1.5));
      for (let k = -1; k <= n; k++) {
        const t = k < 0 ? pr.t : k / n;
        const qx = e.ax + (e.bx - e.ax) * t, qz = e.az + (e.bz - e.az) * t;
        const d = Math.sqrt(dist2(qx, qz, place.x, place.z));
        if (d > reach) continue;
        let clear = true;
        if (d > place.r + 0.8) {
          const ex = place.x + ((qx - place.x) / d) * place.r, ez = place.z + ((qz - place.z) / d) * place.r;
          for (const o of near) if (projectOn(o[0], o[1], ex, ez, qx, qz).d < o[2]) { clear = false; break; }
          if (clear) for (let u = 0; u <= d - place.r; u += 1.2) if (waterHit(ex + ((qx - ex) / (d - place.r)) * u, ez + ((qz - ez) / (d - place.r)) * u, 0)) { clear = false; break; }
        }
        const c: Dock = { x: qx, z: qz, d, clear };
        if (better(c)) best = c;
      }
    }
    return best;
  };

  // —— 终点：home（母星 / 中心建筑）；没有 home 就取离路网中心最近的建筑
  const cx = (world.bounds.minX + world.bounds.maxX) / 2, cz = (world.bounds.minZ + world.bounds.maxZ) / 2;
  const home = world.places.find((p) => p.kind === 'home')
    ?? [...world.places].sort((a, b) => dist2(a.x, a.z, cx, cz) - dist2(b.x, b.z, cx, cz))[0]
    ?? null;
  const homeDock = home ? dock(home, true) : null;
  const spawnDocks = world.places
    .filter((p) => p !== home)
    .map((p) => ({ p, k: dock(p, false) }))
    .filter((d): d is { p: WorldPlace; k: Dock } => !!d.k && d.k.d <= d.p.r + 24);
  const baseAt = attach(g, homeDock ? homeDock.x : home ? home.x : cx, homeDock ? homeDock.z : home ? home.z : cz, { allowVirtual: true });
  if (!baseAt) return null;
  const baseNode = baseAt.node;

  // —— 起点候选：真实建筑（各自接到门口的路面）；一栋都接不上时才退到路网尽头
  interface SpawnC { node: number; place: WorldPlace | null; clear: boolean }
  const spawnC: SpawnC[] = [];
  const seen = new Set<number>([baseNode]);
  for (const d of spawnDocks.sort((a, b) => (a.k.clear === b.k.clear ? 0 : a.k.clear ? -1 : 1) || (a.p.key < b.p.key ? -1 : 1)).slice(0, g.nodes.length > 140 ? 12 : 18)) {
    const at = attach(g, d.k.x, d.k.z);
    if (!at || seen.has(at.node)) continue;
    seen.add(at.node);
    spawnC.push({ node: at.node, place: d.p, clear: d.k.clear });
  }
  const fromBase = shortest(g, baseNode);
  if (!spawnC.some((c) => Number.isFinite(fromBase.dist[c.node]))) {
    const ends = g.nodes.map((_, i) => i)
      .filter((i) => !seen.has(i) && Number.isFinite(fromBase.dist[i]) && g.adj[i].length === 1 && !g.edges[g.adj[i][0]].virtual)
      .sort((a, b) => fromBase.dist[b] - fromBase.dist[a] || a - b)
      .slice(0, 6);
    for (const n of ends) spawnC.push({ node: n, place: null, clear: true });
    if (!ends.length) {
      const any = g.nodes.map((_, i) => i).filter((i) => i !== baseNode && Number.isFinite(fromBase.dist[i])).sort((a, b) => fromBase.dist[b] - fromBase.dist[a] || a - b)[0];
      if (any === undefined) return null;
      spawnC.push({ node: any, place: null, clear: true });
    }
  }

  // —— 候选路线：都是不走回头路的简单路径。直达太短就绕一个（再不够两个）途经点，把长度凑到目标。
  // 途经点只在路网的「二核」里取：死胡同上的点进去就得原路退出来，不可能出现在简单路径的中间。
  const core = g.nodes.map(() => true);
  {
    const deg = g.adj.map((a) => a.length);
    const queue = deg.map((d, i) => (d <= 1 ? i : -1)).filter((i) => i >= 0);
    while (queue.length) {
      const u = queue.pop() as number;
      if (!core[u]) continue;
      core[u] = false;
      for (const ei of g.adj[u]) { const e = g.edges[ei], v = e.a === u ? e.b : e.a; if (core[v] && --deg[v] <= 1) queue.push(v); }
    }
  }
  const cands: Cand[] = [];
  const lenOf = (edges: number[]) => edges.reduce((a, ei) => a + g.edges[ei].len, 0);
  const push = (c: SpawnC, edges: number[]) => {
    const len = lenOf(edges);
    if (len < Math.min(40, Lt * 0.3) || len > Lt * 1.45) return;
    const ns = nodesOf(g, c.node, edges);
    if (new Set(ns).size !== ns.length) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, turns = 0;
    ns.forEach((n, i) => {
      const p = g.nodes[n];
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      if (i > 0 && i < ns.length - 1) {
        const a = g.nodes[ns[i - 1]], b = g.nodes[ns[i + 1]];
        const ux = p.x - a.x, uz = p.z - a.z, vx = b.x - p.x, vz = b.z - p.z;
        if ((ux * vx + uz * vz) / Math.sqrt((ux * ux + uz * uz) * (vx * vx + vz * vz) || 1) < 0.5) turns++;
      }
    });
    const virt = edges.reduce((a, ei) => a + (g.edges[ei].virtual ? g.edges[ei].len : 0), 0);
    const diag = Math.sqrt((maxX - minX) * (maxX - minX) + (maxZ - minZ) * (maxZ - minZ));
    // 长度贴近目标最重要；其次是紧凑（整块战场一屏看得全）、少搭浮桥、多几个弯（弯道是塔的好位置）、门口引道干净
    const score = 1.3 * Math.abs(len - Lt) / Lt + 0.5 * (diag / len) + 0.45 * (virt / len) - 0.03 * Math.min(6, turns) + (c.place ? 0 : 0.6) + (c.clear ? 0 : 0.25);
    cands.push({ spawnNode: c.node, place: c.place, clear: c.clear, edges, len, score });
  };
  for (const c of spawnC) {
    if (!Number.isFinite(fromBase.dist[c.node])) continue;
    const fromSpawn = shortest(g, c.node);
    const direct = tracePath(g, fromSpawn, c.node, baseNode);
    if (!direct) continue;
    const dLen = lenOf(direct);
    push(c, direct);
    if (dLen >= 0.92 * Lt) continue;
    const vias = g.nodes.map((_, i) => i)
      .filter((i) => core[i] && i !== c.node && i !== baseNode && Number.isFinite(fromSpawn.dist[i]) && Number.isFinite(fromBase.dist[i]))
      .map((i) => ({ i, sum: fromSpawn.dist[i] + fromBase.dist[i] }))
      .filter((v) => v.sum > dLen * 1.05 && v.sum <= 1.35 * Lt)
      .sort((a, b) => Math.abs(a.sum - Lt) - Math.abs(b.sum - Lt) || a.i - b.i)
      .slice(0, 14);
    const oneVia: { v: number; leg1: number[]; leg2: number[]; len: number }[] = [];
    for (const v of vias) {
      const leg1 = tracePath(g, fromSpawn, c.node, v.i);
      if (!leg1) continue;
      const ban = new Set(nodesOf(g, c.node, leg1)); ban.delete(v.i);
      const leg2 = tracePath(g, shortest(g, v.i, undefined, ban), v.i, baseNode);
      if (!leg2) continue;
      push(c, [...leg1, ...leg2]);
      oneVia.push({ v: v.i, leg1, leg2, len: lenOf(leg1) + lenOf(leg2) });
    }
    // 还短：在第二段上再绕一个途经点
    for (const o of oneVia.filter((q) => q.len < 0.8 * Lt).sort((a, b) => b.len - a.len || a.v - b.v).slice(0, 2)) {
      const ban1 = new Set(nodesOf(g, c.node, o.leg1)); ban1.delete(o.v);
      const fromVia = shortest(g, o.v, undefined, ban1);
      const l1 = lenOf(o.leg1);
      const more = g.nodes.map((_, i) => i)
        .filter((i) => core[i] && i !== baseNode && i !== o.v && !ban1.has(i) && Number.isFinite(fromVia.dist[i]) && Number.isFinite(fromBase.dist[i]))
        .map((i) => ({ i, sum: l1 + fromVia.dist[i] + fromBase.dist[i] }))
        .filter((w) => w.sum > o.len * 1.05 && w.sum <= 1.35 * Lt)
        .sort((a, b) => Math.abs(a.sum - Lt) - Math.abs(b.sum - Lt) || a.i - b.i)
        .slice(0, 6);
      for (const w of more) {
        const leg2 = tracePath(g, fromVia, o.v, w.i);
        if (!leg2) continue;
        const ban2 = new Set([...ban1, ...nodesOf(g, o.v, leg2)]); ban2.delete(w.i);
        const leg3 = tracePath(g, shortest(g, w.i, undefined, ban2), w.i, baseNode);
        if (leg3) push(c, [...o.leg1, ...leg2, ...leg3]);
      }
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.score - b.score || a.spawnNode - b.spawnNode || a.len - b.len);
  // 同一个起点只留最好的一条进「轮换池」；按关卡号轮换，前几名质量相近
  const pool: Cand[] = [];
  for (const c of cands) if (!pool.some((p) => p.spawnNode === c.spawnNode)) pool.push(c);
  const good = pool.filter((c) => c.score <= pool[0].score + 0.3).slice(0, 4);
  const main = good[(level - 1) % good.length];

  // —— 分支：另一个起点的侧翼路线，在终点前汇入主线（重合 ≈ 四成：前段各守各的，后段一座塔两路都照得到）
  const mainSet = new Set(main.edges);
  const shared = (c: Cand) => c.edges.reduce((a, ei) => a + (mainSet.has(ei) ? g.edges[ei].len : 0), 0) / Math.min(c.len, main.len);
  const sideOk = (c: Cand) => c !== main && c.spawnNode !== main.spawnNode && c.len >= 0.45 * main.len && c.len <= 1.35 * main.len;
  const branch = cands.filter((c) => sideOk(c) && shared(c) >= 0.12 && shared(c) <= 0.72)
    .sort((a, b) => (Math.abs(shared(a) - 0.42) + a.score * 0.4) - (Math.abs(shared(b) - 0.42) + b.score * 0.4) || a.spawnNode - b.spawnNode)[0]
    ?? cands.filter((c) => sideOk(c) && shared(c) < 0.9).sort((a, b) => (shared(b) - shared(a)) || a.score - b.score || a.spawnNode - b.spawnNode)[0]
    ?? null;

  // —— 折线：起点建筑门口 → 路面 → … → 终点建筑门口
  const cutInto = (poly: Poly, place: WorldPlace, atEnd: boolean): void => {
    // 路从建筑占位里穿过 / 绕着它走（地标压在街上、平台自带一圈边道）：终点停在第一次碰到占位圆的地方，起点从最后一次离开占位圆的地方出发
    const P = poly.pts, r = place.r + 0.15;
    const inside = (p: WorldPt) => dist2(p[0], p[2], place.x, place.z) < r * r;
    const cross = (a: WorldPt, b: WorldPt): WorldPt => {
      // a 在圆内、b 在圆外：线段与圆的交点
      const dx = b[0] - a[0], dz = b[2] - a[2], fx = a[0] - place.x, fz = a[2] - place.z;
      const A = dx * dx + dz * dz, B = 2 * (fx * dx + fz * dz), C = fx * fx + fz * fz - r * r;
      const disc = B * B - 4 * A * C;
      if (A < 1e-9 || disc < 0) return a;
      const t = Math.max(0, Math.min(1, (-B + Math.sqrt(disc)) / (2 * A)));
      return [a[0] + dx * t, a[1], a[2] + dz * t];
    };
    if (atEnd) {
      const i = P.findIndex((p, k) => k > 0 && inside(p));
      if (i < 1) return;
      const hit = inside(P[i - 1]) ? P[i - 1] : cross(P[i], P[i - 1]);
      P.length = i; poly.wd.length = i; poly.fl.length = i;
      P.push(hit); poly.wd.push(poly.wd[i - 1]); poly.fl.push(poly.fl[i - 1]);
    } else {
      let i = -1;
      for (let k = P.length - 2; k >= 0; k--) if (inside(P[k])) { i = k; break; }
      if (i < 0) return;
      const hit = cross(P[i], P[i + 1]);
      P.splice(0, i + 1, hit); poly.wd.splice(0, i); poly.fl.splice(0, i);
    }
  };
  const fieldRoute = (t: Poly): FieldRoute => ({ pts: t.pts.map((p) => [r2(p[0]), p[1] === null ? null : r2(p[1]), r2(p[2])] as WorldPt), wd: t.wd.map(r2), fl: t.fl, len: polyLen(t.pts) });
  /** route：敌人走的路线。layout：排塔位用的那一份——拐角没被收窄时就是 route 本身，见下面「塔位」 */
  const toRoute = (c: Cand): { route: FieldRoute; layout: FieldRoute } => {
    const ns = nodesOf(g, c.spawnNode, c.edges);
    const poly: Poly = { pts: [], wd: [], fl: [] };
    const first = g.nodes[ns[0]];
    let startGate = false, endGate = false;
    if (c.place) {
      const d = Math.sqrt(dist2(c.place.x, c.place.z, first.x, first.z));
      if (d - c.place.r > 0.8) { poly.pts.push([c.place.x + ((first.x - c.place.x) / d) * c.place.r, null, c.place.z + ((first.z - c.place.z) / d) * c.place.r]); poly.wd.push(1.8); poly.fl.push(SEG_APPROACH); startGate = true; }
    }
    ns.forEach((n, i) => {
      const nd = g.nodes[n], e = g.edges[c.edges[Math.min(i, c.edges.length - 1)]];
      poly.pts.push([nd.x, nd.y, nd.z]);
      poly.wd.push(e.w);
      poly.fl.push(e.virtual ? SEG_VIRTUAL : 0);
    });
    const last = g.nodes[ns[ns.length - 1]];
    if (home) {
      const d = Math.sqrt(dist2(home.x, home.z, last.x, last.z));
      if (d - home.r > 0.8) { poly.wd[poly.wd.length - 1] = 1.8; poly.fl[poly.fl.length - 1] = SEG_APPROACH; poly.pts.push([home.x + ((last.x - home.x) / d) * home.r, null, home.z + ((last.z - home.z) / d) * home.r]); poly.wd.push(1.8); poly.fl.push(SEG_APPROACH); endGate = true; }
    }
    if (c.place && !startGate) cutInto(poly, c.place, false);
    if (home && !endGate) cutInto(poly, home, true);
    const t = tidy(poly), route = fieldRoute(t);
    return { route, layout: t.inset ? fieldRoute(tidy(poly, false)) : route };
  };
  const built = [toRoute(main), ...(branch ? [toRoute(branch)] : [])];
  const routes: FieldRoute[] = built.map((b) => b.route);

  // —— 塔位：沿路线两侧、路缘外侧的真实空地
  // 塔位每隔一段路程排一个。引道拐角收窄会让路线在拐角里多走 0.1–0.2，要是照着路线的路程排，拐角后面整条路上的塔位都得跟着挪，
  // 挪过去正好不够间距的还会少掉一个。所以排位用的是没收窄的那份折线（layouts）：除了拐角里面那一小段，它和路线逐点重合，
  // 塔位落在哪里只看它；记在塔位上的路程 s 再换算成路线上的路程。
  const layouts: FieldRoute[] = built.map((b) => b.layout);
  const roadSegs: { ax: number; az: number; bx: number; bz: number; w: number }[] = [];
  const branchSet = new Set(branch ? branch.edges : []);
  g.edges.forEach((e, ei) => {
    // 没被路线用到的「虚拟」连接段（浮桥）并不存在，不占地方
    if (e.dead || (e.virtual && !mainSet.has(ei) && !branchSet.has(ei))) return;
    roadSegs.push({ ax: g.nodes[e.a].x, az: g.nodes[e.a].z, bx: g.nodes[e.b].x, bz: g.nodes[e.b].z, w: e.w });
  });
  for (const rt of routes) for (let i = 1; i < rt.pts.length; i++) if (rt.fl[i - 1] & SEG_APPROACH) {
    roadSegs.push({ ax: rt.pts[i - 1][0], az: rt.pts[i - 1][2], bx: rt.pts[i][0], bz: rt.pts[i][2], w: 1.8 });
  }
  const B = world.bounds;
  const clear = (x: number, z: number): boolean => {
    if (x < B.minX + padR || x > B.maxX - padR || z < B.minZ + padR || z > B.maxZ - padR) return false;
    if (world.land && !world.land.some((q) => x >= q[0] + padR && x <= q[2] - padR && z >= q[1] + padR && z <= q[3] - padR)) return false;
    for (const s of roadSegs) if (projectOn(x, z, s.ax, s.az, s.bx, s.bz).d < s.w / 2 + padR + 0.1) return false;
    if (waterHit(x, z, padR)) return false;
    for (const p of world.places) if (dist2(x, z, p.x, p.z) < (p.r + padR + 0.2) * (p.r + padR + 0.2)) return false;
    for (const c of world.blocks) if (dist2(x, z, c[0], c[1]) < (c[2] + padR) * (c[2] + padR)) return false;
    return true;
  };
  const maxPads = Math.max(6, Math.min(40, opts.maxPads ?? 24));
  const pads: FieldPad[] = [];
  const minGap2 = (1.2 * unit) * (1.2 * unit);
  const tryPad = (rt: FieldRoute, branchIdx: number, s0: number, side: 1 | -1): boolean => {
    for (const ds of [0, 0.3 * unit, -0.3 * unit, 0.6 * unit, -0.6 * unit]) {
      const s = s0 + ds;
      if (s < 0.6 * unit || s > rt.len - 0.5 * unit) continue;
      const p = routePoint(rt, s);
      if (p.virtual) continue;   // 浮桥旁边是水
      for (const extra of [0, 0.9, 1.8, 2.7]) {
        const off = p.w / 2 + padR + 0.3 + extra;
        const x = r2(p.x - p.dz * off * side), z = r2(p.z + p.dx * off * side);
        if (!clear(x, z) || pads.some((q) => dist2(q.x, q.z, x, z) < minGap2)) continue;
        pads.push({ x, z, branch: branchIdx, s: r2(rt === routes[branchIdx] ? s : arcNear(routes[branchIdx], p.x, p.z)), side });
        return true;
      }
    }
    return false;
  };
  layouts.forEach((rt, bi) => {
    const step = 1.5 * unit, quota = bi === 0 ? maxPads - (routes.length > 1 ? Math.min(8, Math.floor(maxPads / 3)) : 0) : maxPads;
    let k = 0;
    for (let s = 1.4 * unit; s <= rt.len - 1.0 * unit && pads.length < quota; s += step, k++) {
      const side: 1 | -1 = k % 2 === 0 ? 1 : -1;
      if (!tryPad(rt, bi, s, side)) tryPad(rt, bi, s, side === 1 ? -1 : 1);
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
  const id = hash32(JSON.stringify([world.skin, world.scene, unit, ox, oz, routes.map((r) => [r.pts, r.fl]), pads.map((p) => [p.x, p.z])])).toString(16).padStart(8, '0');
  return {
    id, unit, ox, oz, padR, routes, pads,
    spawn: anchor(main.place, routes[0], false),
    spawn2: branch && routes[1] ? anchor(branch.place, routes[1], false) : null,
    base: anchor(home, routes[0], true),
    paceK: r3(Math.max(0.55, Math.min(1.5, pathLength(path) / CELL / pathCells))),
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
 * 把战役内容包搬到真实战场上：换掉地图几何，塔 / 波次原样。
 * ① 真实路线的格数和模板不会正好相等：敌人速度按 paceK 缩放，从起点走到终点的时间与原设计一致；
 * ② 真实街道是长直线，一座塔照不到模板里那种来回折返的两三段路：按「敌人在射程里待的时间之比」把敌人血量等比调低（下限 0.45），
 *    同一关在真实地图上的难度与设计时相当；比值 ≥ 1 时不加血。
 */
export function packForField(pack: ContentPack, field: WorldField): ContentPack {
  const range = pack.towers[0]?.range ?? 2600;
  const k = field.paceK > 0 ? field.paceK : 1;
  const before = coverage(pack.map, range), after = coverage(field.map, range) / k;
  const hpScale = before > 0 && after > 0 ? Math.max(0.45, Math.min(1, after / before)) : 1;
  return {
    ...pack,
    enemies: pack.enemies.map((e) => ({ ...e, hp: Math.max(1, Math.round(e.hp * hpScale)), speed: Math.max(10, Math.round(e.speed * k)) })),
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

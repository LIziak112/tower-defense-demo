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

// Hikos 宿主桥接（postMessage v1）。契约：接入说明 01_1b297d9c §1.5–1.7；宿主实现 krowworker web/hikos/src/addons/arcade.js（PR #1638）。
// 游戏被宿主用 sandbox="allow-scripts" 的 iframe 嵌在 /arcade/tower-defense/：不透明源，没有 localStorage / cookie，所有状态只放内存。
// 宿主 → 游戏：首帧前走 URL query（v skin accent bg ink theme lang），运行中走 hikos:context / hikos:visibility / hikos:size / hikos:map / hikos:settle:reply。
// 游戏 → 宿主：td:ready {v} · td:state {state} · td:exit · td:resize {w,h} · td:settle:request {…} · td:battle {…}。
// 世界模式（大厅 #27514，docs/hikos-world-protocol.md）：hikos:context / hikos:map 的 map.world 带场景真实几何（世界坐标），
//   宿主每帧推 hikos:camera {seq, w, h, m[16], ppu, azimuth, pitch, zoom}；游戏回 td:field（战场）/ td:frame（每 tick 状态）/ td:camera（把画布上的手势交还给地图相机）；
//   宿主收到 td:field 后回 hikos:ground {field, pads[], routes[][], step?, profile?[][]}（按场景地形量出的真实高度，游戏拿去做拾取与跳字投影；
//   step / profile 是沿路高度剖面，宿主摆敌人用的那一组样点，0.9.2 起认）。
// 军师（任务 fb4d93bc，06 规格 §3）：游戏 → 宿主 td:advisor:request {reqId, kind, deadlineMs, stateVersion, snapshot, llm}；
//   宿主 → 游戏 hikos:advisor:reply {reqId, ok, payload | error, provider, latencyMs}；hikos:context 可多带 advisor {enabled, provider}（只增不改）。
//   宿主拿自己的凭据与路由去调模型；游戏只送极简决策快照与提示词，不碰端点与密钥。

import { parseSpatialMap, type HostSpatialMap, type HostSpatialNode, type RoadPlan, type RoadSegment } from './spatialMap';
import { parseCamera, parseGround, type HostCamera, type HostGround } from './worldMode';
export { parseSpatialMap, type HostSpatialMap, type HostSpatialNode, type RoadPlan, type RoadSegment };
export { parseCamera, parseGround, type HostCamera, type HostGround };

export const PROTOCOL = 1;

export type HostTheme = 'day' | 'night';
export type HostLang = 'zh' | 'en';
export type GameState = 'idle' | 'playing' | 'paused' | 'won' | 'lost';

export interface HostAdvisorAgent {
  id?: string;
  name: string;
  title?: string;
  avatar?: string;
  color?: string;
  persona?: string;
}

export interface HostWalletInfo {
  balanceCp: number | null;
  netCp?: number;
  wonCount?: number;
  lostCount?: number;
}

export interface HostSettlementReply {
  type: 'hikos:settle:reply';
  v: number;
  matchId: string;
  ok: boolean;
  outcome: 'won' | 'lost';
  deltaCp: number;
  appliedCp: number;
  balanceCp: number | null;
  netCp?: number;
  wonCount?: number;
  lostCount?: number;
  idempotent?: boolean;
  error?: { code: string; message: string };
}

export interface HostContext {
  v: number;
  /** 宿主皮肤 id（如 union-atlas-3d）；不在清单里或没给时为 null，用 accent/bg/ink 兜底 */
  skin: string | null;
  /** 皮肤显示名（只有 hikos:context 带） */
  name: { zh: string; en: string } | null;
  /** '#rrggbb' 小写；没给或不合法为 null */
  accent: string | null;
  bg: string | null;
  ink: string | null;
  theme: HostTheme;
  lang: HostLang;
  reducedMotion: boolean;
  /** 宿主能否代理军师请求（只有 hikos:context 带）；null = 宿主没说（按能代理处理，等它回） */
  advisor: { enabled: boolean; provider: string | null; agent?: HostAdvisorAgent | null } | null;
  /** 是否在宿主 #hub-view 空间皮肤地图上原位开玩（v1 加法字段） */
  insitu?: boolean;
  /** 宿主空间皮肤地图的场景坐标与相机参数（v1 加法字段） */
  map?: HostSpatialMap | null;
  /** 宿主账户 CP 钱包与塔防累计战绩（v1 加法字段） */
  wallet?: HostWalletInfo | null;
}

export const DEFAULT_CONTEXT: HostContext = {
  v: PROTOCOL, skin: null, name: null, accent: null, bg: null, ink: null, theme: 'day', lang: 'zh', reducedMotion: false, advisor: null, insitu: false, map: null,
};

/** 宿主只认 6 位 hex（去 #）；这里顺带接受带 # 的写法，其它一律 null（接入说明 §1.5「否则用缺省」）。 */
export function parseHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^#/, '').toLowerCase();
  return /^[0-9a-f]{6}$/.test(s) ? '#' + s : null;
}

const THEMES: readonly HostTheme[] = ['day', 'night'];
const LANGS: readonly HostLang[] = ['zh', 'en'];
const STATES: readonly GameState[] = ['idle', 'playing', 'paused', 'won', 'lost'];

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** 皮肤 id 只认 kebab 小写（宿主清单里的写法）；别的一律当 null，避免把奇怪字符串带进 DOM / 日志。 */
export function parseSkin(v: unknown): string | null {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v) ? v : null;
}

/** 从 URL query 取首帧前的上下文（§1.5）。不认识的协议版本按 1 处理。 */
export function contextFromQuery(search: string): HostContext {
  const q = new URLSearchParams(search);
  const theme = pick(q.get('theme'), THEMES, DEFAULT_CONTEXT.theme);
  return {
    v: PROTOCOL,
    skin: parseSkin(q.get('skin')),
    name: null,
    accent: parseHex(q.get('accent')),
    bg: parseHex(q.get('bg')),
    ink: parseHex(q.get('ink')),
    theme,
    lang: pick(q.get('lang'), LANGS, DEFAULT_CONTEXT.lang),
    reducedMotion: false,
    advisor: null,
    insitu: q.get('insitu') === '1' || q.get('insitu') === 'true',
    map: null,
  };
}

function parseAdvisorAgent(raw: unknown): HostAdvisorAgent | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  const name = typeof g.name === 'string' ? g.name.trim().slice(0, 48) : '';
  if (!name) return null;
  const out: HostAdvisorAgent = { name };
  if (typeof g.id === 'string' && g.id.trim()) out.id = g.id.trim().slice(0, 64);
  if (typeof g.title === 'string' && g.title.trim()) out.title = g.title.trim().slice(0, 48);
  if (typeof g.avatar === 'string' && g.avatar.trim() && g.avatar.length <= 32768) out.avatar = g.avatar.trim();
  if (typeof g.color === 'string' && parseHex(g.color)) out.color = parseHex(g.color)!;
  if (typeof g.persona === 'string' && g.persona.trim()) out.persona = g.persona.trim().slice(0, 800);
  return out;
}

function parseAdvisor(v: unknown, prev: HostContext['advisor']): HostContext['advisor'] {
  if (v === undefined) return prev;
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  const agent = 'agent' in a ? parseAdvisorAgent(a.agent) : (typeof a.name === 'string' ? parseAdvisorAgent(a) : prev?.agent);
  const res: NonNullable<HostContext['advisor']> = {
    enabled: a.enabled === true,
    provider: typeof a.provider === 'string' && a.provider.length <= 64 ? a.provider : null,
  };
  if (agent !== undefined) res.agent = agent;
  return res;
}

function parseWallet(v: unknown, prev: HostContext['wallet']): HostContext['wallet'] {
  if (v === undefined) return prev;
  if (!v || typeof v !== 'object') return null;
  const w = v as Record<string, unknown>;
  const balanceCp = typeof w.balanceCp === 'number' && Number.isFinite(w.balanceCp) ? Math.round(w.balanceCp) : null;
  const out: HostWalletInfo = { balanceCp };
  if (typeof w.netCp === 'number' && Number.isFinite(w.netCp)) out.netCp = Math.round(w.netCp);
  if (typeof w.wonCount === 'number' && Number.isFinite(w.wonCount)) out.wonCount = Math.max(0, Math.round(w.wonCount));
  if (typeof w.lostCount === 'number' && Number.isFinite(w.lostCount)) out.lostCount = Math.max(0, Math.round(w.lostCount));
  return out;
}

/** 合并一条 hikos:context（§1.6）：字段只增不改，缺的字段保留上一次的值。 */
export function contextFromMessage(msg: unknown, prev: HostContext): HostContext {
  if (!msg || typeof msg !== 'object') return prev;
  const m = msg as Record<string, unknown>;
  const name = m.name && typeof m.name === 'object'
    ? { zh: String((m.name as Record<string, unknown>).zh ?? ''), en: String((m.name as Record<string, unknown>).en ?? '') }
    : prev.name;
  const nextWallet = parseWallet(m.wallet, prev.wallet);
  const out: HostContext = {
    v: PROTOCOL,
    skin: 'skin' in m ? parseSkin(m.skin) : prev.skin,
    name,
    accent: 'accent' in m ? parseHex(m.accent) : prev.accent,
    bg: 'bg' in m ? parseHex(m.bg) : prev.bg,
    ink: 'ink' in m ? parseHex(m.ink) : prev.ink,
    theme: pick(m.theme, THEMES, prev.theme),
    lang: pick(m.lang, LANGS, prev.lang),
    reducedMotion: typeof m.reducedMotion === 'boolean' ? m.reducedMotion : prev.reducedMotion,
    advisor: parseAdvisor(m.advisor, prev.advisor),
    insitu: typeof m.insitu === 'boolean' ? m.insitu : (m.map && typeof m.map === 'object' ? true : prev.insitu),
    map: parseSpatialMap(m.map, prev.map ?? null),
  };
  if (nextWallet !== undefined) out.wallet = nextWallet;
  return out;
}

/**
 * 宿主页的源。方案 A 同源托管（接入说明 §4.1）：宿主页与游戏同站，所以就是 location.origin——
 * sandbox 下 window.origin 是 "null"，但 location.origin 仍按 URL 算，可以用（Hikos 同时跑在 space.hikos.cn / .ai 等域名下，不写死域名）。
 * 本地联调时宿主页可能在另一个端口：允许 ?host=http://localhost:xxxx 覆盖，但只在游戏自己也是从 localhost / 127.0.0.1 提供时才认
 * （线上 space.hikos.cn 下这个参数无效；不用构建期环境变量做开关，src/ 不读构建环境是 D2 护栏测试盯着的）。
 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
export function hostOrigin(search: string, selfOrigin: string): string {
  if (!LOCAL_ORIGIN.test(selfOrigin)) return selfOrigin;
  const h = new URLSearchParams(search).get('host');
  return h && LOCAL_ORIGIN.test(h) ? h : selfOrigin;
}

export interface HostMessageHandlers {
  onContext?: (ctx: HostContext) => void;
  onVisibility?: (visible: boolean) => void;
  onSize?: (w: number, h: number) => void;
  /** 宿主空间皮肤地图场景坐标更新（hikos:map 或 hikos:context.map） */
  onMap?: (map: HostSpatialMap) => void;
  /** 宿主地图相机变了（hikos:camera）：世界坐标 → 舞台像素的矩阵，与宿主画这一帧用的是同一个 */
  onCamera?: (camera: HostCamera) => void;
  /** 宿主按场景地形量出的战场真实高度（hikos:ground，对 td:field 的回执） */
  onGround?: (ground: HostGround) => void;
  /** 宿主代发军师回来的回包（hikos:advisor:reply）；配对与校验在 src/advisor/session.ts */
  onAdvisorReply?: (msg: Record<string, unknown>) => void;
  /** 宿主代发军师的 SSE 流式增量（hikos:advisor:stream） */
  onAdvisorStream?: (msg: Record<string, unknown>) => void;
  /** 宿主完成单局 CP 真实结算后的回包（hikos:settle:reply） */
  onSettleReply?: (msg: HostSettlementReply) => void;
  /** 每条通过源校验的 hikos:* 消息（调试 / 宿主侧 test-arcade 读点用） */
  onAny?: (msg: Record<string, unknown>) => void;
}

export interface HostBridge {
  /** 是否真的在 iframe 里；不在就什么都不发，避免 top 页面对自己 postMessage */
  readonly embedded: boolean;
  readonly origin: string;
  context: HostContext;
  ready(): void;
  state(s: GameState): void;
  exit(): void;
  resize(w: number, h: number): void;
  /** 军师请求（td:advisor:request）/ 结算请求（td:settle:request）；message.type 必须以 td: 开头，别的不发 */
  send(message: Record<string, unknown>): void;
  dispose(): void;
}

/** 装一座桥：解析 query，挂 message 监听（只认 parent + 宿主源），暴露出站消息。 */
export function createHostBridge(win: Window, handlers: HostMessageHandlers = {}): HostBridge {
  const embedded = win.parent !== win;
  const origin = hostOrigin(win.location.search, win.location.origin);
  let context = contextFromQuery(win.location.search);
  let lastState: GameState | null = null;
  let readySent = false;

  const post = (message: Record<string, unknown>) => {
    if (!embedded) return;
    try { win.parent.postMessage(message, origin); } catch { /* 宿主不在或源不匹配：忽略 */ }
  };

  const onMessage = (e: MessageEvent) => {
    if (e.source !== win.parent || e.origin !== origin) return;   // §1.6：只认宿主页；不透明源下自己的 origin 是 null，但宿主页的 origin 是真的
    const m = e.data as { type?: unknown } | null;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    if (m.type.startsWith('hikos:')) handlers.onAny?.(m as Record<string, unknown>);
    if (m.type === 'hikos:context') {
      context = contextFromMessage(m, context);
      bridge.context = context;
      handlers.onContext?.(context);
      if (context.map) handlers.onMap?.(context.map);
    } else if (m.type === 'hikos:map') {
      const nextMap = parseSpatialMap((m as { map?: unknown }).map ?? m, context.map ?? null);
      if (nextMap) {
        context = { ...context, insitu: true, map: nextMap };
        bridge.context = context;
        handlers.onMap?.(nextMap);
      }
    } else if (m.type === 'hikos:camera') {
      const cam = parseCamera(m);
      if (cam) handlers.onCamera?.(cam);
    } else if (m.type === 'hikos:ground') {
      const ground = parseGround(m);
      if (ground) handlers.onGround?.(ground);
    } else if (m.type === 'hikos:visibility') {
      handlers.onVisibility?.(!!(m as { visible?: unknown }).visible);
    } else if (m.type === 'hikos:size') {
      const { w, h } = m as { w?: unknown; h?: unknown };
      if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) handlers.onSize?.(w, h);
    } else if (m.type === 'hikos:advisor:reply') {
      handlers.onAdvisorReply?.(m as Record<string, unknown>);
    } else if (m.type === 'hikos:advisor:stream') {
      handlers.onAdvisorStream?.(m as Record<string, unknown>);
    } else if (m.type === 'hikos:settle:reply') {
      const sr = m as Record<string, unknown>;
      const outcome = sr.outcome === 'lost' ? 'lost' : 'won';
      const deltaCp = typeof sr.deltaCp === 'number' && Number.isFinite(sr.deltaCp) ? Math.round(sr.deltaCp) : (outcome === 'won' ? 10 : -10);
      const appliedCp = typeof sr.appliedCp === 'number' && Number.isFinite(sr.appliedCp) ? Math.round(sr.appliedCp) : deltaCp;
      const balanceCp = typeof sr.balanceCp === 'number' && Number.isFinite(sr.balanceCp) ? Math.round(sr.balanceCp) : null;
      if (balanceCp !== null) {
        context = {
          ...context,
          wallet: {
            balanceCp,
            ...(typeof sr.netCp === 'number' ? { netCp: Math.round(sr.netCp) } : {}),
            ...(typeof sr.wonCount === 'number' ? { wonCount: Math.round(sr.wonCount) } : {}),
            ...(typeof sr.lostCount === 'number' ? { lostCount: Math.round(sr.lostCount) } : {}),
          },
        };
        bridge.context = context;
      }
      handlers.onSettleReply?.({
        type: 'hikos:settle:reply',
        v: PROTOCOL,
        matchId: typeof sr.matchId === 'string' ? sr.matchId.slice(0, 128) : '',
        ok: sr.ok === true,
        outcome,
        deltaCp,
        appliedCp,
        balanceCp,
        ...(typeof sr.netCp === 'number' ? { netCp: Math.round(sr.netCp) } : {}),
        ...(typeof sr.wonCount === 'number' ? { wonCount: Math.round(sr.wonCount) } : {}),
        ...(typeof sr.lostCount === 'number' ? { lostCount: Math.round(sr.lostCount) } : {}),
        ...(typeof sr.idempotent === 'boolean' ? { idempotent: sr.idempotent } : {}),
        ...(sr.error && typeof sr.error === 'object' ? { error: { code: String((sr.error as Record<string, unknown>).code ?? 'ERROR'), message: String((sr.error as Record<string, unknown>).message ?? '') } } : {}),
      });
    }
  };
  if (embedded) win.addEventListener('message', onMessage);

  const bridge: HostBridge = {
    embedded, origin, context,
    // §1.6 顺序：td:ready 永远是第一条出站消息；之前记下的状态在 ready 之后补发一条
    ready() { if (readySent) return; readySent = true; post({ type: 'td:ready', v: PROTOCOL }); if (lastState) post({ type: 'td:state', state: lastState }); },
    state(s) { if (!STATES.includes(s) || s === lastState) return; lastState = s; if (readySent) post({ type: 'td:state', state: s }); },
    exit() { post({ type: 'td:exit' }); },
    resize(w, h) { post({ type: 'td:resize', w: Math.round(w), h: Math.round(h) }); },
    send(message) { if (typeof message.type === 'string' && message.type.startsWith('td:')) post(message); },
    dispose() { if (embedded) win.removeEventListener('message', onMessage); },
  };
  return bridge;
}

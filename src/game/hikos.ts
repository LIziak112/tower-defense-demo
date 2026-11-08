// Hikos 宿主桥接（postMessage v1）。契约：接入说明 01_1b297d9c §1.5–1.7；宿主实现 krowworker web/hikos/src/addons/arcade.js（PR #1638）。
// 游戏被宿主用 sandbox="allow-scripts" 的 iframe 嵌在 /arcade/tower-defense/：不透明源，没有 localStorage / cookie，所有状态只放内存。
// 宿主 → 游戏：首帧前走 URL query（v skin accent bg ink theme lang），运行中走 hikos:context / hikos:visibility / hikos:size。
// 游戏 → 宿主：td:ready {v} · td:state {state} · td:exit · td:resize {w,h}。消息里没有任何身份信息，只有展示类字段。

export const PROTOCOL = 1;

export type HostTheme = 'day' | 'night';
export type HostLang = 'zh' | 'en';
export type GameState = 'idle' | 'playing' | 'paused' | 'won' | 'lost';

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
}

export const DEFAULT_CONTEXT: HostContext = {
  v: PROTOCOL, skin: null, name: null, accent: null, bg: null, ink: null, theme: 'day', lang: 'zh', reducedMotion: false,
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
  };
}

/** 合并一条 hikos:context（§1.6）：字段只增不改，缺的字段保留上一次的值。 */
export function contextFromMessage(msg: unknown, prev: HostContext): HostContext {
  if (!msg || typeof msg !== 'object') return prev;
  const m = msg as Record<string, unknown>;
  const name = m.name && typeof m.name === 'object'
    ? { zh: String((m.name as Record<string, unknown>).zh ?? ''), en: String((m.name as Record<string, unknown>).en ?? '') }
    : prev.name;
  return {
    v: PROTOCOL,
    skin: 'skin' in m ? parseSkin(m.skin) : prev.skin,
    name,
    accent: 'accent' in m ? parseHex(m.accent) : prev.accent,
    bg: 'bg' in m ? parseHex(m.bg) : prev.bg,
    ink: 'ink' in m ? parseHex(m.ink) : prev.ink,
    theme: pick(m.theme, THEMES, prev.theme),
    lang: pick(m.lang, LANGS, prev.lang),
    reducedMotion: typeof m.reducedMotion === 'boolean' ? m.reducedMotion : prev.reducedMotion,
  };
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
  dispose(): void;
}

/** 装一座桥：解析 query，挂 message 监听（只认 parent + 宿主源），暴露四种出站消息。 */
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
    } else if (m.type === 'hikos:visibility') {
      handlers.onVisibility?.(!!(m as { visible?: unknown }).visible);
    } else if (m.type === 'hikos:size') {
      const { w, h } = m as { w?: unknown; h?: unknown };
      if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) handlers.onSize?.(w, h);
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
    dispose() { if (embedded) win.removeEventListener('message', onMessage); },
  };
  return bridge;
}

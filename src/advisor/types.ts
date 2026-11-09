// 军师适配层 · 类型、限额与结构化校验（任务 fb4d93bc；上游规格：3a53bf89 的 06_军师规格 v1 §3–§4，大厅 #24344 / #24353）。
// 位置：逻辑核心之外、宿主之内；零 DOM。军师只能通过这里定义的结构化回包影响战局，且每条 move 最终都走 sim.ts 的 applyBuild 校验。
import { z } from 'zod';

export const ADVISOR_PROTOCOL = 1;

/** 三种能力（06 §2）：C2 下一波建议 · C3 即时战斗指令 · C1 关卡设计（复仇一局复用） */
export type AdviceKind = 'next-wave' | 'tactical' | 'level';

export const LIMITS = {
  options: 3,
  movesPerOption: 4,
  titleLen: 12,
  whyLen: 80,
  riskLen: 60,
  sayLen: 60,
  lineLen: 40,
  /** 快照里空槽只送 reach 最高的前 N 个（已占槽全送）；军师只能在送过去的槽里选，别的 id 一律 UNKNOWN_SLOT */
  slotsInSnapshot: 12,
  nextWaveDeadlineMs: 6000,
  tacticalDeadlineMs: 2500,
  levelDeadlineMs: 20000,
  /** 2 s @ 30 tick/s：即时指令的 basedOn 比当前 tick 落后超过这个数就按过期丢弃（06 §4，取值随 30 tick/s 换算） */
  tacticalFreshTicks: 60,
  /** 4 s：波内至多每 4 s 发一次即时请求，且上一条未结案不发新条 */
  tacticalEveryTicks: 120,
  logRing: 200,
  /** 请求体（不含 llm.messages）上限；宿主侧也按同一数卡 */
  snapshotBytes: 8 * 1024,
} as const;

// ---------------------------------------------------------------- 极简决策快照（核心 → 军师）
// 只含决策所需：无坐标 / 网格 / 渲染 / 宿主用户字段（06 §3「极简决策快照」，验收 §5-6 用 FORBIDDEN_KEYS 断言）。
export interface SnapshotSlot {
  /** 槽位号 = 内容包 buildable_cells 的下标；坐标映射只在适配层采纳时做 */
  id: number;
  open: boolean;
  tower: string | null;
  /** 从这个槽出发，各塔种射程内能覆盖的路径格数（覆盖越多越好） */
  reach: Record<string, number>;
}
export interface Snapshot {
  v: 1;
  stateVersion: number;
  phase: 'build' | 'wave';
  wave: { index: number; total: number; next: { type: string; n: number }[] | null; now: { type: string; n: number }[] | null };
  base: { hp: number; max: number };
  gold: number;
  towers: { id: string; name: string; cost: number; dmg: number; every: number; range: number }[];
  enemies: { id: string; name: string; hp: number; speed: number; dmg: number; reward: number }[];
  slots: SnapshotSlot[];
  /** 场上存活敌人：按种类计数 + 最前一只的路程比例（0 出生点 … 1 基地） */
  field: Record<string, { n: number; front: number }>;
  gambit: { taken: string | null; offers: { id: string; name: string; line: string; bonus: number }[] };
  history: { kills: number; leaks: number; cleared: number; score: { you: number; advisor: number } };
}

/** 快照（及整条出站请求）里禁止出现的键：坐标 / 渲染 / 内容包几何 / 宿主与身份。递归检查。 */
export const FORBIDDEN_KEYS: readonly string[] = [
  'x', 'y', 'cx', 'cy', 'fx', 'fy', 'tx', 'ty', 'px', 'progress',
  'color', 'colors', 'palette', 'palette_id', 'asset_id', 'tileset_id', 'skin', 'accent', 'bg', 'ink', 'theme',
  'path', 'buildable_cells', 'occupied', 'rng', 'seed',
  'user', 'user_id', 'token', 'auth', 'cookie', 'session', 'email', 'team', 'team_id', 'workspace',
];

export function forbiddenKeysIn(value: unknown, at = '$'): string[] {
  const out: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) { v.forEach((it, i) => walk(it, `${p}[${i}]`)); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, it] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.includes(k)) out.push(`${p}.${k}`);
      walk(it, `${p}.${k}`);
    }
  };
  walk(value, at);
  return out;
}

// ---------------------------------------------------------------- 军师回包（结构化；禁止自由文本当指令）
const short = (n: number) => z.string().trim().min(1).max(n);
export const MoveSchema = z.object({
  slot: z.number().int().min(0).max(4095),
  tower: z.string().min(1).max(32),
});
export const OptionSchema = z.object({
  id: z.enum(['a', 'b', 'c']),
  title: short(LIMITS.titleLen),
  why: short(LIMITS.whyLen),
  risk: short(LIMITS.riskLen).optional(),
  /** 0 条 = 「这波别花钱」也是合法选项（有趣的取舍之一） */
  moves: z.array(MoveSchema).max(LIMITS.movesPerOption),
});
export const AdviceSchema = z.object({
  v: z.literal(1).optional(),
  /** 建议所依据的 stateVersion（= 快照 stateVersion）；新鲜度判断用它 */
  basedOn: z.number().int().min(0),
  /** 军师一句话（性格），可省 */
  say: short(LIMITS.sayLen).optional(),
  options: z.array(OptionSchema).min(1).max(LIMITS.options),
  /** 战前押注（玩法增强 ①）：按选项 a 打，这波会漏几只 */
  bet: z.object({ leaks: z.number().int().min(0).max(99), line: short(LIMITS.lineLen) }).optional(),
  /** 变招提议（玩法增强 ②）：只能从快照 gambit.offers 里挑 */
  gambit: z.object({ id: z.string().min(1).max(16), line: short(LIMITS.lineLen) }).optional(),
});
// 未知键按 zod 默认剥掉（不因模型多说一个字段就整包作废）；已知键严格按类型与长度卡。
export type Advice = z.infer<typeof AdviceSchema>;
export type AdviceOption = z.infer<typeof OptionSchema>;
export type AdviceMove = z.infer<typeof MoveSchema>;

/** 适配层自己的拒绝码（运行时的 OCCUPIED / NOT_ENOUGH_GOLD / NOT_BUILDABLE / UNKNOWN_TOWER / BAD_CELL 来自 sim.ts，原样透传） */
export type RejectCode =
  | 'BAD_SHAPE' | 'UNKNOWN_SLOT' | 'UNKNOWN_TOWER' | 'SLOT_OCCUPIED' | 'UNKNOWN_GAMBIT'
  | 'STALE' | 'DUP' | 'LATE' | 'TIMEOUT' | 'TRANSPORT' | 'NO_TRANSPORT' | 'NO_OPTIONS' | 'SUPERSEDED';

export interface Reject { code: RejectCode | string; detail?: string; option?: string; slot?: number; tower?: string }

export type ParseResult = { ok: true; advice: Advice } | { ok: false; code: 'BAD_SHAPE'; detail: string };

export function parseAdvice(raw: unknown): ParseResult {
  const r = AdviceSchema.safeParse(raw);
  if (r.success) return { ok: true, advice: r.data };
  const first = r.error.issues[0];
  return { ok: false, code: 'BAD_SHAPE', detail: `${first ? '/' + first.path.join('/') : ''} ${first?.message ?? 'invalid'}`.trim() };
}

// ---------------------------------------------------------------- 传输层（核心 ⇄ 宿主代理 / 开发代理）
export interface LlmMessage { role: 'system' | 'user' | 'assistant'; content: string }

/** 扮演军师的频道在岗智能体元数据（由宿主从当前频道在岗智能体状态中选定并经 hikos:context / td:advisor:request 传递） */
export interface AdvisorAgent {
  id?: string;
  name: string;
  title?: string;
  avatar?: string;
  color?: string;
  persona?: string;
}

/** 流式增量事件（SSE delta → 宿主 hikos:advisor:stream → 游戏通道 onStream） */
export interface AdvisorStreamEvent {
  reqId: string;
  delta?: string;
  text?: string;
  chars?: number;
  stage?: string;
  provider?: string;
}

export interface AdvisorRequest {
  v: 1;
  reqId: string;
  kind: AdviceKind;
  deadlineMs: number;
  stateVersion: number;
  /** 代理方可用于限额 / 审计；只含 Snapshot（level 请求没有） */
  snapshot?: Snapshot;
  /** 是否启用 SSE 流式输出（可选，宿主与服务端据此走流式增量 + 首包/空闲超时） */
  stream?: boolean;
  /** 当前扮演军师的频道智能体信息（姓名、头像、人设提示词） */
  agent?: AdvisorAgent;
  /** 给 OpenAI 兼容端点的 messages；代理方只加凭据和 response_format，不改内容 */
  llm: { messages: LlmMessage[]; max_tokens: number; json: true };
}
export type AdvisorReply =
  | { reqId: string; ok: true; payload: unknown; provider?: string; latencyMs?: number; agent?: AdvisorAgent }
  | { reqId: string; ok: false; error: { code: string; message?: string }; provider?: string; latencyMs?: number; agent?: AdvisorAgent };

/** 一条通道：发请求、收回包（回包异步到达，由会话按 reqId 配对；迟到 / 重复都在会话层判）；可选支持 onStream 接收流式增量 */
export interface AdvisorChannel {
  readonly name: string;
  readonly kind: 'host' | 'http' | 'scripted';
  readonly agent?: AdvisorAgent | null;
  setAgent?(agent: AdvisorAgent | null): void;
  post(req: AdvisorRequest): void;
  onReply(cb: (reply: AdvisorReply) => void): void;
  onStream?(cb: (ev: AdvisorStreamEvent) => void): void;
}

export function isAdvisorReply(v: unknown): v is AdvisorReply {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  if (typeof m.reqId !== 'string') return false;
  if (m.ok === true) return 'payload' in m;
  if (m.ok === false) return !!m.error && typeof m.error === 'object';
  return false;
}

export function isAdvisorStreamEvent(v: unknown): v is AdvisorStreamEvent {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return typeof m.reqId === 'string' && m.reqId.length > 0;
}

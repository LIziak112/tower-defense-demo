import type { GambitId, GambitTaken } from '../runtime';
import type { Advice, AdviceKind, AdvisorAgent, AdvisorChannel, Reject } from './types';

export type Lang = 'zh' | 'en';
export type Source = 'llm' | 'local';

export interface Presented {
  reqId: string;
  kind: Exclude<AdviceKind, 'level'>;
  advice: Advice;
  source: Source;
  provider: string | null;
  latencyMs: number | null;
  /** 兜底原因（TIMEOUT / TRANSPORT / BAD_SHAPE …）；LLM 正常回包时为 null */
  reason: string | null;
  rejects: Reject[];
  atTick: number;
  wave: number;
  adopted: string[];
}
export interface Outcome { option: string; slot: number; tower: string; ok: boolean; code: string | null; message: string | null; tick: number }
export interface BetRecord { wave: number; predicted: number; actual: number; result: 'you' | 'advisor' | 'none'; source: Source }
export interface LogEntry { t: number; tick: number; ev: 'req' | 'reply' | 'drop' | 'present' | 'adopt' | 'outcome' | 'bet' | 'gambit' | 'timeout' | 'error'; reqId?: string; kind?: string; code?: string; detail?: string }

export interface AdvisorView {
  provider: { name: string; kind: AdvisorChannel['kind'] | 'local'; channel: string | null; agent?: AdvisorAgent | null };
  status: 'idle' | 'thinking' | 'ready' | 'late';
  thinking: { reqId: string; kind: AdviceKind; sinceMs: number; deadlineMs: number; streamText?: string; streamChars?: number } | null;
  notice: string | null;
  /** 最近一次押注结算的那句话（常驻到下一次结算；不被新建议覆盖） */
  betLine: string | null;
  current: Presented | null;
  bets: BetRecord[];
  score: { you: number; advisor: number; none: number };
  gambit: { offer: { id: GambitId; line: string } | null; taken: GambitTaken | null };
  autopilot: boolean;
  outcomes: Outcome[];
  log: LogEntry[];
  stats: { requests: number; replies: number; fallbacks: number; drops: number; adopted: number };
}

export interface SessionOptions {
  channel: AdvisorChannel | null;
  lang?: Lang;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  onChange?: (view: AdvisorView) => void;
  /** 即时指令开关（波内每 4 s 一问）；默认开 */
  tactical?: boolean;
  deadlines?: Partial<{ nextWave: number; tactical: number }>;
}

export interface Inflight { reqId: string; kind: Exclude<AdviceKind, 'level'>; stateVersion: number; wave: number; phaseStartTick: number; startedAt: number; deadlineMs: number; timer: unknown; streamText?: string; streamChars?: number }

export const STR = {
  zh: { thinking: '军师思考中…', late: '军师迟到，这条不等了。', timeoutLocal: '军师迟到，先用本地建议。', offline: '军师没回音，先用本地建议。', badShape: '军师的话不成句，先用本地建议。', stale: '军师的建议过期了，丢弃。', noTransport: '未接军师，用本地建议。', superseded: '战局已变，上一条建议作废。',
    betYou: (p: number, a: number) => `军师押漏 ${p} 只，实际漏 ${a} 只——你赢了军师！`, betAdvisor: (p: number) => `军师押漏 ${p} 只，分毫不差。`, betNone: (p: number, a: number) => `军师押漏 ${p} 只，实际漏 ${a} 只，比军师想的还糟。`,
    outcomeOk: (t: string, s: number) => `已按军师献策在第 ${s} 号阵位布设「${t}」。`, outcomeBad: (s: number, m: string) => `第 ${s} 号阵位未能布设：${m}` },
  en: { thinking: 'Advisor thinking…', late: 'Advisor is late; skipping this one.', timeoutLocal: 'Advisor is late; using local advice.', offline: 'No reply from advisor; using local advice.', badShape: 'Advisor reply was malformed; using local advice.', stale: 'Advisor reply is stale; dropped.', noTransport: 'No advisor connected; local advice.', superseded: 'The battle moved on; last advice withdrawn.',
    betYou: (p: number, a: number) => `Advisor bet ${p} leaks, you leaked ${a}—you beat the advisor!`, betAdvisor: (p: number) => `Advisor bet ${p} leaks. Called it.`, betNone: (p: number, a: number) => `Advisor bet ${p} leaks, actual ${a}: worse than feared.`,
    outcomeOk: (t: string, s: number) => `Placed ${t} at slot ${s} as advised.`, outcomeBad: (s: number, m: string) => `Slot ${s} failed: ${m}` },
} as const;

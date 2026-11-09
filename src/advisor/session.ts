// 军师会话（适配层的编排器）。零 DOM；由游戏循环每 tick 喂状态与事件，自己管请求生命周期：
//   request → (deadline) → reply | timeout | error → validate(shape / 新鲜度 / 槽位 / 塔种) → present | fallback(本地模板) | drop(迟到·重复·过期)
// 采纳只产出 build 命令，交给 sim.ts 的 applyBuild 走与玩家点击完全相同的校验（06 §3「同一条 deploy 校验」）；结果事件回灌成 outcome。
import type { BattleState, Command, GameEvent, GambitId, GambitTaken } from '../runtime/types';
import { isGambitId } from '../runtime/gambit';
import { adviseLocal, LOCAL_ADVISOR_NAME } from './local';
import { advicePrompt } from './prompt';
import { buildSnapshot, slotCell } from './snapshot';
import { LIMITS, parseAdvice, type Advice, type AdviceKind, type AdvisorAgent, type AdvisorChannel, type AdvisorReply, type AdvisorRequest, type AdvisorStreamEvent, type Reject, type Snapshot } from './types';

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

interface Inflight { reqId: string; kind: Exclude<AdviceKind, 'level'>; stateVersion: number; wave: number; phaseStartTick: number; startedAt: number; deadlineMs: number; timer: unknown; streamText?: string; streamChars?: number }

const STR = {
  zh: { thinking: '军师思考中…', late: '军师迟到，这条不等了。', timeoutLocal: '军师迟到，先用本地建议。', offline: '军师没回音，先用本地建议。', badShape: '军师的话不成句，先用本地建议。', stale: '军师的建议过期了，丢弃。', noTransport: '未接军师，用本地建议。', superseded: '战局已变，上一条建议作废。',
    betYou: (p: number, a: number) => `军师押漏 ${p} 只，实际漏 ${a} 只——你赢了军师！`, betAdvisor: (p: number) => `军师押漏 ${p} 只，分毫不差。`, betNone: (p: number, a: number) => `军师押漏 ${p} 只，实际漏 ${a} 只，比军师想的还糟。`,
    outcomeOk: (t: string, s: number) => `已按军师献策在第 ${s} 号阵位布设「${t}」。`, outcomeBad: (s: number, m: string) => `第 ${s} 号阵位未能布设：${m}` },
  en: { thinking: 'Advisor thinking…', late: 'Advisor is late; skipping this one.', timeoutLocal: 'Advisor is late; using local advice.', offline: 'No reply from advisor; using local advice.', badShape: 'Advisor reply was malformed; using local advice.', stale: 'Advisor reply is stale; dropped.', noTransport: 'No advisor connected; local advice.', superseded: 'The battle moved on; last advice withdrawn.',
    betYou: (p: number, a: number) => `Advisor bet ${p} leaks, you leaked ${a}—you beat the advisor!`, betAdvisor: (p: number) => `Advisor bet ${p} leaks. Called it.`, betNone: (p: number, a: number) => `Advisor bet ${p} leaks, actual ${a}: worse than feared.`,
    outcomeOk: (t: string, s: number) => `Placed ${t} at slot ${s} as advised.`, outcomeBad: (s: number, m: string) => `Slot ${s} failed: ${m}` },
} as const;

export class AdvisorSession {
  readonly channel: AdvisorChannel | null;
  lang: Lang;
  autopilot = false;
  tacticalEnabled: boolean;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly onChange: (view: AdvisorView) => void;
  private readonly deadlines: { nextWave: number; tactical: number };

  private state: BattleState | null = null;
  private seq = 0;
  private inflight: Inflight | null = null;
  private received = new Set<string>();
  /** 已关门的请求（超时 / 作废）：之后到的回包一律 LATE */
  private closed = new Set<string>();
  private current: Presented | null = null;
  private notice: string | null = null;
  private betLine: string | null = null;
  private status: AdvisorView['status'] = 'idle';
  private phaseStartTick = 0;
  private requestedPhaseTick = -1;
  private lastTactical = -Infinity;
  private playerActed = false;
  private waveStart: { wave: number; leaks: number; bet: { leaks: number } | null; source: Source } | null = null;
  private bets: BetRecord[] = [];
  private score = { you: 0, advisor: 0, none: 0 };
  private outcomes: Outcome[] = [];
  private pendingOutcomes = new Map<string, { option: string; slot: number; tower: string }>();
  private pendingCmds: Command[] = [];
  private log: LogEntry[] = [];
  private stats = { requests: 0, replies: 0, fallbacks: 0, drops: 0, adopted: 0 };
  agent: AdvisorAgent | null = null;

  constructor(opts: SessionOptions) {
    this.channel = opts.channel;
    this.lang = opts.lang ?? 'zh';
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onChange = opts.onChange ?? (() => {});
    this.tacticalEnabled = opts.tactical ?? true;
    this.deadlines = { nextWave: opts.deadlines?.nextWave ?? LIMITS.nextWaveDeadlineMs, tactical: opts.deadlines?.tactical ?? LIMITS.tacticalDeadlineMs };
    this.channel?.onReply((r) => this.onReply(r));
    this.channel?.onStream?.((ev) => this.onStream(ev));
  }

  setAgent(agent: AdvisorAgent | null) {
    this.agent = agent;
    this.emit();
  }

  // ---------------------------------------------------------------- 生命周期：新战局 / 每 tick
  /** 新战局（或重开）：清掉与上一局有关的一切，押注战绩保留（跨局积分是乐趣的一部分） */
  reset(state: BattleState) {
    if (this.inflight) { this.clearTimer(this.inflight.timer); this.inflight = null; }
    this.state = state;
    this.current = null; this.notice = null; this.status = 'idle';
    this.phaseStartTick = state.tick; this.requestedPhaseTick = -1; this.lastTactical = -Infinity;
    this.playerActed = false; this.waveStart = null; this.outcomes = []; this.pendingOutcomes.clear(); this.pendingCmds = [];
    this.emit();
  }

  /** 每 tick 在 step() 之前调用：把异步产生的命令（托管采纳）交给游戏入队 */
  beforeTick(): Command[] { const c = this.pendingCmds; this.pendingCmds = []; return c; }

  /** 每 tick 在 step() 之后调用：观察事件、结算押注、按阶段发请求 */
  afterTick(state: BattleState, events: GameEvent[]) {
    this.state = state;
    let changed = false;
    for (const e of events) {
      if (e.type === 'wave_started') {
        const bet = this.current?.kind === 'next-wave' ? this.current.advice.bet ?? null : null;
        this.waveStart = { wave: e.wave, leaks: state.leaks, bet: bet ? { leaks: bet.leaks } : null, source: this.current?.source ?? 'local' };
        this.phaseStartTick = state.tick; this.lastTactical = state.tick; this.playerActed = false;
        if (this.inflight?.kind === 'next-wave') { this.drop(this.inflight, 'SUPERSEDED', STR[this.lang].superseded); }
        changed = true;
      } else if (e.type === 'wave_cleared' || e.type === 'battle_ended') {
        if (this.waveStart) { this.settleBet(state); changed = true; }
        // 波打完：还在飞的即时请求已无意义，立刻作废，别让它堵住下一波请求
        if (this.inflight && (this.inflight.kind === 'tactical' || e.type === 'battle_ended')) { this.drop(this.inflight, 'SUPERSEDED', null); changed = true; }
        if (state.phase === 'build') { this.phaseStartTick = state.tick; this.playerActed = false; this.current = null; this.notice = null; this.status = 'idle'; changed = true; }
      } else if (e.type === 'build_ok' || e.type === 'build_rejected') {
        const k = `${e.tower_id}@${e.x},${e.y}`;
        const p = this.pendingOutcomes.get(k);
        if (p) {
          this.pendingOutcomes.delete(k);
          const o: Outcome = { option: p.option, slot: p.slot, tower: p.tower, ok: e.type === 'build_ok', code: e.type === 'build_rejected' ? e.code : null, message: e.type === 'build_rejected' ? e.message : null, tick: state.tick };
          this.outcomes.push(o); if (this.outcomes.length > 20) this.outcomes.shift();
          const name = state.pack.towers.find((t) => t.id === p.tower)?.display_name ?? p.tower;
          this.notice = o.ok ? STR[this.lang].outcomeOk(name, p.slot) : STR[this.lang].outcomeBad(p.slot, o.message ?? o.code ?? '');
          this.push('outcome', { reqId: this.current?.reqId, code: o.code ?? 'OK', detail: `${p.option}:${p.slot}:${p.tower}` });
          changed = true;
        }
      } else if (e.type === 'gambit_accepted' || e.type === 'gambit_rejected') {
        this.push('gambit', { code: e.type === 'gambit_accepted' ? 'OK' : e.code, detail: e.type === 'gambit_accepted' ? `${e.id}+${e.bonus}` : e.message });
        if (e.type === 'gambit_rejected') this.notice = e.message;
        changed = true;
      }
    }
    // 阶段逻辑
    if (state.phase === 'build' && state.wave_index < state.pack.waves.length && this.requestedPhaseTick !== this.phaseStartTick && !this.inflight) {
      this.requestedPhaseTick = this.phaseStartTick;
      this.request('next-wave');
      changed = true;
    } else if (state.phase === 'wave' && this.tacticalEnabled && !this.inflight && state.tick - this.lastTactical >= LIMITS.tacticalEveryTicks) {
      this.lastTactical = state.tick;
      const cheapest = Math.min(...state.pack.towers.map((t) => t.cost));
      if (state.gold >= cheapest && state.occupied.length < state.pack.map.buildable_cells.length) { this.request('tactical'); changed = true; }
    }
    if (changed) this.emit();
  }

  /** 玩家手动点地图建塔：本阶段托管作废（玩家的手永远比军师大） */
  notePlayerBuild() { this.playerActed = true; }
  setAutopilot(on: boolean) { this.autopilot = on; this.emit(); }

  // ---------------------------------------------------------------- 请求
  private request(kind: Exclude<AdviceKind, 'level'>) {
    const state = this.state!;
    const snapshot = buildSnapshot(state, { score: { you: this.score.you, advisor: this.score.advisor }, lang: this.lang });
    const reqId = `r${++this.seq}`;
    const deadlineMs = kind === 'tactical' ? this.deadlines.tactical : this.deadlines.nextWave;
    this.stats.requests++;
    this.push('req', { reqId, kind, detail: `sv=${snapshot.stateVersion} wave=${snapshot.wave.index}` });
    if (!this.channel) {
      this.present({ reqId, kind, stateVersion: snapshot.stateVersion, wave: state.wave_index, phaseStartTick: this.phaseStartTick, startedAt: this.now(), deadlineMs, timer: null }, adviseLocal(kind, snapshot, state, this.lang), 'local', null, null, [], 'NO_TRANSPORT');
      this.notice = STR[this.lang].noTransport;
      this.emit();
      return;
    }
    const inflight: Inflight = { reqId, kind, stateVersion: snapshot.stateVersion, wave: state.wave_index, phaseStartTick: this.phaseStartTick, startedAt: this.now(), deadlineMs, timer: null };
    inflight.timer = this.setTimer(() => this.onTimeout(reqId), deadlineMs);
    this.inflight = inflight;
    this.status = 'thinking';
    const activeAgent = this.agent ?? this.channel?.agent ?? null;
    const req: AdvisorRequest = {
      v: 1, reqId, kind, deadlineMs, stateVersion: snapshot.stateVersion, snapshot,
      stream: true,
      ...(activeAgent ? { agent: activeAgent } : {}),
      llm: { ...advicePrompt(kind, snapshot, this.lang, activeAgent), json: true },
    };
    try { this.channel.post(req); } catch (e) {
      this.push('error', { reqId, code: 'TRANSPORT', detail: e instanceof Error ? e.message : String(e) });
      this.clearTimer(inflight.timer);
      this.inflight = null;
      this.fail(inflight, 'TRANSPORT');
    }
  }

  private onStream(ev: AdvisorStreamEvent) {
    if (!this.inflight || this.inflight.reqId !== ev.reqId) return;
    const req = this.inflight;
    // 流式输出空闲超时续期：收到增量说明模型正在持续输出，重置定时器
    this.clearTimer(req.timer);
    req.timer = this.setTimer(() => this.onTimeout(req.reqId), req.deadlineMs);
    const delta = ev.delta ?? '';
    req.streamText = ev.text ?? ((req.streamText ?? '') + delta);
    req.streamChars = ev.chars ?? req.streamText.length;
    this.emit();
  }

  private onReply(reply: AdvisorReply) {
    if (this.received.has(reply.reqId)) { this.stats.drops++; this.push('drop', { reqId: reply.reqId, code: 'DUP' }); return; }
    if (!this.inflight || this.inflight.reqId !== reply.reqId) {
      this.stats.drops++;
      this.push('drop', { reqId: reply.reqId, code: this.closed.has(reply.reqId) ? 'LATE' : 'UNKNOWN' });
      return;
    }
    const req = this.inflight;
    this.received.add(reply.reqId);
    this.clearTimer(req.timer);
    this.inflight = null;
    this.stats.replies++;
    const latency = reply.latencyMs ?? this.now() - req.startedAt;
    this.push('reply', { reqId: reply.reqId, kind: req.kind, code: reply.ok ? 'OK' : reply.error.code, detail: `${latency}ms ${reply.provider ?? ''}`.trim() });
    if (!reply.ok) return this.fail(req, reply.error.code || 'TRANSPORT');
    const v = this.validate(reply.payload, req);
    if (!v.ok) return this.fail(req, v.code, v.detail);
    this.present(req, v.advice, 'llm', reply.provider ?? this.channel?.name ?? null, latency, v.rejects, null);
  }

  private onTimeout(reqId: string) {
    if (!this.inflight || this.inflight.reqId !== reqId) return;
    const req = this.inflight;
    this.inflight = null;
    this.closed.add(reqId);
    this.push('timeout', { reqId, kind: req.kind, detail: `${req.deadlineMs}ms` });
    this.fail(req, 'TIMEOUT');
  }

  /** 失败收口：即时指令超时 / 过期 → 丢弃（不重试同一快照）；其余 → 本地模板兜底 */
  private fail(req: Inflight, code: string, detail?: string) {
    const state = this.state!;
    const s = STR[this.lang];
    const phaseMoved = (req.kind === 'next-wave' && (state.phase !== 'build' || state.wave_index !== req.wave)) || (req.kind === 'tactical' && state.phase !== 'wave') || state.phase === 'won' || state.phase === 'lost';
    if (phaseMoved) return this.drop(req, 'SUPERSEDED', null);
    if (req.kind === 'tactical' && (code === 'TIMEOUT' || code === 'STALE')) return this.drop(req, code, s.late);
    this.stats.fallbacks++;
    const snapshot = buildSnapshot(state, { score: { you: this.score.you, advisor: this.score.advisor }, lang: this.lang });
    const advice = adviseLocal(req.kind, snapshot, state, this.lang);
    this.present(req, advice, 'local', null, null, [], code);
    this.notice = code === 'TIMEOUT' ? s.timeoutLocal : code === 'BAD_SHAPE' || code === 'NO_OPTIONS' ? s.badShape : code === 'STALE' ? s.stale : s.offline;
    if (detail) this.push('error', { reqId: req.reqId, code, detail });
    this.emit();
  }

  private drop(req: Inflight, code: string, notice: string | null) {
    if (this.inflight?.reqId === req.reqId) { this.clearTimer(req.timer); this.inflight = null; }
    this.closed.add(req.reqId);
    this.stats.drops++;
    this.push('drop', { reqId: req.reqId, kind: req.kind, code });
    this.status = code === 'LATE' || code === 'TIMEOUT' || code === 'STALE' ? 'late' : this.current ? 'ready' : 'idle';
    if (notice) this.notice = notice;
    this.emit();
  }

  // ---------------------------------------------------------------- 校验链（形状 → 新鲜度 → 槽位 / 塔种 → 变招）
  private validate(payload: unknown, req: Inflight): { ok: true; advice: Advice; rejects: Reject[] } | { ok: false; code: string; detail?: string } {
    const state = this.state!;
    const parsed = parseAdvice(payload);
    if (!parsed.ok) return { ok: false, code: 'BAD_SHAPE', detail: parsed.detail };
    const advice = parsed.advice;
    const basedOn = Math.min(advice.basedOn, req.stateVersion);
    if (req.kind === 'next-wave') {
      if (state.phase !== 'build' || state.wave_index !== req.wave || basedOn < req.phaseStartTick) return { ok: false, code: 'STALE', detail: `basedOn=${basedOn} phaseStart=${req.phaseStartTick} wave=${state.wave_index}/${req.wave}` };
    } else if (state.phase !== 'wave' || state.tick - basedOn > LIMITS.tacticalFreshTicks) {
      return { ok: false, code: 'STALE', detail: `basedOn=${basedOn} tick=${state.tick}` };
    }
    const rejects: Reject[] = [];
    const towerIds = new Set(state.pack.towers.map((t) => t.id));
    const seenIds = new Set<string>();
    const options: Advice['options'] = [];
    for (const o of advice.options) {
      if (seenIds.has(o.id)) continue;
      seenIds.add(o.id);
      const moves = o.moves.filter((m) => {
        const cell = slotCell(state.pack, m.slot);
        if (!cell) { rejects.push({ code: 'UNKNOWN_SLOT', option: o.id, slot: m.slot, tower: m.tower }); return false; }
        if (!towerIds.has(m.tower)) { rejects.push({ code: 'UNKNOWN_TOWER', option: o.id, slot: m.slot, tower: m.tower }); return false; }
        if (state.occupied.includes(`${cell.x},${cell.y}`)) { rejects.push({ code: 'SLOT_OCCUPIED', option: o.id, slot: m.slot, tower: m.tower }); return false; }
        return true;
      });
      if (o.moves.length && !moves.length) continue;   // 原本有步、全被拒 → 整条作废；原本就 0 步（攒钱）保留
      options.push({ ...o, moves });
    }
    if (!options.length) return { ok: false, code: 'NO_OPTIONS', detail: `${rejects.length} rejects` };
    let gambit = advice.gambit;
    if (gambit) {
      const offers = state.phase === 'build' && !(state.gambit && state.gambit.wave === state.wave_index);
      if (!offers || !isGambitId(gambit.id)) { rejects.push({ code: 'UNKNOWN_GAMBIT', detail: gambit.id }); gambit = undefined; }
    }
    const bet = req.kind === 'next-wave' ? advice.bet : undefined;
    return { ok: true, advice: { ...advice, options, gambit, bet }, rejects };
  }

  private present(req: Inflight, advice: Advice, source: Source, provider: string | null, latencyMs: number | null, rejects: Reject[], reason: string | null) {
    const state = this.state!;
    this.current = { reqId: req.reqId, kind: req.kind, advice, source, provider: source === 'local' ? LOCAL_ADVISOR_NAME[this.lang] : provider, latencyMs, reason, rejects, atTick: state.tick, wave: state.wave_index, adopted: [] };
    this.status = 'ready';
    if (source === 'llm') this.notice = null;
    this.push('present', { reqId: req.reqId, kind: req.kind, code: source === 'llm' ? 'LLM' : `LOCAL:${reason ?? ''}`, detail: `${advice.options.length} options, ${rejects.length} rejects` });
    if (this.autopilot && !this.playerActed && advice.options[0]?.moves.length) {
      const cmds = this.adopt(advice.options[0].id);
      this.pendingCmds.push(...cmds);
    }
    this.emit();
  }

  // ---------------------------------------------------------------- 采纳 / 变招（给 HUD 与托管用）
  /** 采纳一条选项：只产出 build 命令；合法性由 sim.ts 的 applyBuild 最终裁决，结果通过 build_ok / build_rejected 回到 outcomes */
  adopt(optionId: string): Command[] {
    const cur = this.current, state = this.state;
    if (!cur || !state || cur.adopted.includes(optionId)) return [];
    const opt = cur.advice.options.find((o) => o.id === optionId);
    if (!opt) return [];
    const cmds: Command[] = [];
    for (const m of opt.moves) {
      const cell = slotCell(state.pack, m.slot);
      if (!cell) continue;
      this.pendingOutcomes.set(`${m.tower}@${cell.x},${cell.y}`, { option: optionId, slot: m.slot, tower: m.tower });
      cmds.push({ type: 'build', tower_id: m.tower, x: cell.x, y: cell.y });
    }
    cur.adopted.push(optionId);
    this.stats.adopted++;
    this.push('adopt', { reqId: cur.reqId, detail: `${optionId}: ${cmds.length} builds` });
    this.emit();
    return cmds;
  }

  /** 接下当前提议的变招（或指定 id）；合法性由 sim.ts 裁决 */
  takeGambit(id?: string): Command | null {
    const gid = id ?? this.current?.advice.gambit?.id;
    if (!gid || !isGambitId(gid)) return null;
    return { type: 'gambit', id: gid };
  }

  // ---------------------------------------------------------------- 押注结算（玩法增强 ①）
  private settleBet(state: BattleState) {
    const ws = this.waveStart!;
    this.waveStart = null;
    if (!ws.bet) return;
    const actual = state.leaks - ws.leaks, predicted = ws.bet.leaks;
    const result: BetRecord['result'] = actual < predicted ? 'you' : actual === predicted ? 'advisor' : 'none';
    this.bets.push({ wave: ws.wave, predicted, actual, result, source: ws.source });
    this.score[result]++;
    const s = STR[this.lang];
    this.betLine = result === 'you' ? s.betYou(predicted, actual) : result === 'advisor' ? s.betAdvisor(predicted) : s.betNone(predicted, actual);
    this.push('bet', { code: result, detail: `wave ${ws.wave}: predicted ${predicted}, actual ${actual}` });
  }

  /** 复仇一局用的战报（给关卡设计军师当输入） */
  debrief(state: BattleState): string {
    const zh = this.lang === 'zh';
    const towers = state.towers.map((t) => state.pack.towers.find((d) => d.id === t.def)?.display_name ?? t.def);
    const counts = [...towers.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map<string, number>())].map(([n, c]) => `${n}×${c}`).join(zh ? '、' : ', ');
    const lost = state.phase === 'lost';
    return zh
      ? `复仇局：上一局「${state.pack.meta.theme}」${lost ? `在第 ${state.wave_index} 波失守` : `守住了 ${state.wave_index} 波`}（基地 ${state.base_hp}/${state.pack.map.base_hp}，漏 ${state.leaks} 只，杀 ${state.kills} 只，塔：${counts || '无'}；押注战绩 你 ${this.score.you} : ${this.score.advisor} 军师）。针对这些弱点出一张更狠但能打的关。`
      : `Revenge: last game "${state.pack.meta.theme}" ${lost ? `fell at wave ${state.wave_index}` : `held ${state.wave_index} waves`} (base ${state.base_hp}/${state.pack.map.base_hp}, ${state.leaks} leaked, ${state.kills} killed, towers: ${counts || 'none'}; bets you ${this.score.you} : ${this.score.advisor} advisor). Design a meaner but beatable level that targets these weaknesses.`;
  }

  // ---------------------------------------------------------------- 视图 / 日志
  view(): AdvisorView {
    const state = this.state;
    const offerId = this.current?.advice.gambit?.id;
    const taken = state?.gambit && state.gambit.wave === state.wave_index ? state.gambit : null;
    const activeAgent = this.agent ?? this.channel?.agent ?? null;
    const providerName = activeAgent?.name
      ? (activeAgent.title ? `${activeAgent.name} · ${activeAgent.title}` : activeAgent.name)
      : (this.channel ? this.channel.name : LOCAL_ADVISOR_NAME[this.lang]);
    return {
      provider: this.channel
        ? { name: providerName, kind: this.channel.kind, channel: this.channel.kind, ...(activeAgent ? { agent: activeAgent } : {}) }
        : { name: LOCAL_ADVISOR_NAME[this.lang], kind: 'local', channel: null, ...(activeAgent ? { agent: activeAgent } : {}) },
      status: this.inflight ? 'thinking' : this.status,
      thinking: this.inflight
        ? {
            reqId: this.inflight.reqId,
            kind: this.inflight.kind,
            sinceMs: this.now() - this.inflight.startedAt,
            deadlineMs: this.inflight.deadlineMs,
            ...(this.inflight.streamText !== undefined ? { streamText: this.inflight.streamText } : {}),
            ...(this.inflight.streamChars !== undefined ? { streamChars: this.inflight.streamChars } : {}),
          }
        : null,
      notice: this.notice,
      betLine: this.betLine,
      current: this.current,
      bets: this.bets.slice(),
      score: { ...this.score },
      gambit: { offer: offerId && isGambitId(offerId) && !taken && state?.phase === 'build' ? { id: offerId, line: this.current!.advice.gambit!.line } : null, taken },
      autopilot: this.autopilot,
      outcomes: this.outcomes.slice(),
      log: this.log.slice(),
      stats: { ...this.stats },
    };
  }
  snapshotNow(): Snapshot | null { return this.state ? buildSnapshot(this.state, { score: { you: this.score.you, advisor: this.score.advisor }, lang: this.lang }) : null; }

  private push(ev: LogEntry['ev'], x: Omit<LogEntry, 't' | 'tick' | 'ev'>) {
    this.log.push({ t: Math.round(this.now()), tick: this.state?.tick ?? 0, ev, ...x });
    if (this.log.length > LIMITS.logRing) this.log.shift();
  }
  private emit() { this.onChange(this.view()); }
}

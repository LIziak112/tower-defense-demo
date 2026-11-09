import type { BattleState, Command, GameEvent } from '../runtime/types';
import { isGambitId } from '../runtime/gambit';
import { LOCAL_ADVISOR_NAME } from './local';
import { buildSnapshot, slotCell } from './snapshot';
import { LIMITS, type Advice, type AdvisorAgent, type AdvisorChannel, type Reject, type Snapshot } from './types';
import { STR, type Lang, type AdvisorView, type Inflight, type LogEntry, type Presented, type Source, type BetRecord, type Outcome, type SessionOptions } from './sessionTypes';
import { AdviceRequests } from './sessionRequests';
export type { Lang, Source, Presented, Outcome, BetRecord, LogEntry, AdvisorView, SessionOptions } from './sessionTypes';

const NO_COMMANDS: readonly Command[] = [];

export class AdvisorSession {
  readonly channel: AdvisorChannel | null;
  lang: Lang;
  autopilot = false;
  tacticalEnabled: boolean;
  private readonly now: () => number;
  private readonly onChange: (view: AdvisorView) => void;

  private state: BattleState | null = null;
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

  private readonly requests: AdviceRequests;

  constructor(opts: SessionOptions) {
    this.channel = opts.channel;
    this.lang = opts.lang ?? 'zh';
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange ?? (() => {});
    this.tacticalEnabled = opts.tactical ?? true;
    this.requests = new AdviceRequests({
      channel: opts.channel, now: this.now, deadlines: opts.deadlines,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)),
      state: () => this.state!, score: () => this.score, lang: () => this.lang, phaseStartTick: () => this.phaseStartTick,
      agent: () => this.agent, current: () => this.current, stats: this.stats,
      push: (ev, data) => this.push(ev, data), present: (...args) => this.present(...args),
      setStatus: (status) => { this.status = status; }, setNotice: (notice) => { this.notice = notice; }, emit: () => this.emit(),
    });
  }

  setAgent(agent: AdvisorAgent | null) {
    this.agent = agent;
    this.emit();
  }

  /** 新战局（或重开）：清掉与上一局有关的一切，押注战绩保留（跨局积分是乐趣的一部分） */
  reset(state: BattleState) {
    this.requests.reset();
    this.state = state;
    this.current = null; this.notice = null; this.status = 'idle';
    this.phaseStartTick = state.tick; this.requestedPhaseTick = -1; this.lastTactical = -Infinity;
    this.playerActed = false; this.waveStart = null; this.outcomes = []; this.pendingOutcomes.clear(); this.pendingCmds = [];
    this.emit();
  }

  /** 每 tick 在 step() 之前调用：把异步产生的命令（托管采纳）交给游戏入队 */
  beforeTick(): readonly Command[] {
    if (!this.pendingCmds.length) return NO_COMMANDS;
    const commands = this.pendingCmds;
    this.pendingCmds = [];
    return commands;
  }

  /** 每 tick 在 step() 之后调用：观察事件、结算押注、按阶段发请求 */
  afterTick(state: BattleState, events: readonly GameEvent[], count = events.length) {
    this.state = state;
    let changed = false;
    for (let i = 0; i < count; i++) {
      const e = events[i];
      if (e.type === 'wave_started') {
        const bet = this.current?.kind === 'next-wave' ? this.current.advice.bet ?? null : null;
        this.waveStart = { wave: e.wave, leaks: state.leaks, bet: bet ? { leaks: bet.leaks } : null, source: this.current?.source ?? 'local' };
        this.phaseStartTick = state.tick; this.lastTactical = state.tick; this.playerActed = false;
        if (this.requests.inflight?.kind === 'next-wave') { this.requests.drop(this.requests.inflight, 'SUPERSEDED', STR[this.lang].superseded); }
        changed = true;
      } else if (e.type === 'wave_cleared' || e.type === 'battle_ended') {
        if (this.waveStart) { this.settleBet(state); changed = true; }
        // 波打完：还在飞的即时请求已无意义，立刻作废，别让它堵住下一波请求
        if (this.requests.inflight && (this.requests.inflight.kind === 'tactical' || e.type === 'battle_ended')) { this.requests.drop(this.requests.inflight, 'SUPERSEDED', null); changed = true; }
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
    if (state.phase === 'build' && state.wave_index < state.pack.waves.length && this.requestedPhaseTick !== this.phaseStartTick && !this.requests.inflight) {
      this.requestedPhaseTick = this.phaseStartTick;
      this.requests.request('next-wave');
      changed = true;
    } else if (state.phase === 'wave' && this.tacticalEnabled && !this.requests.inflight && state.tick - this.lastTactical >= LIMITS.tacticalEveryTicks) {
      this.lastTactical = state.tick;
      const cheapest = Math.min(...state.pack.towers.map((t) => t.cost));
      if (state.gold >= cheapest && state.occupied.length < state.pack.map.buildable_cells.length) { this.requests.request('tactical'); changed = true; }
    }
    if (changed) this.emit();
  }

  /** 玩家手动点地图建塔：本阶段托管作废（玩家的手永远比军师大） */
  notePlayerBuild() { this.playerActed = true; }
  setAutopilot(on: boolean) { this.autopilot = on; this.emit(); }

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
      status: this.requests.inflight ? 'thinking' : this.status,
      thinking: this.requests.inflight
        ? {
            reqId: this.requests.inflight.reqId,
            kind: this.requests.inflight.kind,
            sinceMs: this.now() - this.requests.inflight.startedAt,
            deadlineMs: this.requests.inflight.deadlineMs,
            ...(this.requests.inflight.streamText !== undefined ? { streamText: this.requests.inflight.streamText } : {}),
            ...(this.requests.inflight.streamChars !== undefined ? { streamChars: this.requests.inflight.streamChars } : {}),
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

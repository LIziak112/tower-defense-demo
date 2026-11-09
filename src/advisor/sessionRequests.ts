import type { BattleState } from '../runtime';
import { isGambitId } from '../runtime/gambit';
import { adviseLocal } from './local';
import { advicePrompt } from './prompt';
import { buildSnapshot, slotCell } from './snapshot';
import { LIMITS, parseAdvice, type Advice, type AdviceKind, type AdvisorAgent, type AdvisorChannel, type AdvisorReply, type AdvisorRequest, type AdvisorStreamEvent, type Reject } from './types';
import { STR, type AdvisorView, type Inflight, type Lang, type LogEntry, type Presented, type SessionOptions, type Source } from './sessionTypes';

interface RequestOptions {
  channel: AdvisorChannel | null;
  now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(h: unknown): void;
  deadlines: SessionOptions['deadlines'];
  state(): BattleState; score(): AdvisorView['score']; lang(): Lang; phaseStartTick(): number;
  agent(): AdvisorAgent | null; current(): Presented | null; stats: AdvisorView['stats'];
  push(ev: LogEntry['ev'], data: Omit<LogEntry, 't' | 'tick' | 'ev'>): void;
  present(req: Inflight, advice: Advice, source: Source, provider: string | null, latency: number | null, rejects: Reject[], reason: string | null): void;
  setStatus(status: AdvisorView['status']): void; setNotice(notice: string): void; emit(): void;
}

export class AdviceRequests {
  inflight: Inflight | null = null;
  private seq = 0;
  private received = new Set<string>();
  private closed = new Set<string>();
  private readonly channel: AdvisorChannel | null;
  private readonly deadlines: { nextWave: number; tactical: number };
  constructor(private readonly opts: RequestOptions) {
    this.channel = opts.channel;
    this.deadlines = { nextWave: opts.deadlines?.nextWave ?? LIMITS.nextWaveDeadlineMs, tactical: opts.deadlines?.tactical ?? LIMITS.tacticalDeadlineMs };
    this.channel?.onReply((r) => this.onReply(r));
    this.channel?.onStream?.((ev) => this.onStream(ev));
  }

  private now() { return this.opts.now(); }
  private setTimer(fn: () => void, ms: number) { return this.opts.setTimer(fn, ms); }
  private clearTimer(timer: unknown) { this.opts.clearTimer(timer); }
  reset() {
    if (!this.inflight) return;
    this.clearTimer(this.inflight.timer);
    this.inflight = null;
  }

  request(kind: Exclude<AdviceKind, 'level'>) {
    const state = this.opts.state();
    const snapshot = buildSnapshot(state, { score: { you: this.opts.score().you, advisor: this.opts.score().advisor }, lang: this.opts.lang() });
    const reqId = `r${++this.seq}`;
    const deadlineMs = kind === 'tactical' ? this.deadlines.tactical : this.deadlines.nextWave;
    this.opts.stats.requests++;
    this.opts.push('req', { reqId, kind, detail: `sv=${snapshot.stateVersion} wave=${snapshot.wave.index}` });
    if (!this.channel) {
      this.opts.present({ reqId, kind, stateVersion: snapshot.stateVersion, wave: state.wave_index, phaseStartTick: this.opts.phaseStartTick(), startedAt: this.now(), deadlineMs, timer: null }, adviseLocal(kind, snapshot, state, this.opts.lang()), 'local', null, null, [], 'NO_TRANSPORT');
      this.opts.setNotice(STR[this.opts.lang()].noTransport);
      this.opts.emit();
      return;
    }
    const inflight: Inflight = { reqId, kind, stateVersion: snapshot.stateVersion, wave: state.wave_index, phaseStartTick: this.opts.phaseStartTick(), startedAt: this.now(), deadlineMs, timer: null };
    inflight.timer = this.setTimer(() => this.onTimeout(reqId), deadlineMs);
    this.inflight = inflight;
    this.opts.setStatus('thinking');
    const activeAgent = this.opts.agent() ?? this.channel?.agent ?? null;
    const req: AdvisorRequest = {
      v: 1, reqId, kind, deadlineMs, stateVersion: snapshot.stateVersion, snapshot,
      stream: true,
      ...(activeAgent ? { agent: activeAgent } : {}),
      llm: { ...advicePrompt(kind, snapshot, this.opts.lang(), activeAgent), json: true },
    };
    try { this.channel.post(req); } catch (e) {
      this.opts.push('error', { reqId, code: 'TRANSPORT', detail: e instanceof Error ? e.message : String(e) });
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
    this.opts.emit();
  }

  private onReply(reply: AdvisorReply) {
    if (this.received.has(reply.reqId)) { this.opts.stats.drops++; this.opts.push('drop', { reqId: reply.reqId, code: 'DUP' }); return; }
    if (!this.inflight || this.inflight.reqId !== reply.reqId) {
      this.opts.stats.drops++;
      this.opts.push('drop', { reqId: reply.reqId, code: this.closed.has(reply.reqId) ? 'LATE' : 'UNKNOWN' });
      return;
    }
    const req = this.inflight;
    this.received.add(reply.reqId);
    this.clearTimer(req.timer);
    this.inflight = null;
    this.opts.stats.replies++;
    const latency = reply.latencyMs ?? this.now() - req.startedAt;
    this.opts.push('reply', { reqId: reply.reqId, kind: req.kind, code: reply.ok ? 'OK' : reply.error.code, detail: `${latency}ms ${reply.provider ?? ''}`.trim() });
    if (!reply.ok) return this.fail(req, reply.error.code || 'TRANSPORT');
    const v = this.validate(reply.payload, req);
    if (!v.ok) return this.fail(req, v.code, v.detail);
    this.opts.present(req, v.advice, 'llm', reply.provider ?? this.channel?.name ?? null, latency, v.rejects, null);
  }

  private onTimeout(reqId: string) {
    if (!this.inflight || this.inflight.reqId !== reqId) return;
    const req = this.inflight;
    this.inflight = null;
    this.closed.add(reqId);
    this.opts.push('timeout', { reqId, kind: req.kind, detail: `${req.deadlineMs}ms` });
    this.fail(req, 'TIMEOUT');
  }

  /** 失败收口：即时指令超时 / 过期 → 丢弃（不重试同一快照）；其余 → 本地模板兜底 */
  private fail(req: Inflight, code: string, detail?: string) {
    const state = this.opts.state();
    const s = STR[this.opts.lang()];
    const phaseMoved = (req.kind === 'next-wave' && (state.phase !== 'build' || state.wave_index !== req.wave)) || (req.kind === 'tactical' && state.phase !== 'wave') || state.phase === 'won' || state.phase === 'lost';
    if (phaseMoved) return this.drop(req, 'SUPERSEDED', null);
    if (req.kind === 'tactical' && (code === 'TIMEOUT' || code === 'STALE')) return this.drop(req, code, s.late);
    this.opts.stats.fallbacks++;
    const snapshot = buildSnapshot(state, { score: { you: this.opts.score().you, advisor: this.opts.score().advisor }, lang: this.opts.lang() });
    const advice = adviseLocal(req.kind, snapshot, state, this.opts.lang());
    this.opts.present(req, advice, 'local', null, null, [], code);
    this.opts.setNotice(code === 'TIMEOUT' ? s.timeoutLocal : code === 'BAD_SHAPE' || code === 'NO_OPTIONS' ? s.badShape : code === 'STALE' ? s.stale : s.offline);
    if (detail) this.opts.push('error', { reqId: req.reqId, code, detail });
    this.opts.emit();
  }

  drop(req: Inflight, code: string, notice: string | null) {
    if (this.inflight?.reqId === req.reqId) { this.clearTimer(req.timer); this.inflight = null; }
    this.closed.add(req.reqId);
    this.opts.stats.drops++;
    this.opts.push('drop', { reqId: req.reqId, kind: req.kind, code });
    this.opts.setStatus(code === 'LATE' || code === 'TIMEOUT' || code === 'STALE' ? 'late' : this.opts.current() ? 'ready' : 'idle');
    if (notice) this.opts.setNotice(notice);
    this.opts.emit();
  }

  // ---------------------------------------------------------------- 校验链（形状 → 新鲜度 → 槽位 / 塔种 → 变招）
  private validate(payload: unknown, req: Inflight): { ok: true; advice: Advice; rejects: Reject[] } | { ok: false; code: string; detail?: string } {
    const state = this.opts.state();
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
}

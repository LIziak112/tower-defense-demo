// 军师测试用具：假时钟（会话的截止计时器全走它）、脚本通道、把 step/beforeTick/afterTick 串起来的驱动器。
import { createBattle, step } from '../../src/runtime/index';
import type { BattleState, Command, GameEvent } from '../../src/runtime/index';
import { DEFAULT_PACK } from '../../src/content/default';
import { AdvisorSession, ScriptedChannel, type AdvisorView, type SessionOptions } from '../../src/advisor/index';

export class FakeClock {
  t = 1_000_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.push({ at: this.t + ms, fn, id }); return id; };
  clearTimer = (h: unknown) => { this.timers = this.timers.filter((x) => x.id !== h); };
  /** 推进 ms 毫秒，按到期顺序触发计时器 */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

export interface Harness {
  clock: FakeClock;
  channel: ScriptedChannel;
  session: AdvisorSession;
  state: BattleState;
  events: GameEvent[];
  views: AdvisorView[];
  /** 走 n 个 tick（每 tick：beforeTick → step → afterTick），extra 命令只在第一个 tick 送入 */
  tick(n?: number, extra?: Command[]): GameEvent[];
  /** 推进假时钟（不走 tick） */
  wait(ms: number): void;
}

export function makeHarness(opts: Partial<SessionOptions> & { seed?: number; noChannel?: boolean } = {}): Harness {
  const clock = new FakeClock();
  const channel = new ScriptedChannel((fn, ms) => { clock.setTimer(fn, ms); });
  const views: AdvisorView[] = [];
  const session = new AdvisorSession({
    channel: opts.noChannel ? null : channel,
    lang: opts.lang ?? 'zh',
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onChange: (v) => views.push(v),
    tactical: opts.tactical ?? true,
    deadlines: opts.deadlines,
  });
  const h: Harness = {
    clock, channel, session, views,
    state: createBattle(DEFAULT_PACK, opts.seed ?? 7),
    events: [],
    tick(n = 1, extra = []) {
      const all: GameEvent[] = [];
      for (let i = 0; i < n; i++) {
        const cmds = [...(i === 0 ? extra : []), ...h.session.beforeTick()];
        const r = step(h.state, cmds);
        h.state = r.state;
        h.session.afterTick(h.state, r.events);
        all.push(...r.events);
        h.clock.advance(1000 / 30);   // 真推进假时钟：截止计时器会在 tick 间到期，和浏览器里一样
      }
      h.events.push(...all);
      return all;
    },
    wait(ms) { clock.advance(ms); },
  };
  session.reset(h.state);
  return h;
}

/** 合法的 LLM 回包样板：a 在给定槽放弩车，b 不花钱 */
export function validAdvice(stateVersion: number, slot: number, extra: Record<string, unknown> = {}) {
  return {
    basedOn: stateVersion,
    say: '先稳住。',
    options: [
      { id: 'a', title: '稳守', why: '弩车便宜，覆盖拐角。', risk: '后面厚血顶不住。', moves: [{ slot, tower: 'crossbow' }] },
      { id: 'b', title: '攒一手', why: '留着下波上投石车。', moves: [] },
    ],
    bet: { leaks: 1, line: '按 a 打，这波漏 1 只。' },
    ...extra,
  };
}

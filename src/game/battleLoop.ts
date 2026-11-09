import { stepInPlace, TICKS_PER_SECOND, type BattleState, type Command } from '../runtime';
import type { AdvisorSession } from '../advisor';
import type { BattleBus } from './eventBus';
import type { BattleFx } from './battleFx';
import { createBattleMetrics } from './battleMetrics';
import { follow } from './motion';

interface LoopOptions {
  bus: BattleBus; fx: BattleFx; session: AdvisorSession; hud: HTMLElement;
  lang(): 'zh' | 'en'; saveRecord(): boolean; state(): BattleState;
  frozen(): boolean; hostHidden(): boolean; speed(): number;
  renderHud(): void; scheduleCard(): void; draw(now: number, tickFraction: number): void; hide(): void; ready(): void;
  beginAudioEvents(): void;
  benchmark: boolean;
}
const TICK_MS = 1000 / TICKS_PER_SECOND;
const recordKey = 'td:changban:best-wave';
export function createBattleLoop(opts: LoopOptions) {
  const { bus, fx, session, hud, renderHud, scheduleCard } = opts;
  const recorded: { tick: number; cmds: readonly Command[]; immediate?: boolean }[] = [];
  const queue: Command[] = [];
  let waveScore = { kills: 0, leaks: 0, bounty: 0 };
  let clearedWaves = 0, bestWave = 0, confirmingUntil = 0, invalidUntil = 0;
  let toast = '', toastUntil = 0;
  let pendingHud = false;
  const metrics = opts.benchmark ? createBattleMetrics() : undefined;
  try { bestWave = Number(localStorage.getItem(recordKey)) || 0; } catch { /* host can block storage */ }

  function toastMessage(message: string) {
    toast = message;
    toastUntil = performance.now() + 1800;
  }
  bus.on('build_rejected', (event) => {
    toastMessage(event.message);
    invalidUntil = performance.now() + 150;
  });
  bus.on('build_ok', () => { confirmingUntil = performance.now() + 250; });
  bus.on('wave_rejected', (event) => toastMessage(event.message));
  bus.on('early_wave', (event) => toastMessage(opts.lang() === 'zh' ? `提前开波 +${event.gold} 金` : `Early wave +${event.gold} gold`));
  bus.on('wave_started', () => { waveScore = { kills: 0, leaks: 0, bounty: 0 }; });
  bus.on('entity_died', (event) => { waveScore.kills++; waveScore.bounty += event.reward; });
  bus.on('entity_escaped', () => { waveScore.leaks++; });
  bus.on('wave_cleared', (event) => {
    clearedWaves = event.wave;
    if (opts.saveRecord() && event.wave > bestWave) {
      bestWave = event.wave;
      try { localStorage.setItem(recordKey, String(bestWave)); } catch { /* keep record for this session */ }
    }
  });

  function dispatch(command: Command) { runCommands([command], false); }
  function runCommands(cmds: readonly Command[], advance: boolean) {
    if (cmds.length) recorded.push(advance ? { tick: opts.state().tick, cmds } : { tick: opts.state().tick, cmds, immediate: true });
    const start = metrics && advance ? performance.now() : 0;
    const { items, count } = stepInPlace(opts.state(), cmds, advance);
    const duration = metrics && advance ? performance.now() - start : 0;
    let attacks = 0, hudChanged = cmds.length > 0, cardChanged = false;
    for (let i = 0; i < count; i++) {
      switch (items[i].type) {
        case 'attack': attacks++; break;
        case 'gold_changed': case 'wave_started': case 'wave_cleared': case 'battle_ended':
          hudChanged = cardChanged = true; break;
        case 'entity_escaped': hudChanged = true; break;
        case 'build_ok': cardChanged = true; break;
      }
    }
    if (metrics && advance) metrics.tick(duration, attacks);
    fx.clock(performance.now());
    if (count) opts.beginAudioEvents();
    bus.publish(items, count);
    session.afterTick(opts.state(), items, count);
    if (hudChanged) {
      if (advance) pendingHud = true;
      else renderHud();
    }
    if (cardChanged) scheduleCard();
  }

  function tickOnce() {
    const commands = session.beforeTick();
    runCommands(queue.length ? [...commands, ...queue.splice(0)] : commands, true);
  }

  let acc = 0; let last = performance.now(), rate = 1;
  let firstFrame = true;
  function frame(now: number) {
    const started = metrics ? performance.now() : 0;
    metrics?.frame(now);
    const elapsed = Math.min(250, now - last), desired = opts.speed();
    rate = desired < rate ? follow(rate, desired, elapsed / 1000, 18) : desired;
    acc += elapsed * (opts.frozen() ? 0 : rate); last = now;
    let n = 0;
    while (acc >= TICK_MS && n < 16) { tickOnce(); acc -= TICK_MS; n++; }
    if (pendingHud) { pendingHud = false; renderHud(); }
    if (toast && now >= toastUntil) { toast = ''; hud.querySelector('.toast')?.remove(); }
    if (!opts.hostHidden() || firstFrame) opts.draw(now, Math.min(1, acc / TICK_MS));
    else opts.hide();
    if (firstFrame) { firstFrame = false; opts.ready(); }   // 首帧可交互后向宿主报 td:ready（接入说明 §1.6）
    if (metrics) metrics.work(performance.now() - started);
    requestAnimationFrame(frame);
  }

  function resetClock() { acc = 0; last = performance.now(); rate = opts.speed(); }
  return {
    runCommands, dispatch, resetClock, recorded, queue, metrics,
    start() { requestAnimationFrame(frame); },
    reset() {
      recorded.length = queue.length = 0;
      waveScore = { kills: 0, leaks: 0, bounty: 0 };
      clearedWaves = confirmingUntil = invalidUntil = toastUntil = 0;
      toast = ''; pendingHud = false; fx.clear(); resetClock();
    },
    get toast() { return performance.now() < toastUntil ? toast : ''; },
    get waveScore() { return waveScore; }, get bestWave() { return bestWave; }, get clearedWaves() { return clearedWaves; },
    get confirmingUntil() { return confirmingUntil; }, get invalidUntil() { return invalidUntil; },
  };
}

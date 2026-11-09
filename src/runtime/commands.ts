import { combatEvent, type EventSink } from './combatEvents';
import type { BattleState, Command } from './types';
import { CELL, TICKS_PER_SECOND } from './path';
import { GAMBITS, gambitBonus, isGambitId } from './gambit';
import { applyUpgrade } from './upgrade';
import { setTargeting } from './targeting';
import { queueEnemy } from './enemies';

const key = (x: number, y: number) => `${x},${y}`;

export function buildFailure(s: BattleState, towerId: string, x: number, y: number) {
  const def = s.pack.towers.find((t) => t.id === towerId);
  if (!def) return 'UNKNOWN_TOWER';
  if (!Number.isInteger(x) || !Number.isInteger(y)) return 'BAD_CELL';
  if (!s.pack.map.buildable_cells.some((b) => b.x === x && b.y === y)) return 'NOT_BUILDABLE';
  if (s.occupied.includes(key(x, y))) return 'OCCUPIED';
  if (s.gold < def.cost) return 'NOT_ENOUGH_GOLD';
  return null;
}

export function earlyWaveReward(s: BattleState) {
  const rules = s.pack.wave_rules;
  if (!rules) return { gold: 0, cooldown_ticks: 0 };
  const seconds = Math.max(0, s.prep_until - s.tick) / TICKS_PER_SECOND;
  return { gold: Math.floor(seconds * rules.gold_per_second), cooldown_ticks: Math.floor(seconds * rules.cooldown_ticks_per_second) };
}

export function applyCommands(s: BattleState, commands: readonly Command[], ev: EventSink) {
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    if (c.type === 'build') applyBuild(s, c, ev);
    else if (c.type === 'upgrade') applyUpgrade(s, c, ev);
    else if (c.type === 'targeting') setTargeting(s, c, ev);
    else if (c.type === 'gambit') applyGambit(s, c, ev);
    else if (c.type === 'debug_add_gold') s.gold += c.amount;
    else if (c.type === 'start_wave' || c.type === 'debug_next_wave') {
      if (s.phase !== 'build') ev.push({ type: 'wave_rejected', code: 'WAVE_IN_PROGRESS', message: '本波尚未结束' });
      else if (s.wave_index >= s.pack.waves.length) ev.push({ type: 'wave_rejected', code: 'NO_MORE_WAVES', message: '没有更多波次' });
      else {
        if (c.type === 'start_wave' && s.pack.wave_rules) {
          const reward = earlyWaveReward(s);
          s.gold += reward.gold;
          s.build_cooldown_credit += reward.cooldown_ticks;
          if (reward.gold || reward.cooldown_ticks) ev.push({ type: 'early_wave', ...reward });
        }
        scheduleWave(s, ev);
      }
    }
  }
}

export function scheduleWave(s: BattleState, ev: EventSink) {
  const wave = s.pack.waves[s.wave_index];
  // 变招只作用于它被接下时的那一波（gambit.wave === 当前 wave_index）；没接或接的是别的波 → 倍率全 1，行为与无变招完全一致
  const g0 = s.gambit && s.gambit.wave === s.wave_index ? GAMBITS[s.gambit.id] : null;
  let at = s.tick; // spawned this tick (pending) -> active next tick
  let total = 0;
  for (const g of wave.groups) {
    const count = g0 ? Math.ceil(g.count * g0.count_mul) : g.count;
    const interval = g0 ? Math.max(1, Math.round(g.interval_ticks * g0.interval_mul)) : g.interval_ticks;
    for (let i = 0; i < count; i++) {
      queueEnemy(s, g.enemy_id, at, g0 && g0.hp_mul !== 1 ? g0.hp_mul : undefined);
      at += interval;
      total++;
    }
  }
  s.wave_index++;
  s.phase = 'wave';
  s.prep_until = 0;
  const event = combatEvent(ev, 'wave_started');
  event.wave = s.wave_index; event.total = total;
}

/** 变招：只在建造期、还有下一波、本建造期没接过时成立；成立即刻加金币，波次改动在 scheduleWave 里兑现。 */
function applyGambit(s: BattleState, c: Extract<Command, { type: 'gambit' }>, ev: EventSink) {
  const reject = (code: string, message: string) => ev.push({ type: 'gambit_rejected', code, message, id: String(c.id) });
  if (!isGambitId(c.id)) return reject('UNKNOWN_GAMBIT', `没有这张变招：${String(c.id)}`);
  if (s.phase !== 'build') return reject('NOT_BUILD_PHASE', '只能在布防期接变招');
  if (s.wave_index >= s.pack.waves.length) return reject('NO_MORE_WAVES', '没有下一波了');
  if (s.gambit && s.gambit.wave === s.wave_index) return reject('ALREADY_TAKEN', '这一波已经接过变招了');
  const bonus = gambitBonus(s.pack, s.wave_index, c.id);
  s.gambit = { wave: s.wave_index, id: c.id, bonus };
  s.gold += bonus;
  ev.push({ type: 'gambit_accepted', id: c.id, wave: s.wave_index, bonus });
}

/** Atomic build: all checks first, then mutate. Any failure => no gold spent, no cell taken. */
function applyBuild(s: BattleState, c: Extract<Command, { type: 'build' }>, ev: EventSink) {
  const reject = (code: string, message: string) =>
    ev.push({ type: 'build_rejected', code, message, tower_id: c.tower_id, x: c.x, y: c.y });
  const failure = buildFailure(s, c.tower_id, c.x, c.y);
  const def = s.pack.towers.find((t) => t.id === c.tower_id);
  if (failure) {
    const messages = {
      UNKNOWN_TOWER: `没有名为 ${c.tower_id} 的塔`, BAD_CELL: '坐标必须是整数格',
      NOT_BUILDABLE: '这里不能建塔', OCCUPIED: '这格已经有塔了',
      NOT_ENOUGH_GOLD: `金币不足（需要 ${def?.cost}，现有 ${s.gold}）`,
    };
    return reject(failure, messages[failure]);
  }
  if (!def) return;
  s.gold -= def.cost;
  s.occupied.push(key(c.x, c.y));
  const delay = s.pack.wave_rules?.build_cooldown_ticks ?? 0;
  const reduction = Math.min(delay, s.build_cooldown_credit);
  s.build_cooldown_credit -= reduction;
  const t = {
    iid: s.next_iid++, def: def.id, cx: c.x, cy: c.y,
    x: c.x * CELL + 500, y: c.y * CELL + 500, cooldown: Math.max(0, delay - reduction) + (delay ? 1 : 0), life: 'pending' as const,
  };
  s.towers.push(t);
  ev.push({ type: 'build_ok', iid: t.iid, tower_id: def.id, x: c.x, y: c.y, cost: def.cost });
}

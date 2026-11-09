import type { BattleState, Command, ContentPack } from './types';
import { seedState } from './rng';
import { pathLength } from './path';
import { prepareEnemies, updateEnemies, recycleEnemies } from './enemies';
import { clearProjectiles, prepareArsenal, updateAttacks } from './attack';
import { applyCommands, scheduleWave } from './commands';
import { combatEvent, LiveCombatEvents, type EventSink } from './combatEvents';

export { CELL, TICKS_PER_SECOND, positionAt, pathLength } from './path';

export function createBattle(pack: ContentPack, seed: number): BattleState {
  return {
    tick: 0,
    seed: seed >>> 0,
    rng: seedState(seed),
    next_iid: 1,
    gold: pack.map.starting_gold,
    base_hp: pack.map.base_hp,
    phase: 'build',
    wave_index: 0,
    spawn_queue: [],
    towers: [],
    enemies: [],
    occupied: [],
    kills: 0,
    leaks: 0,
    pack,
    path_len: pathLength(pack.map.path),
    gambit: null,
    projectiles: [],
    prep_until: pack.wave_rules?.prep_ticks ?? 0,
    build_cooldown_credit: 0,
  };
}

/** Deep-ish clone of mutable parts; pack is immutable and shared. */
export function cloneState(s: BattleState): BattleState {
  return {
    ...s,
    spawn_queue: s.spawn_queue.map((p) => ({ ...p })),
    towers: s.towers.map((t) => ({ ...t })),
    enemies: s.enemies.map((e) => ({ ...e })),
    projectiles: s.projectiles.map((p) => ({ ...p })),
    occupied: s.occupied.slice(),
    gambit: s.gambit ? { ...s.gambit } : null,
  };
}

const NO_COMMANDS: readonly Command[] = [];
const liveEvents = new WeakMap<BattleState, LiveCombatEvents>();

export function createLiveBattle(pack: ContentPack, seed: number) {
  const state = createBattle(pack, seed);
  const enemies = prepareEnemies(state, true);
  const arsenal = prepareArsenal(state, true);
  const events = new LiveCombatEvents(pack.map.buildable_cells.length, arsenal.free.length, enemies.free.length);
  liveEvents.set(state, events);
  return state;
}

/** The live event buffer is valid until the next call. Consume it synchronously. */
export function stepInPlace(s: BattleState, commands: readonly Command[] = NO_COMMANDS, advance = true) {
  const events = liveEvents.get(s);
  if (!events) throw new Error('stepInPlace requires createLiveBattle');
  events.reset();
  run(s, commands, events, advance);
  return events;
}

export function step(prev: BattleState, commands: readonly Command[] = NO_COMMANDS, advance = true) {
  const events: import('./types').GameEvent[] = [];
  if (prev.phase === 'won' || prev.phase === 'lost') return { state: prev, events };
  const state = cloneState(prev);
  run(state, commands, events, advance);
  return { state, events };
}

function run(s: BattleState, commands: readonly Command[], events: EventSink, advance: boolean) {
  if (s.phase === 'won' || s.phase === 'lost') return;
  const beforeGold = s.gold;
  if (advance) {
    for (let i = 0; i < s.towers.length; i++) if (s.towers[i].life === 'pending') s.towers[i].life = 'alive';
    for (let i = 0; i < s.enemies.length; i++) if (s.enemies[i].life === 'pending') s.enemies[i].life = 'alive';
  }
  applyCommands(s, commands, events);
  if (advance) {
    if (s.phase === 'build' && s.pack.wave_rules && s.wave_index < s.pack.waves.length && s.tick >= s.prep_until) {
      scheduleWave(s, events);
    }
    updateEnemies(s, events);
    updateAttacks(s, events);
    recycleEnemies(s);
    if (s.base_hp <= 0) {
      clearProjectiles(s);
      s.phase = 'lost';
      combatEvent(events, 'battle_ended').result = 'lost';
    } else if (s.phase === 'wave' && !s.spawn_queue.length && !s.enemies.length) {
      clearProjectiles(s);
      combatEvent(events, 'wave_cleared').wave = s.wave_index;
      if (s.wave_index >= s.pack.waves.length) {
        s.phase = 'won';
        combatEvent(events, 'battle_ended').result = 'won';
      } else {
        s.phase = 'build';
        s.prep_until = s.tick + 1 + (s.pack.wave_rules?.prep_ticks ?? 0);
      }
    }
    s.tick++;
  }
  if (s.gold !== beforeGold) {
    const event = combatEvent(events, 'gold_changed');
    event.gold = s.gold;
    event.delta = s.gold - beforeGold;
  }
}

// Deterministic tower-defense simulation. Zero dependencies.
// Tick order (plan Appendix A): activate pending -> apply commands -> spawn (pending)
// -> enemies move / escape -> towers pick first_on_path -> resolve attacks in order
// -> cleanup dying/escaped -> win/loss (loss first) -> tick+1.
import type { BattleState, Command, ContentPack, EnemyInst, GameEvent, TowerInst, Cell } from './types';
import { seedState } from './rng';

export const TICKS_PER_SECOND = 30;
export const CELL = 1000; // milli-cell

const key = (x: number, y: number) => `${x},${y}`;

export function pathLength(path: Cell[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    len += (Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y)) * CELL;
  }
  return len;
}

/** integer position (milli-cell, cell centre = c*1000+500) at a given progress along the path */
export function positionAt(path: Cell[], progress: number): { x: number; y: number } {
  let left = progress;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const seg = (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) * CELL;
    if (left <= seg) {
      const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
      return { x: a.x * CELL + 500 + dx * left, y: a.y * CELL + 500 + dy * left };
    }
    left -= seg;
  }
  const end = path[path.length - 1];
  return { x: end.x * CELL + 500, y: end.y * CELL + 500 };
}

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
  };
}

/** Deep-ish clone of mutable parts; pack is immutable and shared. */
export function cloneState(s: BattleState): BattleState {
  return {
    ...s,
    spawn_queue: s.spawn_queue.map((p) => ({ ...p })),
    towers: s.towers.map((t) => ({ ...t })),
    enemies: s.enemies.map((e) => ({ ...e })),
    occupied: s.occupied.slice(),
  };
}

function scheduleWave(s: BattleState, ev: GameEvent[]) {
  const wave = s.pack.waves[s.wave_index];
  let at = s.tick; // spawned this tick (pending) -> active next tick
  let total = 0;
  for (const g of wave.groups) {
    for (let i = 0; i < g.count; i++) {
      s.spawn_queue.push({ enemy_id: g.enemy_id, at_tick: at });
      at += g.interval_ticks;
      total++;
    }
  }
  s.wave_index++;
  s.phase = 'wave';
  ev.push({ type: 'wave_started', wave: s.wave_index, total });
}

/** Atomic build: all checks first, then mutate. Any failure => no gold spent, no cell taken. */
function applyBuild(s: BattleState, c: Extract<Command, { type: 'build' }>, ev: GameEvent[]) {
  const reject = (code: string, message: string) =>
    ev.push({ type: 'build_rejected', code, message, tower_id: c.tower_id, x: c.x, y: c.y });
  const def = s.pack.towers.find((t) => t.id === c.tower_id);
  if (!def) return reject('UNKNOWN_TOWER', `没有名为 ${c.tower_id} 的塔`);
  if (!Number.isInteger(c.x) || !Number.isInteger(c.y)) return reject('BAD_CELL', '坐标必须是整数格');
  if (!s.pack.map.buildable_cells.some((b) => b.x === c.x && b.y === c.y)) return reject('NOT_BUILDABLE', '这里不能建塔');
  if (s.occupied.includes(key(c.x, c.y))) return reject('OCCUPIED', '这格已经有塔了');
  if (s.gold < def.cost) return reject('NOT_ENOUGH_GOLD', `金币不足（需要 ${def.cost}，现有 ${s.gold}）`);
  s.gold -= def.cost;
  s.occupied.push(key(c.x, c.y));
  const t: TowerInst = {
    iid: s.next_iid++, def: def.id, cx: c.x, cy: c.y,
    x: c.x * CELL + 500, y: c.y * CELL + 500, cooldown: 0, life: 'pending',
  };
  s.towers.push(t);
  ev.push({ type: 'build_ok', iid: t.iid, tower_id: def.id, x: c.x, y: c.y, cost: def.cost });
}

export function step(prev: BattleState, commands: Command[] = []): { state: BattleState; events: GameEvent[] } {
  const ev: GameEvent[] = [];
  if (prev.phase === 'won' || prev.phase === 'lost') return { state: prev, events: ev };
  const s = cloneState(prev);
  const pack = s.pack;

  // 1. activate pending instances created in an earlier tick
  for (const t of s.towers) if (t.life === 'pending') t.life = 'alive';
  for (const e of s.enemies) if (e.life === 'pending') e.life = 'alive';

  // 2. player commands
  for (const c of commands) {
    if (c.type === 'build') applyBuild(s, c, ev);
    else if (c.type === 'start_wave') {
      if (s.phase !== 'build') ev.push({ type: 'wave_rejected', code: 'WAVE_IN_PROGRESS', message: '本波尚未结束' });
      else if (s.wave_index >= pack.waves.length) ev.push({ type: 'wave_rejected', code: 'NO_MORE_WAVES', message: '没有更多波次' });
      else scheduleWave(s, ev);
    } else if (c.type === 'debug_add_gold') {
      s.gold += c.amount;
    } else if (c.type === 'debug_next_wave') {
      if (s.wave_index < pack.waves.length) scheduleWave(s, ev);
    }
  }

  // 3. spawn due enemies (pending: they move from next tick)
  if (s.spawn_queue.length) {
    const due = s.spawn_queue.filter((p) => p.at_tick <= s.tick);
    s.spawn_queue = s.spawn_queue.filter((p) => p.at_tick > s.tick);
    for (const p of due) {
      const def = pack.enemies.find((d) => d.id === p.enemy_id)!;
      const pos = positionAt(pack.map.path, 0);
      const e: EnemyInst = { iid: s.next_iid++, def: def.id, hp: def.hp, progress: 0, x: pos.x, y: pos.y, life: 'pending' };
      s.enemies.push(e);
      ev.push({ type: 'enemy_spawned', iid: e.iid, enemy_id: def.id });
    }
  }

  // 4. movement + escape (escape: base damage once, no reward)
  for (const e of s.enemies) {
    if (e.life !== 'alive') continue;
    const def = pack.enemies.find((d) => d.id === e.def)!;
    e.progress += def.speed;
    if (e.progress >= s.path_len) {
      e.progress = s.path_len;
      e.life = 'escaped';
      s.base_hp = Math.max(0, s.base_hp - def.base_damage);
      s.leaks++;
      ev.push({ type: 'entity_escaped', iid: e.iid, base_damage: def.base_damage });
    }
    const p = positionAt(pack.map.path, e.progress);
    e.x = p.x; e.y = p.y;
  }

  // 5. targeting: first_on_path = alive enemy in range with max progress (tie: lower iid)
  const intents: { tower: TowerInst; target: EnemyInst; damage: number }[] = [];
  for (const t of s.towers) {
    if (t.life !== 'alive') continue;
    if (t.cooldown > 0) { t.cooldown--; if (t.cooldown > 0) continue; }
    const def = pack.towers.find((d) => d.id === t.def)!;
    const r2 = def.range * def.range;
    let best: EnemyInst | null = null;
    for (const e of s.enemies) {
      if (e.life !== 'alive') continue;
      const dx = e.x - t.x, dy = e.y - t.y;
      if (dx * dx + dy * dy > r2) continue;
      if (!best || e.progress > best.progress) best = e;
    }
    if (best) {
      intents.push({ tower: t, target: best, damage: def.damage });
      t.cooldown = def.interval_ticks;
    }
  }

  // 6. resolve in creation order; only alive targets take damage; death once, reward once
  for (const it of intents) {
    const e = it.target;
    ev.push({ type: 'attack', tower: it.tower.iid, target: e.iid, fx: it.tower.x, fy: it.tower.y, tx: e.x, ty: e.y });
    if (e.life !== 'alive') continue;
    e.hp -= it.damage;
    ev.push({ type: 'damage_applied', target: e.iid, amount: it.damage, hp: Math.max(0, e.hp) });
    if (e.hp <= 0) {
      e.life = 'dying';
      const def = pack.enemies.find((d) => d.id === e.def)!;
      s.gold += def.reward;
      s.kills++;
      ev.push({ type: 'entity_died', iid: e.iid, reward: def.reward, x: e.x, y: e.y });
    }
  }

  // 7. cleanup
  s.enemies = s.enemies.filter((e) => e.life !== 'dying' && e.life !== 'escaped');

  // 8. outcome (loss first)
  if (s.base_hp <= 0) {
    s.phase = 'lost';
    ev.push({ type: 'battle_ended', result: 'lost' });
  } else if (s.phase === 'wave' && s.spawn_queue.length === 0 && s.enemies.length === 0) {
    ev.push({ type: 'wave_cleared', wave: s.wave_index });
    if (s.wave_index >= pack.waves.length) {
      s.phase = 'won';
      ev.push({ type: 'battle_ended', result: 'won' });
    } else s.phase = 'build';
  }

  s.tick++;
  return { state: s, events: ev };
}

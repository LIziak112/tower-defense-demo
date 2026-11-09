import { GAMBITS } from './gambit';
import { positionAt } from './path';
import { combatEvent, type EventSink } from './combatEvents';
import type { BattleState, ContentPack, EnemyDef, EnemyInst, SpawnPlan } from './types';

const enemyPools = new WeakMap<BattleState, { free: EnemyInst[]; plans: SpawnPlan[]; reserved: boolean }>();
const catalogs = new WeakMap<ContentPack, Map<string, EnemyDef>>();

export function enemyDefinition(pack: ContentPack, id: string): EnemyDef {
  let definitions = catalogs.get(pack);
  if (!definitions) {
    definitions = new Map(pack.enemies.map((def) => [def.id, def]));
    catalogs.set(pack, definitions);
  }
  return definitions.get(id)!;
}

export function prepareEnemies(state: BattleState, reserve = false) {
  const free: EnemyInst[] = [];
  const plans: SpawnPlan[] = [];
  if (reserve) {
    if (state.pack.enemies[0]) enemyDefinition(state.pack, state.pack.enemies[0].id);
    let capacity = 0;
    for (const wave of state.pack.waves) {
      capacity = Math.max(capacity, wave.groups.reduce((n, group) => n + Math.ceil(group.count * GAMBITS.swarm.count_mul), 0));
    }
    for (let i = 0; i < capacity; i++) {
      free.push(newEnemy());
      plans.push({ enemy_id: '', at_tick: 0, hp_mul: undefined });
    }
  }
  const pool = { free, plans, reserved: reserve };
  enemyPools.set(state, pool);
  return pool;
}

function newEnemy(): EnemyInst {
  return { iid: 0, def: '', hp: 0, max_hp: 0, progress: 0, x: 0, y: 0, life: 'pending', shred: 0, shred_until: 0 };
}

export function queueEnemy(s: BattleState, id: string, tick: number, hpMultiplier: number | undefined) {
  const pool = enemyPools.get(s) ?? prepareEnemies(s);
  const available = pool.plans.pop();
  if (!available && pool.reserved) throw new Error('Spawn plan pool exhausted');
  const plan = available ?? { enemy_id: '', at_tick: 0 };
  plan.enemy_id = id;
  plan.at_tick = tick;
  plan.hp_mul = hpMultiplier;
  s.spawn_queue.push(plan);
}

export function updateEnemies(s: BattleState, events: EventSink) {
  const { free, plans, reserved } = enemyPools.get(s) ?? prepareEnemies(s);
  const difficulty = s.pack.difficulty ?? 1;
  let due = 0;
  for (let i = 0; i < s.spawn_queue.length; i++) {
    const p = s.spawn_queue[i];
    if (p.at_tick > s.tick) break;
    const def = enemyDefinition(s.pack, p.enemy_id);
    const available = free.pop();
    if (!available && reserved) throw new Error('Enemy pool exhausted');
    const enemy = available ?? newEnemy();
    enemy.iid = s.next_iid++;
    enemy.def = def.id;
    enemy.hp = enemy.max_hp = Math.ceil(def.hp * difficulty * (p.hp_mul ?? 1));
    enemy.progress = 0;
    enemy.shred = enemy.shred_until = 0;
    enemy.life = 'pending';
    positionAt(s.pack.map.path, 0, enemy);
    s.enemies.push(enemy);
    const event = combatEvent(events, 'enemy_spawned');
    event.iid = enemy.iid;
    event.enemy_id = enemy.def;
    plans.push(p);
    due++;
  }
  if (due) {
    for (let i = due; i < s.spawn_queue.length; i++) s.spawn_queue[i - due] = s.spawn_queue[i];
    s.spawn_queue.length -= due;
  }
  for (let i = 0; i < s.enemies.length; i++) {
    const enemy = s.enemies[i];
    if (enemy.life !== 'alive') continue;
    const def = enemyDefinition(s.pack, enemy.def);
    enemy.progress += Math.max(1, Math.round(def.speed * difficulty));
    if (enemy.progress >= s.path_len) {
      const damage = Math.max(1, Math.round(def.base_damage * difficulty));
      enemy.progress = s.path_len;
      enemy.life = 'escaped';
      s.base_hp = Math.max(0, s.base_hp - damage);
      s.leaks++;
      const event = combatEvent(events, 'entity_escaped');
      event.iid = enemy.iid;
      event.base_damage = damage;
    }
    positionAt(s.pack.map.path, enemy.progress, enemy);
  }
}

export function recycleEnemies(s: BattleState) {
  const { free } = enemyPools.get(s)!;
  let count = 0;
  for (let i = 0; i < s.enemies.length; i++) {
    const enemy = s.enemies[i];
    if (enemy.life === 'dying' || enemy.life === 'escaped') free.push(enemy);
    else s.enemies[count++] = enemy;
  }
  s.enemies.length = count;
}

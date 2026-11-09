import { pickTarget } from './targeting';
import { towerStats, maxTowerLevel } from './upgrade';
import { xorshift32 } from './rng';
import { combatEvent, type EventSink } from './combatEvents';
import { enemyDefinition } from './enemies';
import type { BattleState, EnemyInst, Projectile, ProjectileDef, TowerInst } from './types';

type Stats = ReturnType<typeof towerStats>;
interface Intent { tower: TowerInst; enemy: EnemyInst; stats: Stats }
interface Arsenal {
  stats: Map<string, Stats[]>;
  branches: Map<string, Map<string, Stats>>;
  intents: Intent[];
  free: Projectile[];
  reserved: boolean;
}
const arsenals = new WeakMap<BattleState, Arsenal>();
const packStats = new WeakMap<BattleState['pack'], Pick<Arsenal, 'stats' | 'branches'> & { concurrency: number }>();
const TAU = Math.PI * 2;

function blankProjectile(): Projectile {
  return {
    kind: 'ARC', source: 0, target: 0, damage: 0, critical: false, effect: undefined, x: 0, y: 0, from_x: 0, from_y: 0,
    to_x: 0, to_y: 0, angle: 0.5, age: 0, duration: 0, height: 0, speed: 0, turn: 0.5, interval: 0,
  };
}

function prepareStats(pack: BattleState['pack']) {
  const statsById = new Map<string, Stats[]>();
  const branchesById = new Map<string, Map<string, Stats>>();
  let longest = 0, fastest = Infinity;
  let concurrency = 0;
  for (const def of pack.towers) {
    const levels = Array.from({ length: maxTowerLevel(def) }, (_, i) => towerStats(def, i + 1));
    const branches = new Map((def.branch_upgrades ?? []).map((item) => [item.id, towerStats(def, 1, item.id)]));
    statsById.set(def.id, levels);
    branchesById.set(def.id, branches);
    for (const stats of [...levels, ...branches.values()]) {
      if (!stats.projectile) continue;
      longest = Math.max(longest, stats.projectile.ticks);
      fastest = Math.min(fastest, stats.interval_ticks);
    }
  }
  if (longest) concurrency = Math.ceil(longest / fastest) + 1;
  const table = { stats: statsById, branches: branchesById, concurrency };
  packStats.set(pack, table);
  return table;
}

export function prepareArsenal(s: BattleState, reserve = false) {
  const table = packStats.get(s.pack) ?? prepareStats(s.pack);
  const arsenal: Arsenal = { stats: table.stats, branches: table.branches, intents: [], free: [], reserved: reserve };
  if (reserve) {
    const capacity = s.pack.map.buildable_cells.length;
    for (let i = 0; i < capacity; i++) arsenal.intents.push({ tower: null!, enemy: null!, stats: null! });
    for (let i = 0; i < capacity * table.concurrency; i++) arsenal.free.push(blankProjectile());
  }
  arsenals.set(s, arsenal);
  return arsenal;
}

function hit(s: BattleState, enemy: EnemyInst, amount: number, critical: boolean, effect: Stats['on_hit'],
  fromX: number, fromY: number, shot: Projectile | undefined, ev: EventSink) {
  if (enemy.life !== 'alive') return;
  const def = enemyDefinition(s.pack, enemy.def);
  const armor = Math.round((def.armor ?? 0) * (s.pack.difficulty ?? 1));
  const shred = (enemy.shred_until ?? 0) > s.tick ? enemy.shred ?? 0 : 0;
  const damage = Math.max(1, amount - Math.max(0, armor - shred));
  enemy.hp -= damage;
  const event = combatEvent(ev, 'damage_applied');
  event.target = enemy.iid; event.amount = damage; event.hp = Math.max(0, enemy.hp);
  event.x = enemy.x; event.y = enemy.y; event.max_hp = enemy.max_hp ?? def.hp; event.critical = critical;
  event.fromX = fromX; event.fromY = fromY; event.projectile = shot?.kind; event.arcHeight = shot?.height ?? 0;
  event.armorBlocked = Math.max(0, amount - damage);
  if (enemy.hp <= 0) {
    enemy.life = 'dying';
    s.gold += def.reward;
    s.kills++;
    const death = combatEvent(ev, 'entity_died');
    death.iid = enemy.iid; death.reward = def.reward; death.x = enemy.x; death.y = enemy.y;
  } else if (effect && effect.value >= shred && !def.immunities?.includes(effect.type)) {
    enemy.shred = effect.value;
    enemy.shred_until = s.tick + effect.duration_ticks;
  }
}

function launch(s: BattleState, arsenal: Arsenal, rule: ProjectileDef, t: TowerInst, e: EnemyInst, damage: number, critical: boolean, effect: Stats['on_hit']) {
  const available = arsenal.free.pop();
  if (!available && arsenal.reserved) throw new Error('Projectile pool exhausted');
  const shot = available ?? blankProjectile();
  shot.kind = rule.type;
  shot.source = t.iid;
  shot.target = e.iid;
  shot.damage = damage;
  shot.critical = critical;
  shot.effect = effect;
  shot.x = shot.from_x = t.x;
  shot.y = shot.from_y = t.y;
  shot.to_x = e.x;
  shot.to_y = e.y;
  shot.angle = rule.type === 'HOMING' ? Math.atan2(e.y - t.y, e.x - t.x) : 0;
  shot.age = 0;
  shot.duration = rule.ticks;
  shot.height = rule.type === 'ARC' ? rule.height : 0;
  shot.speed = rule.type === 'HOMING' ? rule.speed : 0;
  shot.turn = rule.type === 'HOMING' ? rule.turn_rate : 0;
  shot.interval = rule.type === 'BEAM' ? rule.interval_ticks : 0;
  s.projectiles.push(shot);
}

function advance(shot: Projectile, target: EnemyInst) {
  shot.to_x = target.x;
  shot.to_y = target.y;
  if (shot.kind === 'BEAM') {
    shot.x = target.x;
    shot.y = target.y;
    return (shot.age - 1) % shot.interval === 0;
  }
  if (shot.kind === 'ARC') {
    const t = shot.age / shot.duration;
    shot.x = Math.round(shot.from_x + (target.x - shot.from_x) * t);
    shot.y = Math.round(shot.from_y + (target.y - shot.from_y) * t);
    return shot.age === shot.duration;
  }
  const dx = target.x - shot.x, dy = target.y - shot.y;
  const desired = Math.atan2(dy, dx);
  const delta = (desired - shot.angle + Math.PI * 3) % TAU - Math.PI;
  shot.angle = (shot.angle + Math.max(-shot.turn, Math.min(shot.turn, delta)) + TAU) % TAU;
  if (dx * dx + dy * dy <= shot.speed * shot.speed && Math.abs(delta) <= shot.turn) return true;
  shot.x += Math.round(Math.cos(shot.angle) * shot.speed);
  shot.y += Math.round(Math.sin(shot.angle) * shot.speed);
  return false;
}

export function updateAttacks(s: BattleState, ev: EventSink) {
  const arsenal = arsenals.get(s) ?? prepareArsenal(s);
  let count = 0;
  for (let i = 0; i < s.towers.length; i++) {
    const tower = s.towers[i];
    if (tower.life !== 'alive' || (tower.cooldown > 0 && --tower.cooldown > 0)) continue;
    const stats = tower.branch ? arsenal.branches.get(tower.def)!.get(tower.branch)! :
      arsenal.stats.get(tower.def)![((tower.level ?? 1) - 1)];
    const enemy = pickTarget(tower, s.enemies, stats.range, tower.targeting ?? stats.targeting ?? 'first_on_path');
    if (!enemy) continue;
    const intent = arsenal.intents[count] ?? (arsenal.intents[count] = { tower, enemy, stats });
    intent.tower = tower;
    intent.enemy = enemy;
    intent.stats = stats;
    tower.cooldown = stats.interval_ticks;
    count++;
  }
  let retained = 0;
  for (let i = 0; i < s.projectiles.length; i++) {
    const shot = s.projectiles[i];
    let target: EnemyInst | undefined;
    for (let j = 0; j < s.enemies.length; j++) {
      const enemy = s.enemies[j];
      if (enemy.iid === shot.target) { target = enemy; break; }
    }
    shot.age++;
    if (!target || target.life !== 'alive') { arsenal.free.push(shot); continue; }
    const impact = advance(shot, target);
    if (impact) hit(s, target, shot.damage, shot.critical, shot.effect,
      shot.kind === 'HOMING' ? shot.x : shot.from_x, shot.kind === 'HOMING' ? shot.y : shot.from_y, shot, ev);
    if (shot.age >= shot.duration || (impact && shot.kind !== 'BEAM')) arsenal.free.push(shot);
    else s.projectiles[retained++] = shot;
  }
  s.projectiles.length = retained;

  for (let i = 0; i < count; i++) {
    const { tower, enemy, stats } = arsenal.intents[i];
    let critical = false;
    if (stats.crit_percent) {
      s.rng = xorshift32(s.rng);
      critical = s.rng % 100 < stats.crit_percent;
    }
    const armorType = enemyDefinition(s.pack, enemy.def).armor_type ?? '';
    const multiplier = stats.damage_vs_armor?.[armorType];
    const vsArmor = typeof multiplier === 'number' ? multiplier : 1;
    const damage = Math.round(stats.damage * vsArmor * (critical ? stats.crit_multiplier ?? 1 : 1));
    const event = combatEvent(ev, 'attack');
    event.tower = tower.iid; event.target = enemy.iid; event.fx = tower.x; event.fy = tower.y;
    event.tx = enemy.x; event.ty = enemy.y; event.projectile = stats.projectile?.type;
    event.arcHeight = stats.projectile?.type === 'ARC' ? stats.projectile.height : 0;
    if (stats.projectile) launch(s, arsenal, stats.projectile, tower, enemy, damage, critical, stats.on_hit);
    else hit(s, enemy, damage, critical, stats.on_hit, tower.x, tower.y, undefined, ev);
  }
}

export function clearProjectiles(s: BattleState) {
  const arsenal = arsenals.get(s)!;
  for (const shot of s.projectiles) arsenal.free.push(shot);
  s.projectiles.length = 0;
}

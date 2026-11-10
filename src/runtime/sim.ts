// Deterministic tower-defense simulation. Zero dependencies.
// Tick order (plan Appendix A): activate pending -> apply commands -> spawn (pending)
// -> enemies move / escape -> towers pick first_on_path -> resolve attacks in order
// -> cleanup dying/escaped -> win/loss (loss first) -> tick+1.
import type { BattleState, Command, ContentPack, EnemyInst, GameEvent, TowerInst, Cell } from './types';
import { seedState } from './rng';
import { GAMBITS, gambitBonus, isGambitId } from './gambit';

export const TICKS_PER_SECOND = 30;
export const CELL = 1000; // milli-cell

const key = (x: number, y: number) => `${x},${y}`;

/** 格坐标 → 毫格（格心 = c*1000+500）。自由几何下坐标可带小数：先取整到毫格，保证跨平台逐位确定。 */
export const milliOf = (c: number): number => Math.round(c * CELL) + 500;

/** 一段路径的毫格长度：轴对齐段 = |Δ|（与经典整数格逐位一致）；斜段 = round(√(Δx²+Δy²))（整数入参，sqrt 是 IEEE 精确舍入）。 */
function segSpan(a: Cell, b: Cell): { dx: number; dy: number; len: number; axis: boolean } {
  const dx = Math.round((b.x - a.x) * CELL), dy = Math.round((b.y - a.y) * CELL);
  const axis = dx === 0 || dy === 0;
  return { dx, dy, axis, len: axis ? Math.abs(dx) + Math.abs(dy) : Math.round(Math.sqrt(dx * dx + dy * dy)) };
}

export function pathLength(path: Cell[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += segSpan(path[i - 1], path[i]).len;
  return len;
}

/** integer position (milli-cell, cell centre = c*1000+500) at a given progress along the path */
export function positionAt(path: Cell[], progress: number): { x: number; y: number } {
  let left = progress;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const sp = segSpan(a, path[i]);
    if (left <= sp.len) {
      if (sp.axis) return { x: milliOf(a.x) + Math.sign(sp.dx) * left, y: milliOf(a.y) + Math.sign(sp.dy) * left };
      return { x: milliOf(a.x) + Math.round((sp.dx * left) / sp.len), y: milliOf(a.y) + Math.round((sp.dy * left) / sp.len) };
    }
    left -= sp.len;
  }
  const end = path[path.length - 1];
  return { x: milliOf(end.x), y: milliOf(end.y) };
}

/**
 * 沿路径每 1 格取一个采样点（毫格）。经典整数格路径 = 全部路径格的格心（与旧的逐格展开一致）；
 * 自由几何下不能逐格展开（坐标带小数会走不到终点），军师覆盖表 / 预演 / 绘制统一用它。
 */
export function pathSamples(path: Cell[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  if (!path.length) return out;
  const len = pathLength(path);
  for (let p = 0; p <= len; p += CELL) out.push(positionAt(path, p));
  return out;
}

export function pathForBranch(pack: ContentPack, branch = 0): Cell[] {
  if (!branch || !pack.map.branch_paths || !pack.map.branch_paths.length) return pack.map.path;
  return pack.map.branch_paths[(branch - 1) % pack.map.branch_paths.length] ?? pack.map.path;
}

/**
 * 塔阵联动博弈规则（参考围棋「气与连接」/ 象棋「子力协同」）：
 * - 三元共鸣阵（Trinity Resonance）：半径 3.6 格内同时存在破盾+压制+破甲 3 种异构塔，形成三角闭环，伤害 +35%、射程 +15%；
 * - 双生交叉火网（Crossfire Link）：半径 3.2 格内存在异种塔协同，伤害 +20%；
 * - 同轨超导阵列（Relay Array）：半径 2.8 格内存在同种塔串联，攻速提升（间隔 ×0.85）。
 */
export interface FormationSynergy {
  towerIid: number;
  kind: 'trinity' | 'crossfire' | 'relay' | 'none';
  damageMul: number;
  rangeMul: number;
  intervalMul: number;
  links: { toIid: number; x0: number; y0: number; x1: number; y1: number; kind: 'trinity' | 'crossfire' | 'relay' }[];
}

export function computeFormationSynergies(towers: TowerInst[]): Map<number, FormationSynergy> {
  const out = new Map<number, FormationSynergy>();
  const alive = towers.filter((t) => t.life === 'alive' || t.life === 'pending');
  for (const t of alive) {
    const neighbors = alive.filter((o) => o.iid !== t.iid && Math.hypot(o.cx - t.cx, o.cy - t.cy) <= 3.6);
    if (!neighbors.length) {
      out.set(t.iid, { towerIid: t.iid, kind: 'none', damageMul: 1, rangeMul: 1, intervalMul: 1, links: [] });
      continue;
    }
    const defs = new Set<string>([t.def, ...neighbors.map((n) => n.def)]);
    const hasSame = neighbors.some((n) => n.def === t.def && Math.hypot(n.cx - t.cx, n.cy - t.cy) <= 2.85);
    const hasDiff = neighbors.some((n) => n.def !== t.def && Math.hypot(n.cx - t.cx, n.cy - t.cy) <= 3.35);
    let kind: FormationSynergy['kind'] = 'none';
    let damageMul = 1, rangeMul = 1, intervalMul = 1;
    if (defs.size >= 3) {
      kind = 'trinity';
      damageMul = 1.35;
      rangeMul = 1.15;
      intervalMul = 0.88;
    } else if (hasDiff) {
      kind = 'crossfire';
      damageMul = 1.20;
      rangeMul = 1.08;
    } else if (hasSame) {
      kind = 'relay';
      intervalMul = 0.85;
    }
    const links = neighbors
      .filter((n) => n.iid > t.iid)
      .map((n) => ({
        toIid: n.iid,
        x0: t.x,
        y0: t.y,
        x1: n.x,
        y1: n.y,
        kind: (defs.size >= 3 ? 'trinity' : n.def !== t.def ? 'crossfire' : 'relay') as 'trinity' | 'crossfire' | 'relay',
      }));
    out.set(t.iid, { towerIid: t.iid, kind, damageMul, rangeMul, intervalMul, links });
  }
  return out;
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
    gambit: null,
    craters: [],
    demolished: [],
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
    gambit: s.gambit ? { ...s.gambit } : null,
    craters: s.craters ? s.craters.map((c) => ({ ...c })) : [],
    demolished: s.demolished ? s.demolished.map((d) => ({ ...d })) : [],
  };
}

function scheduleWave(s: BattleState, ev: GameEvent[]) {
  const wave = s.pack.waves[s.wave_index];
  // 变招只作用于它被接下时的那一波（gambit.wave === 当前 wave_index）；没接或接的是别的波 → 倍率全 1，行为与无变招完全一致
  const g0 = s.gambit && s.gambit.wave === s.wave_index ? GAMBITS[s.gambit.id] : null;
  const branchCount = 1 + (s.pack.map.branch_paths?.length ?? 0);
  let at = s.tick; // spawned this tick (pending) -> active next tick
  let total = 0;
  for (let gi = 0; gi < wave.groups.length; gi++) {
    const g = wave.groups[gi];
    const count = g0 ? Math.ceil(g.count * g0.count_mul) : g.count;
    const interval = g0 ? Math.max(1, Math.round(g.interval_ticks * g0.interval_mul)) : g.interval_ticks;
    for (let i = 0; i < count; i++) {
      const plan: BattleState['spawn_queue'][number] = { enemy_id: g.enemy_id, at_tick: at };
      if (g0 && g0.hp_mul !== 1) plan.hp_mul = g0.hp_mul;
      if (branchCount > 1) {
        const assignedBranch = g.branch !== undefined ? g.branch % branchCount : (gi + i) % branchCount;
        // 若某条支线已被炸断，新出兵自动改道汇入未炸毁的主路/邻路
        const blocked = s.craters?.some((cr) => cr.branch === assignedBranch) ?? false;
        const finalBranch = blocked ? 0 : assignedBranch;
        if (finalBranch > 0) plan.branch = finalBranch;
      }
      s.spawn_queue.push(plan);
      at += interval;
      total++;
    }
  }
  s.wave_index++;
  s.phase = 'wave';
  ev.push({ type: 'wave_started', wave: s.wave_index, total });
}

/** 变招：只在建造期、还有下一波、本建造期没接过时成立；成立即刻加 CP，波次改动在 scheduleWave 里兑现。 */
function applyGambit(s: BattleState, c: Extract<Command, { type: 'gambit' }>, ev: GameEvent[]) {
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

/** Atomic build: all checks first, then mutate. Any failure => no CP spent, no cell taken. */
function applyBuild(s: BattleState, c: Extract<Command, { type: 'build' }>, ev: GameEvent[]) {
  const reject = (code: string, message: string) =>
    ev.push({ type: 'build_rejected', code, message, tower_id: c.tower_id, x: c.x, y: c.y });
  const def = s.pack.towers.find((t) => t.id === c.tower_id);
  if (!def) return reject('UNKNOWN_TOWER', `没有名为 ${c.tower_id} 的塔`);
  if (!s.pack.map.free && (!Number.isInteger(c.x) || !Number.isInteger(c.y))) return reject('BAD_CELL', '坐标必须是整数格');
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return reject('BAD_CELL', '坐标不合法');
  if (!s.pack.map.buildable_cells.some((b) => b.x === c.x && b.y === c.y)) return reject('NOT_BUILDABLE', '这里不能建塔');
  if (s.occupied.includes(key(c.x, c.y))) return reject('OCCUPIED', '这格已经有塔了');
  if (s.gold < def.cost) return reject('NOT_ENOUGH_GOLD', `CP 不足（需要 ${def.cost} CP，现有 ${s.gold} CP）`);
  s.gold -= def.cost;
  s.occupied.push(key(c.x, c.y));
  const t: TowerInst = {
    iid: s.next_iid++, def: def.id, cx: c.x, cy: c.y,
    x: milliOf(c.x), y: milliOf(c.y), cooldown: 0, life: 'pending',
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
    } else if (c.type === 'gambit') {
      applyGambit(s, c, ev);
    } else if (c.type === 'blast_road') {
      const cost = 35;
      if (s.gold >= cost) {
        const branchCount = 1 + (pack.map.branch_paths?.length ?? 0);
        const branch = c.branch !== undefined ? c.branch % Math.max(1, branchCount) : (branchCount > 1 ? 1 : 0);
        const targetPath = pathForBranch(pack, branch);
        const pLen = pathLength(targetPath);
        const prog = Math.round(pLen * 0.48);
        const midPt = positionAt(targetPath, prog);
        // 自由几何：弹坑就在路线上的那一点（不取整到格）；经典格：所在格
        const cx = c.x !== undefined ? c.x : pack.map.free ? (midPt.x - 500) / CELL : Math.floor(midPt.x / CELL);
        const cy = c.y !== undefined ? c.y : pack.map.free ? (midPt.y - 500) / CELL : Math.floor(midPt.y / CELL);
        s.gold -= cost;
        if (!s.craters) s.craters = [];
        s.craters.push({
          id: `crater-${branch}-${s.craters.length + 1}`,
          branch,
          progress: prog,
          cx,
          cy,
          createdAtTick: s.tick,
        });
        // 已在队列里准备走该分支的待出兵单位自动改道汇入主路
        for (const q of s.spawn_queue) {
          if ((q.branch ?? 0) === branch && branch > 0) delete q.branch;
        }
        // 对炸点附近的敌军造成爆破冲击伤害与进度击退
        let damaged = 0;
        const bx = milliOf(cx), by = milliOf(cy);
        for (const e of s.enemies) {
          if (e.life !== 'alive') continue;
          const dist = Math.hypot(e.x - bx, e.y - by);
          if (dist <= 3200 || (e.branch ?? 0) === branch) {
            e.hp -= 65;
            e.progress = Math.max(0, e.progress - 800);
            damaged++;
            if (e.hp <= 0) {
              e.life = 'dying';
              const def = pack.enemies.find((d) => d.id === e.def)!;
              s.gold += def.reward;
              s.kills++;
              ev.push({ type: 'entity_died', iid: e.iid, reward: def.reward, x: e.x, y: e.y });
            }
          }
        }
        ev.push({ type: 'road_blasted', branch, cx, cy, cost, damagedEnemies: damaged });
      }
    } else if (c.type === 'demolish_building') {
      if (!s.demolished) s.demolished = [];
      if (!s.demolished.some((d) => d.key === c.key)) {
        const cx = c.x !== undefined ? c.x : Math.floor(pack.map.width / 2);
        const cy = c.y !== undefined ? c.y : Math.floor(pack.map.height / 2);
        const bonusCp = 30;
        s.gold += bonusCp;
        const unlockedSlot = pack.map.buildable_cells.findIndex((b) => b.x === cx && b.y === cy);
        s.demolished.push({
          key: c.key,
          label: c.label || c.key,
          cx,
          cy,
          unlockedSlot: unlockedSlot >= 0 ? unlockedSlot : 0,
          createdAtTick: s.tick,
        });
        let damaged = 0;
        const bx = milliOf(cx), by = milliOf(cy);
        for (const e of s.enemies) {
          if (e.life !== 'alive') continue;
          if (Math.hypot(e.x - bx, e.y - by) <= 3800) {
            e.hp -= 80;
            damaged++;
            if (e.hp <= 0) {
              e.life = 'dying';
              const def = pack.enemies.find((d) => d.id === e.def)!;
              s.gold += def.reward;
              s.kills++;
              ev.push({ type: 'entity_died', iid: e.iid, reward: def.reward, x: e.x, y: e.y });
            }
          }
        }
        ev.push({ type: 'building_demolished', key: c.key, label: c.label || c.key, cx, cy, bonusCp, damagedEnemies: damaged });
      }
    } else if (c.type === 'advisor_bounty') {
      if (c.bonus > 0) {
        s.gold += c.bonus;
        ev.push({ type: 'advisor_bounty_awarded', wave: c.wave, bonus: c.bonus, predicted: c.predicted, actual: c.actual });
      }
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
      const bIdx = p.branch ?? 0;
      const ePath = pathForBranch(pack, bIdx);
      const pos = positionAt(ePath, 0);
      const hp = p.hp_mul ? Math.ceil(def.hp * p.hp_mul) : def.hp;   // 变招「铁甲」：出生时加血，其余路径不变
      const e: EnemyInst = {
        iid: s.next_iid++,
        def: def.id,
        hp,
        progress: 0,
        x: pos.x,
        y: pos.y,
        life: 'pending',
        ...(bIdx > 0 ? { branch: bIdx } : {}),
      };
      s.enemies.push(e);
      ev.push({ type: 'enemy_spawned', iid: e.iid, enemy_id: def.id, ...(bIdx > 0 ? { branch: bIdx } : {}) });
    }
  }

  // 4. movement + escape (escape: base damage once, no reward)
  for (const e of s.enemies) {
    if (e.life !== 'alive') continue;
    const def = pack.enemies.find((d) => d.id === e.def)!;
    const bIdx = e.branch ?? 0;
    const ePath = pathForBranch(pack, bIdx);
    const ePathLen = bIdx > 0 ? pathLength(ePath) : s.path_len;
    // 若经过被炸毁的道路弹坑区域，移速降低 45%
    const inCrater = s.craters?.some((cr) => cr.branch === bIdx && Math.abs(e.progress - cr.progress) <= 1500) ?? false;
    const stepSpeed = inCrater ? Math.max(8, Math.round(def.speed * 0.55)) : def.speed;
    e.progress += stepSpeed;
    if (e.progress >= ePathLen) {
      e.progress = ePathLen;
      e.life = 'escaped';
      s.base_hp = Math.max(0, s.base_hp - def.base_damage);
      s.leaks++;
      ev.push({ type: 'entity_escaped', iid: e.iid, base_damage: def.base_damage });
    }
    const p = positionAt(ePath, e.progress);
    e.x = p.x; e.y = p.y;
  }

  // 5. targeting: first_on_path = alive enemy in range with max progress (tie: lower iid)
  // 当地图为多分支（branch_paths 非空）或已触发爆破/推倒时启用塔阵协同增益；经典单线 DEFAULT_PACK 保持原数值以保证 D1 历史回放 checksum 恒等
  const useSynergy = !!(pack.map.branch_paths && pack.map.branch_paths.length > 0) || (s.craters && s.craters.length > 0) || (s.demolished && s.demolished.length > 0);
  const synMap = useSynergy ? computeFormationSynergies(s.towers) : null;
  const intents: { tower: TowerInst; target: EnemyInst; damage: number }[] = [];
  for (const t of s.towers) {
    if (t.life !== 'alive') continue;
    if (t.cooldown > 0) { t.cooldown--; if (t.cooldown > 0) continue; }
    const def = pack.towers.find((d) => d.id === t.def)!;
    const syn = synMap?.get(t.iid);
    const effRange = syn ? Math.round(def.range * syn.rangeMul) : def.range;
    const r2 = effRange * effRange;
    let best: EnemyInst | null = null;
    for (const e of s.enemies) {
      if (e.life !== 'alive') continue;
      const dx = e.x - t.x, dy = e.y - t.y;
      if (dx * dx + dy * dy > r2) continue;
      if (!best || e.progress > best.progress) best = e;
    }
    if (best) {
      const effDamage = syn ? Math.max(1, Math.round(def.damage * syn.damageMul)) : def.damage;
      const effInterval = syn ? Math.max(3, Math.round(def.interval_ticks * syn.intervalMul)) : def.interval_ticks;
      intents.push({ tower: t, target: best, damage: effDamage });
      t.cooldown = effInterval;
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

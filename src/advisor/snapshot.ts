// 极简决策快照：BattleState → Snapshot（06 §3）。槽位号 = buildable_cells 下标；坐标只在 slotCell() 里还原给采纳用，永远不进快照。
import type { BattleState, Cell, ContentPack, GambitId } from '../runtime/types';
import { GAMBITS, GAMBIT_IDS, gambitBonus } from '../runtime/gambit';
import { TICKS_PER_SECOND, CELL } from '../runtime/sim';
import { LIMITS, type Snapshot, type SnapshotSlot } from './types';

const key = (x: number, y: number) => `${x},${y}`;

/** 路径折点 → 全部路径格（与 content/validate.expandPath 同算法，这里不依赖内容层） */
function pathCells(path: Cell[]): Cell[] {
  const out: Cell[] = [];
  if (!path.length) return out;
  out.push({ x: path[0].x, y: path[0].y });
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
    let x = a.x, y = a.y;
    while (x !== b.x || y !== b.y) { x += dx; y += dy; out.push({ x, y }); }
  }
  return out;
}

const reachCache = new WeakMap<ContentPack, Record<number, Record<string, number>>>();
/** 每个槽 × 每种塔：射程内的路径格数。按内容包缓存（内容包不可变）。 */
export function reachTable(pack: ContentPack): Record<number, Record<string, number>> {
  const hit = reachCache.get(pack);
  if (hit) return hit;
  const cells = pathCells(pack.map.path);
  const table: Record<number, Record<string, number>> = {};
  pack.map.buildable_cells.forEach((c, id) => {
    const row: Record<string, number> = {};
    const sx = c.x * CELL + 500, sy = c.y * CELL + 500;
    for (const t of pack.towers) {
      const r2 = t.range * t.range;
      row[t.id] = cells.filter((p) => { const dx = p.x * CELL + 500 - sx, dy = p.y * CELL + 500 - sy; return dx * dx + dy * dy <= r2; }).length;
    }
    table[id] = row;
  });
  reachCache.set(pack, table);
  return table;
}

export function slotCell(pack: ContentPack, slot: number): Cell | null {
  if (!Number.isInteger(slot) || slot < 0 || slot >= pack.map.buildable_cells.length) return null;
  const c = pack.map.buildable_cells[slot];
  return { x: c.x, y: c.y };
}
export function cellSlot(pack: ContentPack, x: number, y: number): number {
  return pack.map.buildable_cells.findIndex((c) => c.x === x && c.y === y);
}

const bestReach = (row: Record<string, number>) => Math.max(0, ...Object.values(row));

/** 所有槽位的当前状态（已占 / 空）；给快照和本地军师共用 */
export function allSlots(s: BattleState): SnapshotSlot[] {
  const pack = s.pack, reach = reachTable(pack);
  const towerAt = new Map<string, string>();
  for (const t of s.towers) towerAt.set(key(t.cx, t.cy), t.def);
  return pack.map.buildable_cells.map((c, id) => {
    const tower = towerAt.get(key(c.x, c.y)) ?? null;
    return { id, open: tower === null && !s.occupied.includes(key(c.x, c.y)), tower, reach: reach[id] };
  });
}

/** 快照里的槽位：已占全送 + 空槽按最佳覆盖取前 N（并列按 id 小者），顺序：先已占后空 */
export function snapshotSlots(s: BattleState, limit: number = LIMITS.slotsInSnapshot): SnapshotSlot[] {
  const all = allSlots(s);
  const taken = all.filter((x) => !x.open);
  const open = all.filter((x) => x.open).sort((a, b) => bestReach(b.reach) - bestReach(a.reach) || a.id - b.id).slice(0, limit);
  return [...taken, ...open];
}

function groupCounts(groups: { enemy_id: string; count: number }[]): { type: string; n: number }[] {
  const m = new Map<string, number>();
  for (const g of groups) m.set(g.enemy_id, (m.get(g.enemy_id) ?? 0) + g.count);
  return [...m].map(([type, n]) => ({ type, n }));
}

export interface SnapshotExtra { score?: { you: number; advisor: number }; cleared?: number; lang?: 'zh' | 'en' }

export function buildSnapshot(s: BattleState, extra: SnapshotExtra = {}): Snapshot {
  const pack = s.pack;
  const phase: Snapshot['phase'] = s.phase === 'wave' ? 'wave' : 'build';
  const lang = extra.lang ?? 'zh';
  // 下一波 = 建造期时将要开的那一波；波内则是再下一波
  const nextIdx = s.wave_index;
  const next = pack.waves[nextIdx] ? groupCounts(pack.waves[nextIdx].groups) : null;
  // 当前波（波内）：还没出生的 + 场上的，按种类合并
  let now: Snapshot['wave']['now'] = null;
  if (phase === 'wave') {
    const m = new Map<string, number>();
    for (const p of s.spawn_queue) m.set(p.enemy_id, (m.get(p.enemy_id) ?? 0) + 1);
    for (const e of s.enemies) if (e.life === 'alive' || e.life === 'pending') m.set(e.def, (m.get(e.def) ?? 0) + 1);
    now = [...m].map(([type, n]) => ({ type, n }));
  }
  const field: Snapshot['field'] = {};
  for (const e of s.enemies) {
    if (e.life !== 'alive' && e.life !== 'pending') continue;
    const f = field[e.def] ?? (field[e.def] = { n: 0, front: 0 });
    f.n++;
    f.front = Math.max(f.front, Math.round((e.progress / Math.max(1, s.path_len)) * 100) / 100);
  }
  const offers = phase === 'build' && nextIdx < pack.waves.length && !(s.gambit && s.gambit.wave === nextIdx)
    ? GAMBIT_IDS.map((id: GambitId) => ({ id, name: GAMBITS[id].name[lang], line: GAMBITS[id].line[lang], bonus: gambitBonus(pack, nextIdx, id) }))
    : [];
  return {
    v: 1,
    stateVersion: s.tick,
    phase,
    wave: { index: s.wave_index, total: pack.waves.length, next, now },
    base: { hp: s.base_hp, max: pack.map.base_hp },
    gold: s.gold,
    towers: pack.towers.map((t) => ({ id: t.id, name: t.display_name, cost: t.cost, dmg: t.damage, every: Math.round((t.interval_ticks / TICKS_PER_SECOND) * 10) / 10, range: Math.round((t.range / CELL) * 10) / 10 })),
    enemies: pack.enemies.map((e) => ({ id: e.id, name: e.display_name, hp: e.hp, speed: Math.round((e.speed * TICKS_PER_SECOND / CELL) * 10) / 10, dmg: e.base_damage, reward: e.reward })),
    slots: snapshotSlots(s),
    field,
    gambit: { taken: s.gambit && s.gambit.wave === nextIdx ? s.gambit.id : null, offers },
    history: { kills: s.kills, leaks: s.leaks, cleared: extra.cleared ?? Math.max(0, s.wave_index - (phase === 'wave' ? 1 : 0)), score: extra.score ?? { you: 0, advisor: 0 } },
  };
}

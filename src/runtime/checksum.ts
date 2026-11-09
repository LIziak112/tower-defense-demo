import type { BattleState } from './types';
// FNV-1a 32 over a canonical serialization of LOGIC fields only (no colors / presentation).
export function checksum(s: BattleState): string {
  const parts: (string | number)[] = [s.tick, s.rng, s.next_iid, s.gold, s.base_hp, s.phase, s.wave_index, s.kills, s.leaks];
  for (const p of s.spawn_queue) { parts.push('q', p.enemy_id, p.at_tick); if (p.hp_mul) parts.push(p.hp_mul); }   // 没有变招时串与以前完全一致
  for (const t of s.towers) {
    parts.push('t', t.iid, t.def, t.cx, t.cy, t.cooldown, t.life);
    if (t.level && t.level > 1) parts.push('lv', t.level);
    if (t.targeting) parts.push('aim', t.targeting);
    if (t.branch) parts.push('branch', t.branch);
  }
  for (const e of s.enemies) {
    parts.push('e', e.iid, e.def, e.hp, e.progress, e.x, e.y, e.life);
    if ((e.shred_until ?? 0) > s.tick) parts.push('shred', e.shred ?? 0, e.shred_until!);
  }
  for (const p of s.projectiles) {
    parts.push('p', p.kind, p.source, p.target, p.damage, Number(p.critical), p.x, p.y, p.from_x, p.from_y, p.to_x, p.to_y,
      p.angle, p.age, p.duration, p.height, p.speed, p.turn, p.interval, p.effect?.type ?? '', p.effect?.value ?? 0, p.effect?.duration_ticks ?? 0);
  }
  if (s.pack.wave_rules) parts.push('prep', s.prep_until, s.build_cooldown_credit);
  if (s.pack.difficulty && s.pack.difficulty !== 1) parts.push('difficulty', s.pack.difficulty);
  if (s.gambit) parts.push('g', s.gambit.wave, s.gambit.id, s.gambit.bonus);
  const str = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

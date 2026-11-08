import type { BattleState } from './types';
// FNV-1a 32 over a canonical serialization of LOGIC fields only (no colors / presentation).
export function checksum(s: BattleState): string {
  const parts: (string | number)[] = [s.tick, s.rng, s.next_iid, s.gold, s.base_hp, s.phase, s.wave_index, s.kills, s.leaks];
  for (const p of s.spawn_queue) { parts.push('q', p.enemy_id, p.at_tick); if (p.hp_mul) parts.push(p.hp_mul); }   // 没有变招时串与以前完全一致
  for (const t of s.towers) parts.push('t', t.iid, t.def, t.cx, t.cy, t.cooldown, t.life);
  for (const e of s.enemies) parts.push('e', e.iid, e.def, e.hp, e.progress, e.x, e.y, e.life);
  if (s.gambit) parts.push('g', s.gambit.wave, s.gambit.id, s.gambit.bonus);
  const str = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

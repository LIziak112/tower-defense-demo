// RawPack (validated, Demo §4 format) -> runtime ContentPack.
import type { RawPack } from './schema';
import type { ContentPack } from '../runtime/types';
import assets from './assets.json';
const color = (palette: string, role: 'friend' | 'enemy') => {
  const p = assets.palettes.find((x) => x.palette_id === palette);
  return (p?.colors as Record<string, string> | undefined)?.[role] ?? (role === 'enemy' ? '#C84B4B' : '#6FB1FF');
};
export function compilePack(p: RawPack): ContentPack {
  return {
    meta: { theme: p.meta.theme, description: p.meta.description },
    towers: p.towers.map((t) => ({ id: t.id, display_name: t.display_name, cost: t.components.Buildable.cost, damage: t.components.Attack.damage, range: t.components.Attack.range_milli, interval_ticks: t.components.Attack.interval_ticks, color: color(t.components.Presentation.palette_id, 'friend') })),
    enemies: p.enemies.map((e) => ({ id: e.id, display_name: e.display_name, hp: e.components.Health.max, speed: e.components.Movement.speed_milli_per_tick, base_damage: e.components.PathFollower.base_damage, reward: e.components.Reward.gold, color: color(e.components.Presentation.palette_id, 'enemy') })),
    map: { width: p.map.grid.width, height: p.map.grid.height, path: p.map.path.map(([x, y]) => ({ x, y })), buildable_cells: p.map.buildable_cells.map(([x, y]) => ({ x, y })), base_hp: p.map.base.max_health, starting_gold: p.map.starting_gold },
    waves: p.waves.map((w) => ({ id: w.id, groups: w.groups.map((g) => ({ ...g })) })),
  };
}

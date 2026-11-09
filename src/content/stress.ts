import type { Command, ContentPack } from '../runtime';
import { DEFAULT_PACK } from './default';
import rules from './packs/stress-rules.json';

export function stressPack(base: ContentPack): ContentPack {
  const towers = base.towers.map((tower) => ({ ...tower, ...rules.attack }));
  const enemy = { ...base.enemies[0], ...rules.enemy };
  return {
    ...base, towers, enemies: [enemy], difficulty: 1, wave_rules: undefined,
    map: { ...DEFAULT_PACK.map, starting_gold: rules.towers * Math.max(...towers.map((tower) => tower.cost)) },
    waves: [{ id: 'stress', groups: [{ enemy_id: enemy.id, count: rules.enemies, interval_ticks: 1 }] }],
  };
}

export function stressCommands(pack: ContentPack): Command[] {
  const commands: Command[] = pack.map.buildable_cells.slice(0, rules.towers).map(({ x, y }, i) => ({
    type: 'build', tower_id: pack.towers[i % pack.towers.length].id, x, y,
  }));
  commands.push({ type: 'start_wave' });
  return commands;
}

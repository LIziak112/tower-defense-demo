import type { ContentPack } from '../runtime';

export function artilleryTrial(campaign: ContentPack): ContentPack {
  const cannon = campaign.towers.find((tower) => tower.id === 'catapult')!;
  const footman = campaign.enemies.find((enemy) => enemy.id === 'footman')!;
  return {
    meta: { theme: '长坂 · 重炮试射', description: '在敌军进入关门前完成拦截。' },
    towers: [{
      ...cannon, display_name: '重炮', cost: 110, damage: 60, range: 3900, interval_ticks: 38,
      projectile: { type: 'ARC', ticks: 13, height: 920 }, levels: [], branch_upgrades: [],
    }],
    enemies: [{ ...footman, hp: 106, speed: 63, reward: 5 }],
    map: {
      width: 10, height: 6, starting_gold: 110, base_hp: 4,
      path: [{ x: 0, y: 2 }, { x: 7, y: 2 }, { x: 7, y: 4 }, { x: 9, y: 4 }],
      buildable_cells: [
        { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }, { x: 5, y: 1 }, { x: 6, y: 1 },
        { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 4, y: 3 }, { x: 5, y: 3 }, { x: 6, y: 3 }, { x: 8, y: 3 },
      ],
    },
    waves: [{ id: 'artillery-trial', groups: [{ enemy_id: footman.id, count: 8, interval_ticks: 72 }] }],
  };
}

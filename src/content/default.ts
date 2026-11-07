// D1 hard-coded content (plan Appendix A). D2 replaces this with validated JSON packs.
import type { Cell, ContentPack } from '../runtime/types';

const W = 12, H = 9;
// single path, 6 turning points, axis-aligned adjacent segments
export const PATH: Cell[] = [
  { x: 0, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 3 }, { x: 9, y: 3 },
  { x: 9, y: 6 }, { x: 3, y: 6 }, { x: 3, y: 8 }, { x: 11, y: 8 },
];

function pathCells(path: Cell[]): Set<string> {
  const out = new Set<string>();
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
    let x = a.x, y = a.y;
    out.add(`${x},${y}`);
    while (x !== b.x || y !== b.y) { x += dx; y += dy; out.add(`${x},${y}`); }
  }
  return out;
}

const onPath = pathCells(PATH);
const buildable: Cell[] = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!onPath.has(`${x},${y}`)) buildable.push({ x, y });

export const DEFAULT_PACK: ContentPack = {
  meta: { theme: '长坂坡·雨夜（灰盒）', description: 'D1 硬编码灰盒关卡' },
  towers: [
    { id: 'crossbow', display_name: '弩车', cost: 60, damage: 15, range: 2500, interval_ticks: 20, color: '#6FB1FF' },
    { id: 'catapult', display_name: '投石车', cost: 110, damage: 45, range: 3500, interval_ticks: 60, color: '#E8C170' },
  ],
  enemies: [
    { id: 'footman', display_name: '步卒', hp: 120, speed: 35, base_damage: 1, reward: 12, color: '#C84B4B' },
  ],
  map: { width: W, height: H, path: PATH, buildable_cells: buildable, base_hp: 20, starting_gold: 120 },
  waves: [
    { id: 'w1', groups: [{ enemy_id: 'footman', count: 5, interval_ticks: 30 }] },
    { id: 'w2', groups: [{ enemy_id: 'footman', count: 8, interval_ticks: 30 }] },
    { id: 'w3', groups: [{ enemy_id: 'footman', count: 12, interval_ticks: 30 }] },
  ],
};
export const PATH_CELLS = onPath;

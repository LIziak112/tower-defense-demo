import type { Cell, ContentPack } from '../runtime/types';
import fallback from './packs/fallback.json';

export const PATH = fallback.map.path;

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

export const PATH_CELLS = pathCells(PATH);
const buildable: Cell[] = [];
const { width, height } = fallback.map;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    if (!PATH_CELLS.has(`${x},${y}`)) buildable.push({ x, y });
  }
}
export const DEFAULT_PACK: ContentPack = { ...fallback, map: { ...fallback.map, buildable_cells: buildable } };

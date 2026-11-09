import type { Cell } from './types';

export const CELL = 1000;
export const TICKS_PER_SECOND = 30;

export function pathLength(path: Cell[]): number {
  let length = 0;
  for (let i = 1; i < path.length; i++) {
    length += (Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y)) * CELL;
  }
  return length;
}

export function positionAt(path: Cell[], progress: number, out: Cell = { x: 0, y: 0 }): Cell {
  let left = progress;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const segment = (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) * CELL;
    if (left <= segment) {
      out.x = a.x * CELL + 500 + Math.sign(b.x - a.x) * left;
      out.y = a.y * CELL + 500 + Math.sign(b.y - a.y) * left;
      return out;
    }
    left -= segment;
  }
  const end = path[path.length - 1];
  out.x = end.x * CELL + 500;
  out.y = end.y * CELL + 500;
  return out;
}

// 世界坐标战场（大厅 #27514）：路线必须走宿主地图的真实道路、塔位必须在路边真实空地上，模拟跑在同一份几何上。
import { describe, expect, it } from 'vitest';
import { buildRoadGraph, buildWorldField, packForField, parseWorldMap, routePoint, milliToWorld, type HostWorldMap } from '../../src/game/worldField';
import { generateCampaignPack } from '../../src/game/culturalThemes';
import { createBattle, step, pathLength, positionAt, checksum, CELL, milliOf } from '../../src/runtime/index';
import { dryRun } from '../../src/content/dryrun';
import { reachTable } from '../../src/advisor/snapshot';
import { gridCityFixture } from './worldFixtures';

const gridCity = gridCityFixture;

const distToRoads = (world: HostWorldMap, x: number, z: number): { d: number; w: number } => {
  let best = { d: Infinity, w: 0 };
  for (const r of world.roads) for (let i = 1; i < r.pts.length; i++) {
    const [ax, , az] = r.pts[i - 1], [bx, , bz] = r.pts[i];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < best.d) best = { d, w: r.w };
  }
  return best;
};

describe('worldField: 路线走真实道路', () => {
  const world = gridCity();
  const pack = generateCampaignPack(1, 'union-atlas-3d', 'zh');
  const pathCells = pathLength(pack.map.path) / CELL;
  const field = buildWorldField(world, { pathCells, level: 1 })!;

  it('道路图：十字口 / 丁字口 / 桥头都连上了', () => {
    const g = buildRoadGraph(world.roads);
    expect(g.nodes.length).toBeGreaterThan(30);
    // 桥把两岸连通：从西岸任一点能到东岸
    const seen = new Set<number>([0]); const q = [0];
    while (q.length) { const u = q.pop()!; for (const ei of g.adj[u]) { const e = g.edges[ei], v = e.a === u ? e.b : e.a; if (!seen.has(v)) { seen.add(v); q.push(v); } } }
    expect(seen.size).toBe(g.nodes.length);
  });

  it('生成了主线（和分支），长度与战役模板相当', () => {
    expect(field).toBeTruthy();
    expect(field.routes.length).toBeGreaterThanOrEqual(1);
    const cells = field.routes[0].len / field.unit;
    expect(cells).toBeGreaterThan(pathCells * 0.6);
    expect(cells).toBeLessThan(pathCells * 1.6);
    expect(field.unit).toBeGreaterThanOrEqual(3.2);
    expect(field.unit).toBeLessThanOrEqual(6.8);
  });

  it('路线上每一点都在真实路面里（引道除外）', () => {
    for (const rt of field.routes) {
      for (let s = 0; s <= rt.len; s += 1.5) {
        const p = routePoint(rt, s);
        if (p.approach) continue;   // 建筑门口的引道（从路面走到门口的那一小段）
        const near = distToRoads(world, p.x, p.z);
        expect(near.d).toBeLessThanOrEqual(near.w / 2 + 0.05);
      }
    }
  });

  it('终点在母星门口、起点在一座远处的原生建筑门口', () => {
    expect(field.base.key).toBe('home');
    expect(Math.hypot(field.base.x, field.base.z)).toBeLessThanOrEqual(7.5);
    expect(field.spawn.key).toMatch(/^e\d$/);
    expect(field.spawn.label).not.toBe('');
  });

  it('塔位在路缘外的空地上：不压路面、不在河里、不压建筑、彼此不重叠', () => {
    expect(field.pads.length).toBeGreaterThanOrEqual(10);
    for (const p of field.pads) {
      const near = distToRoads(world, p.x, p.z);
      expect(near.d).toBeGreaterThanOrEqual(near.w / 2 + 0.85);
      expect(Math.abs(p.x - 32)).toBeGreaterThan(6 + 0.9);
      for (const b of world.blocks) expect(Math.hypot(p.x - b[0], p.z - b[1])).toBeGreaterThanOrEqual(b[2] + 0.99);
      for (const pl of world.places) expect(Math.hypot(p.x - pl.x, p.z - pl.z)).toBeGreaterThanOrEqual(pl.r + 0.99);
    }
    for (let i = 0; i < field.pads.length; i++) for (let j = i + 1; j < field.pads.length; j++) {
      expect(Math.hypot(field.pads[i].x - field.pads[j].x, field.pads[i].z - field.pads[j].z)).toBeGreaterThan(field.unit);
    }
    // 塔位贴着路线：到所属路线的距离 ≤ 半个路宽 + 4
    for (const p of field.pads) {
      const rt = field.routes[p.branch];
      const q = routePoint(rt, p.s);
      expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeLessThanOrEqual(q.w / 2 + 4);
    }
  });

  it('同一张地图：不同关卡会换路线，同一关永远是同一条（确定性）', () => {
    const again = buildWorldField(world, { pathCells, level: 1 })!;
    expect(again.id).toBe(field.id);
    expect(JSON.stringify(again.routes)).toBe(JSON.stringify(field.routes));
    const ids = new Set([1, 2, 3].map((lv) => buildWorldField(world, { pathCells, level: lv })!.id));
    expect(ids.size).toBeGreaterThanOrEqual(2);
  });

  it('模拟就跑在这份几何上：敌人的位置始终在路线上，塔的位置就是塔位', () => {
    const wp = packForField(pack, field);
    expect(wp.map.free).toBe(true);
    expect(wp.map.buildable_cells.length).toBe(field.pads.length);
    let s = createBattle(wp, 7);
    const first = wp.map.buildable_cells[0];
    s = step(s, [{ type: 'build', tower_id: wp.towers[0].id, x: first.x, y: first.y }, { type: 'start_wave' }]).state;
    expect(s.towers.length).toBe(1);
    const tw = milliToWorld(field, s.towers[0].x, s.towers[0].y);
    expect(Math.hypot(tw.x - field.pads[0].x, tw.z - field.pads[0].z)).toBeLessThan(0.02);
    let checked = 0;
    for (let i = 0; i < 900 && s.phase === 'wave'; i++) {
      s = step(s).state;
      for (const e of s.enemies) {
        const w = milliToWorld(field, e.x, e.y);
        const rt = field.routes[e.branch ?? 0];
        let best = Infinity;
        for (let k = 1; k < rt.pts.length; k++) {
          const a = rt.pts[k - 1], b = rt.pts[k], dx = b[0] - a[0], dz = b[2] - a[2];
          const t = Math.max(0, Math.min(1, ((w.x - a[0]) * dx + (w.z - a[2]) * dz) / (dx * dx + dz * dz)));
          best = Math.min(best, Math.hypot(w.x - a[0] - dx * t, w.z - a[2] - dz * t));
        }
        expect(best).toBeLessThan(0.05);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('自由几何的模拟是确定的：同样的种子与命令，checksum 相同', () => {
    const wp = packForField(pack, field);
    const run = () => {
      let s = createBattle(wp, 42);
      const c = wp.map.buildable_cells;
      s = step(s, [{ type: 'build', tower_id: wp.towers[0].id, x: c[2].x, y: c[2].y }, { type: 'build', tower_id: wp.towers[1].id, x: c[3].x, y: c[3].y }, { type: 'start_wave' }]).state;
      for (let i = 0; i < 600; i++) s = step(s).state;
      return checksum(s);
    };
    expect(run()).toBe(run());
  });

  it('难度可玩：一座塔不放守不住，贪心放塔能赢（前 3 关）', () => {
    for (const lv of [1, 2, 3]) {
      const p = generateCampaignPack(lv, 'union-atlas-3d', 'zh');
      const f = buildWorldField(world, { pathCells: pathLength(p.map.path) / CELL, level: lv })!;
      const wp = packForField(p, f);
      expect(dryRun(wp, 'no_towers').result).toBe('lost');
      expect(dryRun(wp, 'greedy').result).toBe('won');
    }
  });

  it('军师的覆盖表在自由几何上可用（不会逐格展开到死循环）', () => {
    const wp = packForField(pack, field);
    const table = reachTable(wp);
    expect(Object.keys(table).length).toBe(field.pads.length);
    expect(Math.max(...Object.values(table).map((row) => Math.max(...Object.values(row))))).toBeGreaterThan(2);
  });
});

describe('自由几何不改变经典整数格的结果', () => {
  it('positionAt / pathLength：整数轴对齐路径与旧公式逐位一致', () => {
    const path = [{ x: 0, y: 4 }, { x: 5, y: 4 }, { x: 5, y: 1 }, { x: 9, y: 1 }];
    expect(pathLength(path)).toBe(12000);
    expect(positionAt(path, 0)).toEqual({ x: 500, y: 4500 });
    expect(positionAt(path, 5300)).toEqual({ x: 5500, y: 4200 });
    expect(positionAt(path, 99999)).toEqual({ x: 9500, y: 1500 });
    expect(milliOf(3)).toBe(3500);
  });
  it('斜线段按欧氏长度走', () => {
    const path = [{ x: 0, y: 0 }, { x: 3, y: 4 }];
    expect(pathLength(path)).toBe(5000);
    expect(positionAt(path, 2500)).toEqual({ x: 2000, y: 2500 });
  });
});

describe('parseWorldMap：宿主输入不可信', () => {
  it('没有道路 / 形状不对 → null', () => {
    expect(parseWorldMap(null)).toBeNull();
    expect(parseWorldMap({ roads: [] })).toBeNull();
    expect(parseWorldMap({ roads: [{ w: 5, pts: [[0, 0, 0]] }] })).toBeNull();
  });
  it('非有限数字、超量字段被丢弃', () => {
    const m = parseWorldMap({ roads: [{ id: 'a', kind: 'street', w: 5, pts: [[0, 0, 0], [NaN, 0, 1], [10, 0, 0]] }], places: [{ key: 'x', x: Infinity, z: 0 }], blocks: [[0, 0, -1], [1, 1, 2]] })!;
    expect(m.roads[0].pts.length).toBe(2);
    expect(m.places.length).toBe(0);
    expect(m.blocks).toEqual([[1, 1, 2]]);
  });
});

// 世界坐标战场（大厅 #27514）：路线必须走宿主地图的真实道路、塔位必须在路边真实空地上，模拟跑在同一份几何上。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildRoadGraph, buildWorldField, packForField, parseWorldMap, routePoint, milliToWorld, SEG_APPROACH, type HostWorldMap } from '../../src/game/worldField';
import { generateCampaignPack, localizePackForSkin } from '../../src/game/culturalThemes';
import { createBattle, step, pathLength, positionAt, checksum, CELL, milliOf } from '../../src/runtime/index';
import { dryRun } from '../../src/content/dryrun';
import { reachTable } from '../../src/advisor/snapshot';
import { gridCityFixture, laneFixture } from './worldFixtures';

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


// —— 四款开放皮肤的真实几何：从宿主真实入口页 KMU.spatial.current().battle.map() 原样导出（krowworker web/hikos，大厅 #27514），
//    不是手写的近似。路线必须从真实建筑出发、沿真实路面走到母星门口，不走回头路；塔位落在路边真实空地上。
const REAL = ['union-atlas-3d', 'metropolis-riverside-3d', 'gothic-cathedral-3d', 'harbor-district-3d'] as const;
const loadReal = (skin: string): HostWorldMap => parseWorldMap(JSON.parse(readFileSync(new URL(`../fixtures/world/${skin}.world.json`, import.meta.url), 'utf8')))!;
const segDist = (px: number, pz: number, ax: number, az: number, bx: number, bz: number): number => {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
};

describe.each(REAL)('真实地图 %s', (skin) => {
  const world = loadReal(skin);
  const packOf = (lv: number) => localizePackForSkin(generateCampaignPack(lv, skin, 'zh'), skin, 'zh');
  const fieldOf = (lv: number) => buildWorldField(world, { pathCells: pathLength(packOf(lv).map.path) / CELL, level: lv })!;

  it('宿主导出的几何过得了校验：有路、有母星、有建筑', () => {
    expect(world.roads.length).toBeGreaterThan(3);
    expect(world.places.filter((p) => p.kind === 'home')).toHaveLength(1);
    expect(world.places.length).toBeGreaterThan(4);
  });

  it('前 6 关都排得出战场：起点是真实建筑，终点是母星', () => {
    const home = world.places.find((p) => p.kind === 'home')!;
    for (let lv = 1; lv <= 6; lv++) {
      const f = fieldOf(lv);
      expect(f, `lv${lv}`).not.toBeNull();
      expect(f.spawn.key, `lv${lv} 起点`).not.toBeNull();
      expect(world.places.some((p) => p.key === f.spawn.key && p.kind !== 'home')).toBe(true);
      expect(f.base.key).toBe(home.key);
      // 终点落在母星占位圆上（门口），不钻进建筑里
      expect(Math.hypot(f.base.x - home.x, f.base.z - home.z)).toBeGreaterThan(home.r - 0.4);
      expect(Math.hypot(f.base.x - home.x, f.base.z - home.z)).toBeLessThan(home.r + 1.2);
      expect(f.unit).toBe(5);
      expect(f.paceK).toBeGreaterThan(0.55);
      expect(f.pads.length, `lv${lv} 塔位`).toBeGreaterThanOrEqual(10);
    }
  });

  it('路线每一点都在真实路面上（门口引道除外），而且不走回头路', () => {
    for (let lv = 1; lv <= 4; lv++) {
      const f = fieldOf(lv);
      for (const rt of f.routes) {
        expect(rt.pts.length).toBe(rt.wd.length);
        expect(rt.pts.length).toBe(rt.fl.length);
        // 每 0.1 取一点，外加每一段路面段的两个端点（引道接上路面的那个折点就是倒角线上离路缘最近的地方）。
        // 判定线 0.01：路面段——包括引道拐上路面的倒角——不许露到任何一条真实道路的路缘外面。
        const at: [number, number, string][] = [];
        for (let s = 0; s <= rt.len; s += 0.1) { const q = routePoint(rt, s); if (!q.approach) at.push([q.x, q.z, `s=${s.toFixed(1)}`]); }
        for (let i = 1; i < rt.pts.length; i++) if (!(rt.fl[i - 1] & SEG_APPROACH)) for (const k of [i - 1, i]) at.push([rt.pts[k][0], rt.pts[k][2], `折点 ${k}`]);
        for (const [x, z, where] of at) {
          let best = Infinity;
          for (const r of world.roads) for (let i = 1; i < r.pts.length; i++) best = Math.min(best, segDist(x, z, r.pts[i - 1][0], r.pts[i - 1][2], r.pts[i][0], r.pts[i][2]) - r.w / 2);
          expect(best, `${skin} lv${lv} ${where} (${x.toFixed(2)}, ${z.toFixed(2)}) 离路缘`).toBeLessThanOrEqual(0.01);
        }
        // 不走回头路：相隔 3 个单位以上的两个采样点不会重合
        const samples: [number, number][] = [];
        for (let s = 0; s <= rt.len; s += 2) { const q = routePoint(rt, s); samples.push([q.x, q.z]); }
        for (let i = 0; i < samples.length; i++) for (let j = i + 3; j < samples.length; j++) {
          expect(Math.hypot(samples[i][0] - samples[j][0], samples[i][1] - samples[j][1]), `${skin} lv${lv} 第 ${i} / ${j} 个采样点重合`).toBeGreaterThan(0.6);
        }
      }
    }
  });

  it('门口引道不穿过别的建筑和装饰', () => {
    for (let lv = 1; lv <= 4; lv++) {
      const f = fieldOf(lv);
      for (const rt of f.routes) for (let i = 1; i < rt.pts.length; i++) {
        if (!(rt.fl[i - 1] & SEG_APPROACH)) continue;
        const a = rt.pts[i - 1], b = rt.pts[i];
        for (const p of world.places) {
          if (p.key === f.spawn.key || p.key === f.spawn2?.key || p.key === f.base.key) continue;
          expect(segDist(p.x, p.z, a[0], a[2], b[0], b[2]), `${skin} lv${lv} 引道压到 ${p.label}`).toBeGreaterThan(p.r);
        }
        for (const c of world.blocks) expect(segDist(c[0], c[1], a[0], a[2], b[0], b[2]), `${skin} lv${lv} 引道压到装饰 (${c[0]}, ${c[1]})`).toBeGreaterThan(c[2]);
      }
    }
  });

  it('塔位在真实空地上：不压路面、建筑、装饰、水，港湾只落在甲板上；浮桥旁边不放塔', () => {
    for (let lv = 1; lv <= 4; lv++) {
      const f = fieldOf(lv);
      for (const p of f.pads) {
        for (const r of world.roads) {
          if (r.virtual) continue;
          for (let i = 1; i < r.pts.length; i++) expect(segDist(p.x, p.z, r.pts[i - 1][0], r.pts[i - 1][2], r.pts[i][0], r.pts[i][2]), `${skin} lv${lv} 塔位压路 ${r.id}`).toBeGreaterThanOrEqual(r.w / 2 + f.padR);
        }
        for (const q of world.places) expect(Math.hypot(p.x - q.x, p.z - q.z), `${skin} lv${lv} 塔位压建筑 ${q.label}`).toBeGreaterThanOrEqual(q.r + f.padR);
        for (const c of world.blocks) expect(Math.hypot(p.x - c[0], p.z - c[1])).toBeGreaterThanOrEqual(c[2] + f.padR - 1e-6);
        for (const w of world.water) for (let i = 1; i < w.pts.length; i++) expect(segDist(p.x, p.z, w.pts[i - 1][0], w.pts[i - 1][1], w.pts[i][0], w.pts[i][1])).toBeGreaterThanOrEqual(w.w / 2 + f.padR - 1e-6);
        if (world.land) expect(world.land.some((q) => p.x >= q[0] + f.padR && p.x <= q[2] - f.padR && p.z >= q[1] + f.padR && p.z <= q[3] - f.padR), `${skin} lv${lv} 塔位落水`).toBe(true);
      }
      // 塔位两两不重叠
      for (let i = 0; i < f.pads.length; i++) for (let j = i + 1; j < f.pads.length; j++) expect(Math.hypot(f.pads[i].x - f.pads[j].x, f.pads[i].z - f.pads[j].z)).toBeGreaterThan(2 * f.padR);
    }
  });

  it('确定性：同一张地图同一关，战场指纹相同', () => {
    expect(fieldOf(2).id).toBe(fieldOf(2).id);
    expect(JSON.stringify(fieldOf(3).map)).toBe(JSON.stringify(fieldOf(3).map));
  });

  it('难度可玩：一座塔不放守不住，贪心放塔能赢（前 6 关）；行军时间与原设计相当', () => {
    for (let lv = 1; lv <= 6; lv++) {
      const p = packOf(lv), f = fieldOf(lv), wp = packForField(p, f);
      expect(dryRun(wp, 'no_towers').result, `${skin} lv${lv} 空防`).toBe('lost');
      expect(dryRun(wp, 'greedy').result, `${skin} lv${lv} 贪心`).toBe('won');
      const tpl = pathLength(p.map.path) / p.enemies[0].speed, real = pathLength(wp.map.path) / wp.enemies[0].speed;
      expect(real / tpl, `${skin} lv${lv} 行军时间`).toBeGreaterThan(0.85);
      expect(real / tpl).toBeLessThan(1.2);
    }
  });
});

// —— 引道与路面相接的拐角（任务 771f9e1c 第一项）：港口栈道宽只有 1，门口引道拐上栈道的倒角以前有一截露在栈道外面（最多 0.30）。
describe('引道拐上窄路：倒角不出路面', () => {
  const edge = (world: HostWorldMap, x: number, z: number): number => {
    let best = Infinity;
    for (const r of world.roads) for (let i = 1; i < r.pts.length; i++) best = Math.min(best, segDist(x, z, r.pts[i - 1][0], r.pts[i - 1][2], r.pts[i][0], r.pts[i][2]) - r.w / 2);
    return best;
  };
  /** 路面段（含倒角）上离路缘最远的地方：每 0.02 取一点，外加路面段的端点。≤ 0 = 全在路面内 */
  const worstOnRoad = (world: HostWorldMap, rt: { pts: [number, number | null, number][]; wd: number[]; fl: number[]; len: number }): number => {
    let worst = -Infinity;
    for (let s = 0; s <= rt.len; s += 0.02) { const q = routePoint(rt, s); if (!q.approach) worst = Math.max(worst, edge(world, q.x, q.z)); }
    for (let i = 1; i < rt.pts.length; i++) if (!(rt.fl[i - 1] & SEG_APPROACH)) for (const k of [i - 1, i]) worst = Math.max(worst, edge(world, rt.pts[k][0], rt.pts[k][2]));
    return worst;
  };
  const build = (w: number, spawn: 'side' | 'back' = 'side') => { const world = laneFixture(w, spawn); return { world, f: buildWorldField(world, { pathCells: 22, level: 1 })! }; };

  it('路宽 1（港口栈道）：引道垂直拐上路面，倒角两端都在路面内，引道那一端收到路缘以内 0.05', () => {
    const { world, f } = build(1);
    const rt = f.routes[0];
    expect(f.spawn.key).toBe('side');
    // 折点 0 门口 → 折点 1 倒角起点（引道线上）→ 折点 2 倒角终点（路的中心线上）
    expect(rt.fl[0] & SEG_APPROACH).toBe(SEG_APPROACH);
    expect(rt.fl[1] & SEG_APPROACH).toBe(0);
    expect(rt.pts[1][0]).toBeCloseTo(-50, 2);
    expect(rt.pts[1][2]).toBeCloseTo(0.45, 2);       // 离中心线 0.45 = 半宽 0.5 − 0.05
    expect(rt.pts[2][0]).toBeCloseTo(-49.2, 2);      // 路面那一边照旧退 0.8
    expect(rt.pts[2][2]).toBeCloseTo(0, 2);
    expect(worstOnRoad(world, rt)).toBeLessThanOrEqual(-0.04);
  });

  it('路宽 1：终点那一头（路面拐进母星的引道）同样不出路面', () => {
    const { world, f } = build(1);
    const rt = f.routes[0], n = rt.pts.length;
    expect(f.base.key).toBe('home');
    expect(rt.fl[n - 2] & SEG_APPROACH).toBe(SEG_APPROACH);   // 最后一段是引道
    expect(rt.fl[n - 3] & SEG_APPROACH).toBe(0);              // 它前面是倒角（路面段）
    expect(rt.pts[n - 3][0]).toBeCloseTo(49.2, 2);
    expect(rt.pts[n - 3][2]).toBeCloseTo(0, 2);
    expect(rt.pts[n - 2][0]).toBeCloseTo(50, 2);
    expect(rt.pts[n - 2][2]).toBeCloseTo(-0.45, 2);
  });

  it('引道从路的起点背后斜着接上来：退出去的点按到拐点的距离收，仍在路面内', () => {
    const { world, f } = build(1, 'back');
    expect(f.spawn.key).toBe('back');
    const rt = f.routes[0];
    expect(Math.hypot(rt.pts[1][0] + 60, rt.pts[1][2])).toBeCloseTo(0.45, 1);   // 离路的起点 (-60, 0) 0.45
    expect(worstOnRoad(world, rt)).toBeLessThanOrEqual(-0.03);
  });

  it('路够宽（引道那一端本来就在路面内）：倒角原样不动，两边各退 0.8', () => {
    for (const w of [1.6, 3, 5]) {
      const { world, f } = build(w);
      const rt = f.routes[0];
      expect(rt.pts[1][2], `w=${w}`).toBeCloseTo(0.8, 2);
      expect(rt.pts[2][0], `w=${w}`).toBeCloseTo(-49.2, 2);
      expect(worstOnRoad(world, rt), `w=${w}`).toBeLessThanOrEqual(0.01);
    }
  });

  it('很窄的路（收窄后退不出 0.25）：不倒角，引道走到中心线上再拐', () => {
    const { world, f } = build(0.5);
    const rt = f.routes[0];
    expect(rt.pts[1][0]).toBeCloseTo(-50, 2);
    expect(rt.pts[1][2]).toBeCloseTo(0, 2);
    expect(rt.fl[0] & SEG_APPROACH).toBe(SEG_APPROACH);
    expect(rt.fl[1] & SEG_APPROACH).toBe(0);
    expect(worstOnRoad(world, rt)).toBeLessThanOrEqual(0.01);
  });

  it('收窄拐角不挪塔位：塔位仍按没收窄的折线排，窄路和宽路上落点相同', () => {
    // 同一张图只把路宽从 1 改成 1.6（1.6 的路上倒角不用收窄）：路线只差拐角里的两个折点；
    // 直路两旁的塔位离路缘的距离跟着路宽走，沿路的位置应当一样。要是塔位照着收窄后的路线排，沿路位置会整体差 0.14
    const narrow = build(1).f, wide = build(1.6).f;
    expect(narrow.pads.length).toBe(wide.pads.length);
    let straight = 0;
    narrow.pads.forEach((p, i) => {
      const q = wide.pads[i];
      expect(p.side).toBe(q.side);
      if (Math.abs(p.x) > 45) return;   // 两头拐角旁边的塔位是从斜着的倒角线上偏出去的，路宽不同落点自然不同
      straight++;
      expect(p.x, `塔位 ${i} 沿路位置`).toBeCloseTo(q.x, 2);
      expect(Math.abs(p.z) + 0.3, `塔位 ${i} 离路缘`).toBeCloseTo(Math.abs(q.z), 2);   // 半宽差 0.3
    });
    expect(straight).toBeGreaterThanOrEqual(8);
    // 记在塔位上的路程是路线上的路程：按它取到的点就在塔位旁边
    for (const p of narrow.pads) {
      const at = routePoint(narrow.routes[p.branch], p.s);
      expect(Math.hypot(at.x - p.x, at.z - p.z)).toBeLessThanOrEqual(at.w / 2 + narrow.padR + 0.3 + 2.7 + 0.05);
    }
  });

  it('港口真实地图：四块战场的塔位数与收窄拐角之前相同（15 / 13 / 12 / 13）', () => {
    const world = loadReal('harbor-district-3d');
    const counts = [1, 2, 3, 4].map((lv) => {
      const p = localizePackForSkin(generateCampaignPack(lv, 'harbor-district-3d', 'zh'), 'harbor-district-3d', 'zh');
      return buildWorldField(world, { pathCells: pathLength(p.map.path) / CELL, level: lv })!.pads.length;
    });
    expect(counts).toEqual([15, 13, 12, 13]);
  });
});

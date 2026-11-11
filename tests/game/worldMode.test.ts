// 世界模式的线格式与相机投影（大厅 #27514）：游戏告诉宿主的位置，必须就是模拟里的位置；游戏用相机矩阵算出的屏幕点，必须跟着相机走。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildWorldField, milliToWorld, packForField, parseWorldMap, type HostWorldMap, type WorldField } from '../../src/game/worldField';
import {
  arcOf, encodeField, encodeFrame, groundOf, heightNear, padPoints, parseCamera, parseGround, pickPad, projectWorld, routeHeight, routeIndex, routeMilli, routeWorld,
  type FrameUi, type HostCamera,
} from '../../src/game/worldMode';
import { generateCampaignPack, localizePackForSkin } from '../../src/game/culturalThemes';
import { createBattle, step, pathLength, CELL } from '../../src/runtime/index';
import type { BattleState, Command, ContentPack } from '../../src/runtime/types';
import { orthoCamera } from './worldCamera';

const REAL = ['union-atlas-3d', 'metropolis-riverside-3d', 'gothic-cathedral-3d', 'harbor-district-3d'] as const;
const loadReal = (skin: string): HostWorldMap => parseWorldMap(JSON.parse(readFileSync(new URL(`../fixtures/world/${skin}.world.json`, import.meta.url), 'utf8')))!;

function fieldFor(skin: string, level = 1): { world: HostWorldMap; field: WorldField; pack: ContentPack } {
  const world = loadReal(skin);
  const base = localizePackForSkin(generateCampaignPack(level, skin, 'zh'), skin, 'zh');
  const field = buildWorldField(world, { pathCells: pathLength(base.map.path) / CELL, level })!;
  return { world, field, pack: packForField(base, field) };
}

const cam = (spec: Parameters<typeof orthoCamera>[0]): HostCamera => parseCamera(orthoCamera(spec))!;
const idleUi = (over: Partial<FrameUi> = {}): FrameUi => ({
  phase: 'build', paused: false, hoverPad: -1, advisedPads: [], previewPads: [], ring: null, tips: [],
  recoil: () => false, flash: () => false, shots: [], fx: [], ...over,
});

/** 在前 n 个塔位上各建一座塔、开波，再跑 ticks 帧 */
function playSome(pack: ContentPack, n: number, ticks: number): BattleState {
  let s = createBattle(pack, 7);
  s = step(s, [{ type: 'debug_add_gold', amount: 5000 }]).state;
  const cmds: Command[] = pack.map.buildable_cells.slice(0, n).map((c, i) => ({ type: 'build', tower_id: pack.towers[i % pack.towers.length].id, x: c.x, y: c.y }));
  s = step(s, cmds).state;
  s = step(s, [{ type: 'start_wave' }]).state;
  for (let i = 0; i < ticks; i++) s = step(s).state;
  return s;
}

describe('hikos:camera：校验与投影', () => {
  it('矩阵必须是 16 个有限数；别的字段缺了给缺省，ppu 缺了从矩阵里量', () => {
    expect(parseCamera(null)).toBeNull();
    expect(parseCamera({ m: [1, 2, 3] })).toBeNull();
    expect(parseCamera({ m: new Array(16).fill(NaN) })).toBeNull();
    expect(parseCamera({ m: new Array(16).fill(1e12) })).toBeNull();
    const raw = orthoCamera({ w: 1024, h: 662, zoom: 2, span: 66.2 });
    const full = parseCamera(raw)!;
    expect(full.ppu).toBeCloseTo(10, 6);
    const bare = parseCamera({ m: raw.m })!;
    expect(bare.ppu).toBeCloseTo(10, 6);
    expect(bare.zoom).toBe(1);
    // 传进来的数组不被引用：宿主之后改它不影响游戏手里的相机
    raw.m[3] = 12345;
    expect(full.m[3]).not.toBe(12345);
  });

  it('看向的那一点投到舞台正中；沿相机右轴走 1 个单位，屏幕上正好右移 ppu 像素', () => {
    const c = cam({ w: 1200, h: 800, azimuth: 0.6, pitch: 0.9, zoom: 1.5, span: 60, focus: [12, 0.5, -7] });
    const mid = projectWorld(c, 12, 0.5, -7);
    expect(mid.x).toBeCloseTo(600, 6);
    expect(mid.y).toBeCloseTo(400, 6);
    const right = projectWorld(c, 12 + Math.cos(0.6), 0.5, -7 - Math.sin(0.6));
    expect(right.x - mid.x).toBeCloseTo(c.ppu, 6);
    expect(right.y - mid.y).toBeCloseTo(0, 6);
    // 往上 1 个单位：屏幕上移 cos(pitch) × ppu
    const up = projectWorld(c, 12, 1.5, -7);
    expect(mid.y - up.y).toBeCloseTo(Math.cos(0.9) * c.ppu, 6);
  });

  it('缩放 / 旋转 / 平移之后，世界里的同一点仍然投到同一个相对位置：放大 k 倍，离看点的屏幕距离也是 k 倍', () => {
    const p: [number, number, number] = [30, 0.06, -18];
    const base = cam({ w: 1024, h: 662, zoom: 1, span: 66 });
    const zoomed = cam({ w: 1024, h: 662, zoom: 3, span: 66 });
    const a = projectWorld(base, ...p), b = projectWorld(zoomed, ...p);
    expect(b.x - 512).toBeCloseTo((a.x - 512) * 3, 6);
    expect(b.y - 331).toBeCloseTo((a.y - 331) * 3, 6);
    // 绕看点转半圈：屏幕上关于正中对称（高度相同的点）
    const turned = cam({ w: 1024, h: 662, zoom: 1, span: 66, azimuth: -0.38 + Math.PI, focus: [0, 0.06, 0] });
    const still = cam({ w: 1024, h: 662, zoom: 1, span: 66, azimuth: -0.38, focus: [0, 0.06, 0] });
    const s0 = projectWorld(still, ...p), s1 = projectWorld(turned, ...p);
    expect(s1.x - 512).toBeCloseTo(-(s0.x - 512), 6);
    expect(s1.y - 331).toBeCloseTo(-(s0.y - 331), 6);
  });
});

describe.each(REAL)('真实地图 %s：点选塔位', (skin) => {
  const { field } = fieldFor(skin);
  const pads = padPoints(field);

  it('各种镜头下，点在某个塔位投出来的屏幕点上，选中的就是它', () => {
    const cx = (Math.min(...pads.map((p) => p.x)) + Math.max(...pads.map((p) => p.x))) / 2;
    const cz = (Math.min(...pads.map((p) => p.z)) + Math.max(...pads.map((p) => p.z))) / 2;
    for (const zoom of [0.35, 1, 2.5, 6]) for (const azimuth of [-0.38, 0.9, 2.4, -2.2]) for (const pitch of [0.52, 0.78, 1.3]) {
      const c = cam({ w: 1024, h: 662, zoom, azimuth, pitch, span: 66, focus: [cx, 0, cz] });
      pads.forEach((p, i) => {
        const q = projectWorld(c, p.x, p.y, p.z);
        expect(pickPad(c, pads, q.x, q.y), `zoom=${zoom} az=${azimuth} pitch=${pitch} pad=${i}`).toBe(i);
      });
    }
  });

  it('点在远离所有塔位的地方不选中；地图缩得很小时拾取半径不小于 24 像素', () => {
    const c = cam({ w: 1024, h: 662, zoom: 0.3, span: 66 });
    expect(pickPad(c, pads, -500, -500)).toBe(-1);
    const q = projectWorld(c, pads[0].x, pads[0].y, pads[0].z);
    // 偏 20 像素仍然算点中（最近的那个塔位未必是 0 号，但一定选中了某一个）
    expect(pickPad(c, pads, q.x + 14, q.y + 14)).toBeGreaterThanOrEqual(0);
  });

  it('宿主回了真实高度（hikos:ground）就用它；对不上这块战场的回执不用', () => {
    const lifted = { field: field.id, pads: field.pads.map((_, i) => 5 + i), routes: field.routes.map((r) => r.pts.map((_, j) => 2 + j * 0.01)) };
    const withGround = padPoints(field, parseGround({ type: 'hikos:ground', ...lifted }));
    expect(withGround.map((p) => p.y)).toEqual(lifted.pads);
    expect(routeWorld(field.routes[0], 0, groundOf(field, lifted, 0)).y).toBeCloseTo(2, 6);
    expect(routeWorld(field.routes[0], field.routes[0].len, groundOf(field, lifted, 0)).y).toBeCloseTo(2 + (field.routes[0].pts.length - 1) * 0.01, 4);
    // 别的战场的回执：忽略，退回参考高度
    expect(padPoints(field, { ...lifted, field: 'other' }).map((p) => p.y)).toEqual(pads.map((p) => p.y));
    // 塔位数组长度对不上：塔位那一份不用（退回它旁边路面的高度），不会把错位的数当成高度
    const partial = padPoints(field, { ...lifted, pads: [1, 2] });
    expect(partial.map((p) => p.y)).toEqual(field.pads.map((p) => routeHeight(field.routes[p.branch], p.s, lifted.routes[p.branch])));
    expect(groundOf(field, { ...lifted, routes: [[1]] }, 0)).toBeNull();
    expect(parseGround({ field: field.id, pads: [1, 'x'], routes: [] })).toBeNull();
    expect(parseGround({ field: '', pads: [], routes: [] })).toBeNull();
  });
});

// —— 沿路高度剖面（hikos:ground 的 step / profile，游戏 0.9.2 起）。
// 宿主摆敌人用的是沿路每 0.5 个世界单位取一次的真实地面高度（相邻三个样点取最高，样点之间线性插值）；游戏以前只有折点高度，
// 折点之间的台阶 / 桥面被一条直线抹平，跳字就比敌人高出或低下去一截（都会滨水 0.5、哥特教堂 0.88）。
// 下面两个函数是宿主 web/hikos/src/addons/arcade-field.js 里 buildRoute() / along() 取高度那几行的原样移植：游戏照着剖面算出来的高度必须与它一致。
const HOST_STEP = 0.5;
type HostRoute = { len: number; count: number; sy: number[]; vy: number[] };
function hostRoute(r: { pts: [number, number | null, number][]; fl: number[] }, groundAt: (x: number, z: number) => number): HostRoute {
  const P = r.pts, n = P.length, cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][2] - P[i - 1][2]));
  const len = cum[n - 1], virt = (i: number) => (r.fl[i] & 2) !== 0;
  const vy = P.map((p) => groundAt(p[0], p[2]));
  for (let i = 0; i < n - 1;) {
    if (!virt(i)) { i++; continue; }
    let j = i; while (j < n - 1 && virt(j)) j++;
    const l = cum[j] - cum[i] || 1; for (let k = i + 1; k < j; k++) vy[k] = vy[i] + (vy[j] - vy[i]) * (cum[k] - cum[i]) / l;
    i = j;
  }
  const count = Math.max(2, Math.ceil(len / HOST_STEP) + 1), sy = new Array<number>(count), sf = new Array<number>(count);
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const s = Math.min(len, k * HOST_STEP); while (seg < n - 2 && cum[seg + 1] < s) seg++;
    const l = cum[seg + 1] - cum[seg], t = l > 1e-9 ? Math.max(0, Math.min(1, (s - cum[seg]) / l)) : 0, a = P[seg], b = P[seg + 1];
    sf[k] = r.fl[seg]; sy[k] = virt(seg) ? vy[seg] + (vy[seg + 1] - vy[seg]) * t : groundAt(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t);
  }
  const raw = sy.slice(); for (let k = 0; k < count; k++) if (!(sf[k] & 2)) sy[k] = Math.max(raw[Math.max(0, k - 1)], raw[k], raw[Math.min(count - 1, k + 1)]);
  return { len, count, sy, vy };
}
function hostHeight(R: HostRoute, s: number): number {
  const c = Math.max(0, Math.min(R.len, s)), i = Math.min(R.count - 2, Math.floor(c / HOST_STEP)), span = (i === R.count - 2 ? R.len - i * HOST_STEP : HOST_STEP) || HOST_STEP;
  return R.sy[i] + (R.sy[i + 1] - R.sy[i]) * Math.max(0, Math.min(1, (c - i * HOST_STEP) / span));
}
const round3 = (v: number) => Math.round(v * 1000) / 1000;
/** 一块有台阶的地：每隔几个单位抬高 / 落下 0.5（路缘、桥头那样的台阶），外加一点起伏 */
const terraced = (x: number, z: number): number => (Math.abs(Math.floor((x + 3 * z) / 9)) % 2 === 0 ? 0.1 : 0.6) + 0.02 * Math.sin(x * 0.7);

describe.each(REAL)('真实地图 %s：沿路高度剖面', (skin) => {
  const { field } = fieldFor(skin);
  const host = field.routes.map((r) => hostRoute(r, terraced));
  /** 宿主回执的样子：数都取三位小数 */
  const reply = (over: Record<string, unknown> = {}) => ({
    type: 'hikos:ground', v: 1, field: field.id, pads: field.pads.map((p) => round3(terraced(p.x, p.z))), routes: host.map((R) => R.vy.map(round3)),
    step: HOST_STEP, profile: host.map((R) => R.sy.map(round3)), ...over,
  });
  /** 宿主按取了三位小数的样点摆敌人时的高度 */
  const sent = host.map((R) => ({ ...R, sy: R.sy.map(round3) }));

  it('有剖面：路线上每一处的高度就是宿主摆敌人的高度（同一个算式，差不到 1e-9）', () => {
    const ground = parseGround(reply())!;
    expect(ground.step).toBe(HOST_STEP);
    field.routes.forEach((route, ri) => {
      const g = groundOf(field, ground, ri)!;
      expect(g.profile, `路线 ${ri} 用上了剖面`).toBeDefined();
      let worst = 0;
      for (let s = 0; s <= route.len + 0.2; s += 0.05) worst = Math.max(worst, Math.abs(routeHeight(route, s, g) - hostHeight(sent[ri], s)));
      expect(worst, `路线 ${ri}`).toBeLessThan(1e-9);
      // 与没取整的真实高度相比，只差取三位小数的那一点
      let vsReal = 0;
      for (let s = 0; s <= route.len; s += 0.05) vsReal = Math.max(vsReal, Math.abs(routeWorld(route, s, g).y - hostHeight(host[ri], s)));
      expect(vsReal, `路线 ${ri}`).toBeLessThanOrEqual(0.0005 + 1e-9);
    });
  });

  it('没有剖面（旧宿主）：照旧在折点之间插值——在有台阶的地上会和宿主差出几乎一整级台阶，这就是剖面要补的那一截', () => {
    const ground = parseGround(reply({ step: undefined, profile: undefined }))!;
    expect(ground.step).toBeUndefined();
    expect(ground.profile).toBeUndefined();
    let worst = 0;
    field.routes.forEach((route, ri) => {
      const g = groundOf(field, ground, ri)!;
      expect(g.profile).toBeUndefined();
      for (let s = 0; s <= route.len; s += 0.05) worst = Math.max(worst, Math.abs(routeHeight(route, s, g) - hostHeight(sent[ri], s)));
      // 只传折点高度数组的旧写法仍然可用，结果相同
      expect(routeHeight(route, route.len / 3, ground.routes[ri])).toBe(routeHeight(route, route.len / 3, g));
    });
    expect(worst).toBeGreaterThan(0.3);
  });

  it('剖面不成形就当没给：其余几样照用，高度退回折点插值', () => {
    const good = parseGround(reply())!;
    const bad: Record<string, unknown>[] = [
      { step: 0 }, { step: -0.5 }, { step: 1e9 }, { step: '0.5' }, { step: Number.NaN },
      { profile: host.map((R) => R.sy.map(round3)).slice(1) },                                  // 条数和路线对不上
      { profile: [...host.map((R) => R.sy.map(round3)), [0, 1]] },
      { profile: host.map((R, i) => (i === 0 ? [...R.sy.slice(0, 5), 'x'] : R.sy)) },           // 混进了不是数的东西
      { profile: host.map((R, i) => (i === 0 ? [...R.sy.slice(0, 5), Number.POSITIVE_INFINITY] : R.sy)) },
      { profile: host.map(() => [1]) },                                                         // 一个样点插不了值
      { profile: host.map(() => new Array(16385).fill(0)) },                                    // 超长
      { profile: 'nope' },
    ];
    for (const over of bad) {
      const g = parseGround(reply(over));
      expect(g, JSON.stringify(over).slice(0, 60)).not.toBeNull();
      expect(g!.profile, JSON.stringify(over).slice(0, 60)).toBeUndefined();
      expect(g!.step).toBeUndefined();
      expect(g!.pads).toEqual(good.pads);
      expect(g!.routes).toEqual(good.routes);
    }
  });

  it('剖面盖不住这条路线（样点太少 / 太多 / 间距不对）：这条路线不用它，别的照用', () => {
    const cut = parseGround(reply({ profile: host.map((R, i) => (i === 0 ? R.sy.slice(0, R.sy.length - 3) : R.sy).map(round3)) }))!;
    expect(groundOf(field, cut, 0)!.profile).toBeUndefined();
    expect(groundOf(field, cut, 0)!.ys).toEqual(cut.routes[0]);
    for (let ri = 1; ri < field.routes.length; ri++) expect(groundOf(field, cut, ri)!.profile).toBeDefined();
    const long = parseGround(reply({ profile: host.map((R) => [...R.sy, 0, 0, 0].map(round3)) }))!;
    const wide = parseGround(reply({ step: 1 }))!;
    field.routes.forEach((_, ri) => {
      expect(groundOf(field, long, ri)!.profile).toBeUndefined();
      expect(groundOf(field, wide, ri)!.profile).toBeUndefined();
    });
    // 别的战场的回执：整条不用
    expect(groundOf(field, parseGround(reply({ field: 'other' })), 0)).toBeNull();
  });

  it('路线旁边一点的高度（命中点、被推倒的建筑）：有剖面取最近那个路线点上的高度，没有剖面取最近折点的高度', () => {
    const withProfile = parseGround(reply())!, bare = parseGround(reply({ step: undefined, profile: undefined }))!;
    field.routes.forEach((route, ri) => {
      for (const frac of [0.21, 0.5, 0.83]) {
        const s = route.len * frac, q = routeWorld(route, s, groundOf(field, withProfile, ri));
        // 正好在路线上的一点：就是这一点的高度（另一条路线也经过这里时两边是同一块地，高度相同）
        expect(heightNear(field, withProfile, q.x, q.z), `路线 ${ri} s=${s.toFixed(1)}`).toBeCloseTo(q.y, 2);
        // 没有剖面：最近的那个折点
        let best = 0, bd = Infinity;
        field.routes.forEach((r2, j) => r2.pts.forEach((p, i) => { const d = (p[0] - q.x) ** 2 + (p[2] - q.z) ** 2; if (d < bd) { bd = d; best = bare.routes[j][i]; } }));
        expect(heightNear(field, bare, q.x, q.z)).toBe(best);
      }
    });
    // 宿主什么都没回：用道路的参考高度，不抛错
    expect(Number.isFinite(heightNear(field, null, field.pads[0].x, field.pads[0].z))).toBe(true);
  });
});

describe.each(REAL)('真实地图 %s：td:field / td:frame', (skin) => {
  const { world, field, pack } = fieldFor(skin);
  const palette = { accent: '#ffd36a', danger: '#ff9a8a', ok: '#338a72', paper: '#2b3846', ink: '#f5f5f5' };
  const msg = encodeField(field, pack, { skin, lang: 'zh', level: 1, spawnTitle: '起点', baseTitle: '终点', palette }) as any;

  it('td:field：路线 / 塔位 / 起终点全是世界坐标，起终点绑定真实建筑，塔的射程换成了世界单位', () => {
    expect(msg.type).toBe('td:field');
    expect(msg.id).toBe(field.id);
    expect(msg.routes).toHaveLength(field.routes.length);
    expect(msg.pads).toHaveLength(field.pads.length);
    for (const r of msg.routes) {
      expect(r.pts.length).toBe(r.wd.length);
      expect(r.pts.length).toBe(r.fl.length);
      for (const p of r.pts) {
        expect(p[0]).toBeGreaterThanOrEqual(world.bounds.minX - 8);
        expect(p[0]).toBeLessThanOrEqual(world.bounds.maxX + 8);
        expect(p[2]).toBeGreaterThanOrEqual(world.bounds.minZ - 8);
        expect(p[2]).toBeLessThanOrEqual(world.bounds.maxZ + 8);
      }
    }
    expect(world.places.some((p) => p.key === msg.base.key && p.kind === 'home')).toBe(true);
    expect(msg.base.title).toBe(`终点·${msg.base.label}`);
    expect(msg.spawn.title.startsWith('起点')).toBe(true);
    msg.towers.forEach((t: any, i: number) => {
      expect(t.range).toBeCloseTo((pack.towers[i].range / CELL) * field.unit, 1);
      expect(['rapid', 'area', 'heavy']).toContain(t.model);
    });
    expect(msg.enemies).toHaveLength(pack.enemies.length);
    // 能过 postMessage 的结构化克隆（纯 JSON）
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  it('td:frame：敌人的「路线 + 弧长」还原出来的世界位置，就是模拟里它所在的位置', () => {
    const s = playSome(pack, 4, 260);
    expect(s.enemies.length).toBeGreaterThan(0);
    const frame = encodeFrame(s, pack, field, idleUi({ phase: 'wave' })) as any;
    expect(frame.field).toBe(field.id);
    expect(frame.pads).toHaveLength(field.pads.length);
    expect(frame.pads.slice(0, 4)).toBe('4444');
    expect(frame.towers).toHaveLength(4);
    frame.towers.forEach((t: number[], i: number) => expect(t[1]).toBe(i));
    const alive = s.enemies.filter((e) => e.life === 'alive');
    expect(frame.enemies).toHaveLength(alive.length);
    let worst = 0;
    for (const row of frame.enemies as number[][]) {
      const e = alive.find((x) => x.iid === row[0])!;
      const route = field.routes[row[2]];
      expect(row[3]).toBeGreaterThanOrEqual(0);
      expect(row[3]).toBeLessThanOrEqual(route.len + 1e-6);
      const drawn = routeWorld(route, row[3]);            // 宿主会把它画在这里
      const simulated = milliToWorld(field, e.x, e.y);    // 模拟里它在这里
      worst = Math.max(worst, Math.hypot(drawn.x - simulated.x, drawn.z - simulated.z));
      expect(row[4]).toBeGreaterThan(0);
      expect(row[4]).toBeLessThanOrEqual(1);
    }
    // 误差只来自毫格取整与拐角倒角，远小于一个敌人的身位
    expect(worst).toBeLessThan(0.12 * field.unit);
    expect(frame.base).toEqual([s.base_hp, pack.map.base_hp]);
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
  });

  it('td:frame：塔位状态串——悬停 1、军师建议 2、推演 3、已占 4；已占的不被别的状态盖掉', () => {
    const s = playSome(pack, 2, 1);
    const frame = encodeFrame(s, pack, field, idleUi({ hoverPad: 5, advisedPads: [0, 3], previewPads: [4], ring: [5, 12.345], tips: [[3, 'A·塔']] })) as any;
    expect(frame.pads[0]).toBe('4');
    expect(frame.pads[1]).toBe('4');
    expect(frame.pads[3]).toBe('2');
    expect(frame.pads[4]).toBe('3');
    expect(frame.pads[5]).toBe('1');
    expect(frame.pads[6]).toBe('0');
    expect(frame.ring).toEqual([5, 12.35]);
    expect(frame.tips).toEqual([[3, 'A·塔']]);
  });

  it('模拟分支号 → 路线下标与进度 → 弧长：起点对起点、终点对终点', () => {
    const milli = routeMilli(pack);
    expect(milli).toHaveLength(field.routes.length);
    expect(routeIndex(field, 0)).toBe(0);
    expect(routeIndex(field, undefined)).toBe(0);
    if (field.routes.length > 1) expect(routeIndex(field, 1)).toBe(1);
    else expect(routeIndex(field, 1)).toBe(0);
    field.routes.forEach((r, i) => {
      expect(arcOf(field, milli, i, 0)).toBe(0);
      expect(arcOf(field, milli, i, milli[i])).toBeCloseTo(r.len, 6);
      expect(arcOf(field, milli, i, milli[i] * 5)).toBeCloseTo(r.len, 6);
    });
  });
});

describe('td:frame：一次性事件与弹道', () => {
  const { field, pack } = fieldFor('union-atlas-3d');
  it('弹道带命中点的世界坐标；fx 原样带出（坐标取两位小数）', () => {
    const s = playSome(pack, 3, 200);
    const frame = encodeFrame(s, pack, field, idleUi({ phase: 'wave', shots: [[1, 2, 10.126, -3.333]], fx: [['die', 1.005, 2], ['leak', -9, 4.4444]] })) as any;
    expect(frame.shots).toEqual([[1, 2, 10.13, -3.33]]);
    expect(frame.fx[0][0]).toBe('die');
    expect(frame.fx[1]).toEqual(['leak', -9, 4.44]);
  });
});

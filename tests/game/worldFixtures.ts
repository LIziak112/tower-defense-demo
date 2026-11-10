// 世界战场测试用的地图夹具（合成的街道网；真实宿主导出的四款皮肤见 tests/fixtures/world/*.json）
import { parseWorldMap, type HostWorldMap, type WorldRoad } from '../../src/game/worldField';

/** 仿 river-grid（共和国·工业星图）的街道网：横街被河断成两段、每隔一条有桥，中间一块市政广场 */
export function gridCityFixture(): HostWorldMap {
  const roads: WorldRoad[] = [];
  const xs = [-102.5, -61.5, -20.5, 20.5, 43.5, 84.5, 125.5], zs = [-102.5, -61.5, -20.5, 20.5, 61.5, 102.5];
  const west = 20.5, east = 43.5;
  for (const z of zs) {
    roads.push({ id: `h${z}w`, kind: Math.abs(z) < 30 ? 'avenue' : 'street', w: Math.abs(z) < 30 ? 9 : 5, pts: [[xs[0], 0.06, z], [west, 0.06, z]] });
    roads.push({ id: `h${z}e`, kind: 'street', w: 5, pts: [[east, 0.06, z], [xs[xs.length - 1], 0.06, z]] });
  }
  for (const x of xs) roads.push({ id: `v${x}`, kind: x === west || x === east ? 'quay' : 'street', w: 5, pts: [[x, 0.06, zs[0]], [x, 0.06, zs[zs.length - 1]]] });
  for (const z of [-102.5, -20.5, 20.5, 102.5]) roads.push({ id: `b${z}`, kind: 'bridge', w: 5, pts: [[west, 0.3, z], [east, 0.3, z]] });
  const blocks: [number, number, number][] = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < zs.length - 1; j++) {
    if (xs[i] === west) continue;   // 河
    const bx = (xs[i] + xs[i + 1]) / 2, bz = (zs[j] + zs[j + 1]) / 2;
    if (Math.abs(bx) < 1 && Math.abs(bz) < 1) continue;   // 市政广场
    for (const dx of [-10.5, -3.5, 3.5, 10.5]) for (const dz of [-10.5, -3.5, 3.5, 10.5]) blocks.push([bx + dx, bz + dz, 3.15]);
  }
  return parseWorldMap({
    v: 2, skin: 'union-atlas-3d', layout: 'river-grid', scene: 'kit-land',
    bounds: { minX: -105, maxX: 128, minZ: -105, maxZ: 105 },
    roads,
    places: [
      { key: 'home', kind: 'home', label: '母星', x: 0, z: 0, r: 7 },
      { key: 'e1', kind: 'entity', label: '钢铁厂', x: -80, z: -80, r: 3.6 },
      { key: 'e2', kind: 'entity', label: '发电站', x: 100, z: 80, r: 3.6 },
      { key: 'e3', kind: 'entity', label: '机车库', x: -85, z: 78, r: 3.6 },
      { key: 'e4', kind: 'entity', label: '码头仓', x: 100, z: -78, r: 3.6 },
    ],
    blocks,
    water: [{ pts: [[32, -110], [32, 110]], w: 12 }],
  })!;
}


// Three-layer validation: Schema -> Semantic -> Guardrails. Errors: {code, path, actual?, allowed?, message}.
import { PackSchema, type RawPack } from './schema';
import { GUARDRAILS as G } from './guardrails';
import assets from './assets.json';

export interface VError { code: string; path: string; actual?: unknown; allowed?: unknown; message: string }
export interface VWarning { code: string; message: string }
export type ValidateResult = { ok: true; pack: RawPack; errors: []; warnings: VWarning[] } | { ok: false; errors: VError[]; warnings: VWarning[] };

const ptr = (p: (string | number | symbol)[]) => '/' + p.map(String).join('/');
const ASSET_IDS = new Set(assets.assets.map((a) => a.asset_id));
const PALETTES = new Set(assets.palettes.map((p) => p.palette_id));
const TILESETS = new Set(assets.tilesets.map((t) => t.tileset_id));

export function expandPath(path: [number, number][]): { cells: [number, number][]; errors: VError[] } {
  const cells: [number, number][] = []; const errors: VError[] = []; const seen = new Set<string>();
  const add = (x: number, y: number, i: number) => {
    const k = `${x},${y}`;
    if (seen.has(k)) errors.push({ code: 'PATH_SELF_INTERSECT', path: `/map/path/${i}`, actual: [x, y], message: `路径在 [${x},${y}] 处与自己相交` });
    seen.add(k); cells.push([x, y]);
  };
  if (path.length) add(path[0][0], path[0][1], 0);
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1], [bx, by] = path[i];
    if ((ax !== bx && ay !== by) || (ax === bx && ay === by)) {
      errors.push({ code: 'PATH_NOT_CONNECTED', path: `/map/path/${i}`, actual: [bx, by], message: `路径点 [${bx},${by}] 与前一点 [${ax},${ay}] 不在同一行或同一列` });
      continue;
    }
    const dx = Math.sign(bx - ax), dy = Math.sign(by - ay); let x = ax, y = ay;
    while (x !== bx || y !== by) { x += dx; y += dy; add(x, y, i); }
  }
  return { cells, errors };
}

function range(errors: VError[], path: string, actual: number, r: { min: number; max: number }, what: string) {
  if (actual < r.min || actual > r.max) errors.push({ code: 'VALUE_OUT_OF_RANGE', path, actual, allowed: { min: r.min, max: r.max }, message: `${what}必须在 ${r.min}-${r.max} 之间（现在是 ${actual}）` });
}

export function validatePack(input: unknown): ValidateResult {
  // Layer 1
  const parsed = PackSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, warnings: [], errors: parsed.error.issues.map((i) => ({ code: 'SCHEMA_INVALID', path: ptr(i.path), message: `字段 ${ptr(i.path)} 格式不对：${i.message}` })) };
  }
  const p = parsed.data; const errors: VError[] = [];
  // Layer 2: semantic
  const dupe = (arr: { id: string }[], base: string) => { const s = new Set<string>(); arr.forEach((x, i) => { if (s.has(x.id)) errors.push({ code: 'DUPLICATE_ID', path: `/${base}/${i}/id`, actual: x.id, message: `id ${x.id} 重复了` }); s.add(x.id); }); };
  dupe(p.towers, 'towers'); dupe(p.enemies, 'enemies');
  const pres = (pr: { asset_id: string; palette_id: string }, base: string) => {
    if (!ASSET_IDS.has(pr.asset_id)) errors.push({ code: 'UNKNOWN_ASSET', path: `${base}/asset_id`, actual: pr.asset_id, allowed: [...ASSET_IDS], message: `素材 ${pr.asset_id} 不在 assets.json 清单里` });
    if (!PALETTES.has(pr.palette_id)) errors.push({ code: 'UNKNOWN_PALETTE', path: `${base}/palette_id`, actual: pr.palette_id, allowed: [...PALETTES], message: `色板 ${pr.palette_id} 不在 assets.json 清单里` });
  };
  p.towers.forEach((t, i) => pres(t.components.Presentation, `/towers/${i}/components/Presentation`));
  p.enemies.forEach((e, i) => pres(e.components.Presentation, `/enemies/${i}/components/Presentation`));
  if (!TILESETS.has(p.map.presentation.tileset_id)) errors.push({ code: 'UNKNOWN_TILESET', path: '/map/presentation/tileset_id', actual: p.map.presentation.tileset_id, allowed: [...TILESETS], message: `地块集 ${p.map.presentation.tileset_id} 不在清单里` });
  if (!PALETTES.has(p.map.presentation.palette_id)) errors.push({ code: 'UNKNOWN_PALETTE', path: '/map/presentation/palette_id', actual: p.map.presentation.palette_id, allowed: [...PALETTES], message: `色板 ${p.map.presentation.palette_id} 不在清单里` });
  const enemyIds = new Set(p.enemies.map((e) => e.id));
  p.waves.forEach((w, wi) => w.groups.forEach((g, gi) => { if (!enemyIds.has(g.enemy_id)) errors.push({ code: 'UNKNOWN_REF', path: `/waves/${wi}/groups/${gi}/enemy_id`, actual: g.enemy_id, allowed: [...enemyIds], message: `波次引用了不存在的敌人 ${g.enemy_id}` }); }));
  const { width: W, height: H } = p.map.grid;
  const inGrid = ([x, y]: [number, number]) => x >= 0 && y >= 0 && x < W && y < H;
  p.map.path.forEach((c, i) => { if (!inGrid(c)) errors.push({ code: 'CELL_OUT_OF_GRID', path: `/map/path/${i}`, actual: c, allowed: { width: W, height: H }, message: `路径点 [${c}] 超出 ${W}×${H} 地图` }); });
  const ex = expandPath(p.map.path); errors.push(...ex.errors);
  const onPath = new Set(ex.cells.map((c) => c.join(',')));
  const seenB = new Set<string>();
  p.map.buildable_cells.forEach((c, i) => {
    if (!inGrid(c)) errors.push({ code: 'CELL_OUT_OF_GRID', path: `/map/buildable_cells/${i}`, actual: c, message: `可建造格 [${c}] 超出地图` });
    if (onPath.has(c.join(','))) errors.push({ code: 'BUILDABLE_ON_PATH', path: `/map/buildable_cells/${i}`, actual: c, message: `可建造格 [${c}] 在敌人路径上` });
    if (seenB.has(c.join(','))) errors.push({ code: 'DUPLICATE_CELL', path: `/map/buildable_cells/${i}`, actual: c, message: `可建造格 [${c}] 重复` });
    seenB.add(c.join(','));
  });
  if (p.map.terrain !== undefined) errors.push({ code: 'UNSUPPORTED_FIELD', path: '/map/terrain', message: '本期未实现地形（高地修正），请去掉 terrain' });
  // Layer 3: guardrails
  p.towers.forEach((t, i) => {
    const b = `/towers/${i}/components`;
    range(errors, `${b}/Attack/damage`, t.components.Attack.damage, G.tower_damage, '塔伤害');
    range(errors, `${b}/Attack/interval_ticks`, t.components.Attack.interval_ticks, G.tower_interval_ticks, '塔攻击间隔');
    range(errors, `${b}/Attack/range_milli`, t.components.Attack.range_milli, G.tower_range_milli, '塔射程');
    range(errors, `${b}/Buildable/cost`, t.components.Buildable.cost, G.tower_cost, '塔造价');
  });
  p.enemies.forEach((e, i) => {
    const b = `/enemies/${i}/components`;
    range(errors, `${b}/Health/max`, e.components.Health.max, G.enemy_max_health, '敌人最大生命');
    range(errors, `${b}/Movement/speed_milli_per_tick`, e.components.Movement.speed_milli_per_tick, G.enemy_speed, '敌人速度');
    range(errors, `${b}/Reward/gold`, e.components.Reward.gold, G.enemy_gold, '敌人赏金');
  });
  p.waves.forEach((w, i) => range(errors, `/waves/${i}/groups`, w.groups.reduce((a, g) => a + g.count, 0), G.wave_total_enemies, `第 ${i + 1} 波敌人总数`));
  range(errors, '/waves', p.waves.length, G.wave_count, '波次数量');
  range(errors, '/map/path', p.map.path.length, G.path_points, '路径折点数');
  if (errors.length) return { ok: false, errors, warnings: [] };
  return { ok: true, pack: p, errors: [], warnings: [] };
}

import assets from './assets.json';
import { GUARDRAILS as G } from './guardrails';
import { openingRaw } from './opening';
import type { RawPack } from './schema';
import { expandPath } from './validate';
import { TARGET_MODES } from '../runtime/types';

const VALID_ASSETS = assets.assets.map((a) => a.asset_id);
const VALID_PALETTES = assets.palettes.map((p) => p.palette_id);
const VALID_TILESETS = assets.tilesets.map((t) => t.tileset_id);

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.max(min, Math.min(max, n));
}

function pickValidId(v: unknown, allowed: string[], fallback: string): string {
  return typeof v === 'string' && allowed.includes(v) ? v : fallback;
}

/**
 * 对真 LLM 生成的关卡内容包（RawPack）做确定性自愈校准：
 * - 自动修复轻微越界的塔/敌军数值到 GUARDRAILS 区间；
 * - 自动过滤压在 path 上或越界/重复的 buildable_cells，若不足则沿 path 两侧自动铺设合法建塔位；
 * - 自动修正未知的 Presentation asset_id / palette_id / tileset_id；
 * 使真 LLM 单次生成即可通过 validatePack，避免因手写坐标失误触发 3 轮重试超时降级到 Mock。
 */
export function sanitizeLlmPack(input: unknown): RawPack {
  const fallback = openingRaw();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input as RawPack;
  const check = input as Record<string, any>;
  // 若返回的对象连关卡包的基本顶层骨架（meta / towers / enemies / map / waves）都不具备（例如测试桩故意返回战局建议对象），原样交由 validatePack 报错重试
  if (!check.meta || !Array.isArray(check.towers) || !Array.isArray(check.enemies) || !check.map || !Array.isArray(check.waves)) {
    return input as RawPack;
  }
  const raw = JSON.parse(JSON.stringify(input)) as Record<string, any>;

  // 1. meta
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const theme = typeof meta.theme === 'string' && meta.theme.trim() ? meta.theme.trim().slice(0, 40) : fallback.meta.theme;
  const description = typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim().slice(0, 160) : fallback.meta.description;

  // 2. towers
  const rawTowers = Array.isArray(raw.towers) && raw.towers.length ? raw.towers.slice(0, 6) : fallback.towers;
  const seenTowerIds = new Set<string>();
  const towers = rawTowers.map((t: any, i: number) => {
    const fbTower = fallback.towers[i % fallback.towers.length];
    let id = typeof t?.id === 'string' && /^[a-z0-9_]+$/i.test(t.id.trim()) ? t.id.trim().toLowerCase() : fbTower.id;
    if (seenTowerIds.has(id)) id = `${id}_${i + 1}`;
    seenTowerIds.add(id);
    const comp = t?.components && typeof t.components === 'object' ? t.components : {};
    const towerAssets = VALID_ASSETS.filter((a) => a.startsWith('tower_'));
    return {
      id, levels: t?.levels, branch_upgrades: t?.branch_upgrades, damage_vs_armor: t?.damage_vs_armor,
      display_name: typeof t?.display_name === 'string' && t.display_name.trim() ? t.display_name.trim().slice(0, 20) : fbTower.display_name,
      components: {
        Health: { max: clampInt(comp.Health?.max, 10, 1000, 100) },
        Attack: {
          projectile: comp.Attack?.projectile, on_hit: comp.Attack?.on_hit,
          crit_percent: comp.Attack?.crit_percent, crit_multiplier: comp.Attack?.crit_multiplier,
          damage: clampInt(comp.Attack?.damage, G.tower_damage.min, G.tower_damage.max, fbTower.components.Attack.damage),
          range_milli: clampInt(comp.Attack?.range_milli, G.tower_range_milli.min, G.tower_range_milli.max, fbTower.components.Attack.range_milli),
          interval_ticks: clampInt(comp.Attack?.interval_ticks, G.tower_interval_ticks.min, G.tower_interval_ticks.max, fbTower.components.Attack.interval_ticks),
        },
        Targeting: { mode: TARGET_MODES.includes(comp.Targeting?.mode) ? comp.Targeting.mode : 'first_on_path' },
        Buildable: {
          cost: clampInt(comp.Buildable?.cost, G.tower_cost.min, G.tower_cost.max, fbTower.components.Buildable.cost),
        },
        Presentation: {
          asset_id: pickValidId(comp.Presentation?.asset_id, VALID_ASSETS, towerAssets[i % towerAssets.length] || fbTower.components.Presentation.asset_id),
          palette_id: pickValidId(comp.Presentation?.palette_id, VALID_PALETTES, fbTower.components.Presentation.palette_id),
        },
      },
    };
  });

  // 3. enemies
  const rawEnemies = Array.isArray(raw.enemies) && raw.enemies.length ? raw.enemies.slice(0, 6) : fallback.enemies;
  const seenEnemyIds = new Set<string>();
  const enemies = rawEnemies.map((e: any, i: number) => {
    const fbEnemy = fallback.enemies[i % fallback.enemies.length];
    let id = typeof e?.id === 'string' && /^[a-z0-9_]+$/i.test(e.id.trim()) ? e.id.trim().toLowerCase() : fbEnemy.id;
    if (seenEnemyIds.has(id)) id = `${id}_${i + 1}`;
    seenEnemyIds.add(id);
    const comp = e?.components && typeof e.components === 'object' ? e.components : {};
    const enemyAssets = VALID_ASSETS.filter((a) => a.startsWith('enemy_'));
    return {
      id,
      display_name: typeof e?.display_name === 'string' && e.display_name.trim() ? e.display_name.trim().slice(0, 20) : fbEnemy.display_name,
      components: {
        Health: {
          max: clampInt(comp.Health?.max, G.enemy_max_health.min, G.enemy_max_health.max, fbEnemy.components.Health.max),
        },
        Movement: {
          speed_milli_per_tick: clampInt(comp.Movement?.speed_milli_per_tick, G.enemy_speed.min, G.enemy_speed.max, fbEnemy.components.Movement.speed_milli_per_tick),
        },
        PathFollower: {
          base_damage: clampInt(comp.PathFollower?.base_damage, 1, 20, fbEnemy.components.PathFollower.base_damage),
        },
        Defense: comp.Defense,
        Reward: {
          gold: clampInt(comp.Reward?.gold, G.enemy_gold.min, G.enemy_gold.max, fbEnemy.components.Reward.gold),
        },
        Presentation: {
          asset_id: pickValidId(comp.Presentation?.asset_id, VALID_ASSETS, enemyAssets[i % enemyAssets.length] || fbEnemy.components.Presentation.asset_id),
          palette_id: pickValidId(comp.Presentation?.palette_id, VALID_PALETTES, fbEnemy.components.Presentation.palette_id),
        },
      },
    };
  });

  // 4. map & path & buildable_cells
  const rawMap = raw.map && typeof raw.map === 'object' ? raw.map : {};
  const W = clampInt(rawMap.grid?.width, 6, 24, fallback.map.grid.width);
  const H = clampInt(rawMap.grid?.height, 6, 20, fallback.map.grid.height);
  const inGrid = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < W && y < H;

  let path: [number, number][] = Array.isArray(rawMap.path)
    ? rawMap.path
        .filter((c: any) => Array.isArray(c) && c.length >= 2)
        .map((c: any): [number, number] => [Math.round(Number(c[0])), Math.round(Number(c[1]))])
        .filter(([x, y]: [number, number]) => inGrid(x, y))
        .slice(0, G.path_points.max)
    : [];

  let pathExpanded = expandPath(path);
  if (path.length < G.path_points.min || pathExpanded.errors.length > 0) {
    // 若 LLM 给的折点不连通或自交，使用适配当前网格尺寸的合法折线路径
    path = W === fallback.map.grid.width && H === fallback.map.grid.height
      ? (fallback.map.path.map((c) => [c[0], c[1]]) as [number, number][])
      : [
          [0, 1],
          [Math.floor(W * 0.35), 1],
          [Math.floor(W * 0.35), Math.floor(H * 0.45)],
          [Math.floor(W * 0.75), Math.floor(H * 0.45)],
          [Math.floor(W * 0.75), H - 2],
          [W - 1, H - 2],
        ];
    pathExpanded = expandPath(path);
  }

  const onPath = new Set(pathExpanded.cells.map(([x, y]) => `${x},${y}`));
  const seenBuild = new Set<string>();
  const buildable_cells: [number, number][] = [];

  if (Array.isArray(rawMap.buildable_cells)) {
    for (const c of rawMap.buildable_cells) {
      if (!Array.isArray(c) || c.length < 2) continue;
      const x = Math.round(Number(c[0])), y = Math.round(Number(c[1]));
      const k = `${x},${y}`;
      if (!inGrid(x, y) || onPath.has(k) || seenBuild.has(k)) continue;
      seenBuild.add(k);
      buildable_cells.push([x, y]);
    }
  }

  // 若合法建塔格少于 12 个，自动沿路径两侧补齐紧邻路径的战术建塔位
  if (buildable_cells.length < 12) {
    for (const [px, py] of pathExpanded.cells) {
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const nx = px + dx, ny = py + dy;
        const k = `${nx},${ny}`;
        if (inGrid(nx, ny) && !onPath.has(k) && !seenBuild.has(k)) {
          seenBuild.add(k);
          buildable_cells.push([nx, ny]);
        }
      }
    }
  }

  // 5. waves
  const validEnemyIds = enemies.map((e) => e.id);
  const rawWaves = Array.isArray(raw.waves) && raw.waves.length >= G.wave_count.min
    ? raw.waves.slice(0, G.wave_count.max)
    : fallback.waves;

  const waves = rawWaves.map((w: any, wi: number) => {
    const rawGroups = Array.isArray(w?.groups) && w.groups.length ? w.groups.slice(0, 4) : [{ enemy_id: validEnemyIds[0], count: 6, interval_ticks: 24 }];
    const groups: { enemy_id: string; count: number; interval_ticks: number }[] = rawGroups.map((g: any, gi: number) => ({
      enemy_id: typeof g?.enemy_id === 'string' && validEnemyIds.includes(g.enemy_id) ? g.enemy_id : validEnemyIds[(wi + gi) % validEnemyIds.length],
      count: clampInt(g?.count, 1, G.wave_total_enemies.max, 6),
      interval_ticks: clampInt(g?.interval_ticks, 5, 180, 24),
    }));
    // 确保单波敌人总数在 [G.wave_total_enemies.min, G.wave_total_enemies.max] 内
    const total = groups.reduce((acc: number, g) => acc + g.count, 0);
    if (total < G.wave_total_enemies.min) {
      groups[0].count += G.wave_total_enemies.min - total;
    } else if (total > G.wave_total_enemies.max) {
      const scale = G.wave_total_enemies.max / total;
      let rem = G.wave_total_enemies.max;
      groups.forEach((g, idx: number) => {
        if (idx === groups.length - 1) g.count = Math.max(1, rem);
        else {
          g.count = Math.max(1, Math.floor(g.count * scale));
          rem -= g.count;
        }
      });
    }
    return {
      id: typeof w?.id === 'string' && w.id.trim() ? w.id.trim().slice(0, 24) : `w${wi + 1}`,
      groups,
    };
  });

  return {
    wave_rules: raw.wave_rules, difficulty: raw.difficulty,
    meta: {
      theme,
      description,
      ...(typeof meta.generated_from === 'string' ? { generated_from: meta.generated_from } : {}),
    },
    towers,
    enemies,
    map: {
      grid: { width: W, height: H },
      path,
      buildable_cells,
      base: { max_health: clampInt(rawMap.base?.max_health, 5, 100, fallback.map.base.max_health) },
      starting_gold: clampInt(rawMap.starting_gold, 60, 2000, fallback.map.starting_gold),
      presentation: {
        tileset_id: pickValidId(rawMap.presentation?.tileset_id, VALID_TILESETS, fallback.map.presentation.tileset_id),
        palette_id: pickValidId(rawMap.presentation?.palette_id, VALID_PALETTES, fallback.map.presentation.palette_id),
      },
    },
    waves,
  };
}

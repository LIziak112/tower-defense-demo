// Layer 1: Schema (zod). Content pack format follows demo开发文档.md §4 (no new fields).
import { z } from 'zod';
const int = z.number().int();
const cell = z.tuple([int, int]);
const presentation = z.object({ asset_id: z.string().min(1), palette_id: z.string().min(1) });
export const TowerSchema = z.object({
  id: z.string().min(1), display_name: z.string().min(1),
  components: z.object({
    Health: z.object({ max: int }),
    Attack: z.object({ damage: int, range_milli: int, interval_ticks: int }),
    Targeting: z.object({ mode: z.literal('first_on_path') }),
    Buildable: z.object({ cost: int }),
    Presentation: presentation,
  }),
});
export const EnemySchema = z.object({
  id: z.string().min(1), display_name: z.string().min(1),
  components: z.object({
    Health: z.object({ max: int }),
    Movement: z.object({ speed_milli_per_tick: int }),
    PathFollower: z.object({ base_damage: int.min(1) }),
    Reward: z.object({ gold: int }),
    Presentation: presentation,
  }),
});
export const PackSchema = z.object({
  meta: z.object({ theme: z.string().min(1), description: z.string(), generated_from: z.string().optional() }),
  towers: z.array(TowerSchema).min(1),
  enemies: z.array(EnemySchema).min(1),
  map: z.object({
    grid: z.object({ width: int.min(4).max(32), height: z.number().int().min(4).max(32) }),
    path: z.array(cell),
    buildable_cells: z.array(cell).min(1),
    terrain: z.unknown().optional(),
    base: z.object({ max_health: int.min(1).max(100) }),
    starting_gold: int.min(0).max(2000),
    presentation: z.object({ tileset_id: z.string().min(1), palette_id: z.string().min(1) }),
  }),
  waves: z.array(z.object({
    id: z.string().min(1),
    groups: z.array(z.object({ enemy_id: z.string().min(1), count: int.min(1), interval_ticks: int.min(1).max(600) })).min(1),
  })),
});
export type RawPack = z.infer<typeof PackSchema>;

import { z } from 'zod';
import { TARGET_MODES } from '../runtime/types';
import rules from './combat-rules.json';
const int = z.number().int();
const cell = z.tuple([int, int]);
const presentation = z.object({ asset_id: z.string().min(1), palette_id: z.string().min(1) });
const ticks = int.min(1).max(600);
const effect = z.object({ type: z.literal('ARMOR_SHRED'), value: int.min(1).max(100), duration_ticks: ticks });
const projectile = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ARC'), ticks, height: int.min(0).max(5000) }),
  z.object({ type: z.literal('HOMING'), ticks, speed: int.min(1).max(5000), turn_rate: z.number().positive().max(Math.PI) }),
  z.object({ type: z.literal('BEAM'), ticks, interval_ticks: ticks }),
]);
const attackExtras = {
  projectile: projectile.optional(), on_hit: effect.optional(),
  crit_percent: int.min(0).max(100).optional(), crit_multiplier: z.number().min(1).max(5).optional(),
};
const level = z.object({
  damage: int.min(1).max(500), range: int.min(1).max(10000), interval_ticks: ticks,
  upgrade_cost: int.min(1).max(2000), ...attackExtras,
});
export const TowerSchema = z.object({
  id: z.string().min(1), display_name: z.string().min(1),
  components: z.object({
    Health: z.object({ max: int }),
    Attack: z.object({ damage: int, range_milli: int, interval_ticks: int, ...attackExtras }),
    Targeting: z.object({ mode: z.enum(TARGET_MODES) }),
    Buildable: z.object({ cost: int }),
    Presentation: presentation,
  }),
  levels: z.array(level).max(10).optional(),
  branch_upgrades: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), level })).max(6).optional(),
  damage_vs_armor: z.record(z.string().min(1), z.number().positive().max(5)).optional(),
});
export const EnemySchema = z.object({
  id: z.string().min(1), display_name: z.string().min(1),
  components: z.object({
    Health: z.object({ max: int }),
    Movement: z.object({ speed_milli_per_tick: int }),
    PathFollower: z.object({ base_damage: int.min(1) }),
    Reward: z.object({ gold: int }),
    Defense: z.object({
      armor: int.min(0).max(100), armor_type: z.string().min(1),
      immunities: z.array(z.literal('ARMOR_SHRED')).max(1).optional(),
    }).optional(),
    Presentation: presentation,
  }),
});
export const PackSchema = z.object({
  difficulty: z.number().min(0.5).max(2).default(rules.difficulty),
  wave_rules: z.object({
    prep_ticks: int.min(30).max(3600), gold_per_second: int.min(0).max(20),
    cooldown_ticks_per_second: int.min(0).max(30),
    build_cooldown_ticks: int.min(0).max(300).default(0),
  }).default(rules.wave),
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

// Layer 3 numeric guardrails for authored and generated packs.
export const GUARDRAILS = {
  tower_damage: { min: 1, max: 100 },
  tower_interval_ticks: { min: 5, max: 120 },
  tower_range_milli: { min: 1000, max: 5000 },
  tower_cost: { min: 20, max: 300 },
  enemy_max_health: { min: 10, max: 2000 },
  enemy_speed: { min: 10, max: 150 },
  enemy_gold: { min: 1, max: 100 },
  wave_total_enemies: { min: 3, max: 150 },
  wave_count: { min: 3, max: 10 },
  path_points: { min: 4, max: 30 },
} as const;

// Runtime types. Zero dependencies: no rendering lib, no ambient randomness, no wall clock.
export type Cell = { x: number; y: number };
export const TARGET_MODES = ['first_on_path', 'last_on_path', 'highest_hp', 'nearest'] as const;
export type TargetMode = typeof TARGET_MODES[number];
export type HitEffect = { type: 'ARMOR_SHRED'; value: number; duration_ticks: number };
export type ProjectileDef =
  | { type: 'ARC'; ticks: number; height: number }
  | { type: 'HOMING'; ticks: number; speed: number; turn_rate: number }
  | { type: 'BEAM'; ticks: number; interval_ticks: number };
export interface TowerLevel {
  damage: number; range: number; interval_ticks: number; upgrade_cost?: number;
  projectile?: ProjectileDef; on_hit?: HitEffect; crit_percent?: number; crit_multiplier?: number;
}
export interface WaveRules {
  prep_ticks: number; gold_per_second: number; cooldown_ticks_per_second: number; build_cooldown_ticks: number;
}

export interface TowerDef {
  id: string;
  display_name: string;
  cost: number;
  damage: number;
  range: number; // milli-cell
  interval_ticks: number;
  color: string; // presentation only, never enters checksum
  targeting?: TargetMode;
  levels?: TowerLevel[];
  projectile?: ProjectileDef;
  on_hit?: HitEffect;
  crit_percent?: number;
  crit_multiplier?: number;
  damage_vs_armor?: Record<string, number>;
  branch_upgrades?: { id: string; name: string; level: TowerLevel & { upgrade_cost: number } }[];
}
export interface EnemyDef {
  id: string;
  display_name: string;
  hp: number;
  speed: number; // milli-cell per tick
  base_damage: number;
  reward: number;
  color: string;
  armor?: number;
  armor_type?: string;
  immunities?: HitEffect['type'][];
}
export interface WaveGroup { enemy_id: string; count: number; interval_ticks: number }
export interface WaveDef { id: string; groups: WaveGroup[] }
export interface MapDef {
  width: number;
  height: number;
  path: Cell[]; // waypoints (cell coords), axis-aligned adjacent segments
  buildable_cells: Cell[];
  base_hp: number;
  starting_gold: number;
}
export interface ContentPack {
  meta: { theme: string; description: string };
  towers: TowerDef[];
  enemies: EnemyDef[];
  map: MapDef;
  waves: WaveDef[];
  wave_rules?: WaveRules;
  difficulty?: number;
}

export type Life = 'pending' | 'alive' | 'dying' | 'escaped';

export interface TowerInst {
  iid: number; def: string; cx: number; cy: number; x: number; y: number;
  cooldown: number; life: Life;
  level?: number; // 缺省为初始等级，兼容现有状态与校验和
  targeting?: TargetMode;
  branch?: string;
}
export interface EnemyInst {
  iid: number; def: string; hp: number; progress: number; // milli-cell travelled along path
  x: number; y: number; life: Life;
  max_hp?: number;
  shred?: number;
  shred_until?: number;
}
export interface Projectile {
  kind: ProjectileDef['type']; source: number; target: number; damage: number; critical: boolean; effect?: HitEffect;
  x: number; y: number; from_x: number; from_y: number; to_x: number; to_y: number;
  angle: number; age: number; duration: number; height: number; speed: number; turn: number; interval: number;
}
/** hp_mul：变招「铁甲」给这一波敌人加的血量倍率；没有就是 1（不写进字段，checksum 也不带）。 */
export interface SpawnPlan { enemy_id: string; at_tick: number; hp_mul?: number }

export type Phase = 'build' | 'wave' | 'won' | 'lost';

/** 变招（军师玩法增强 ②）：建造期接一张，下一波更难、现在拿一笔金币；每个建造期至多一张，不接无罚。规则表在 ./gambit.ts。 */
export type GambitId = 'swarm' | 'tight' | 'tough';
export interface GambitTaken { wave: number; id: GambitId; bonus: number }

export interface BattleState {
  tick: number;
  seed: number;
  rng: number;
  next_iid: number;
  gold: number;
  base_hp: number;
  phase: Phase;
  wave_index: number; // number of waves started
  spawn_queue: SpawnPlan[];
  towers: TowerInst[];
  enemies: EnemyInst[];
  occupied: string[]; // "x,y" sorted by insertion
  kills: number;
  leaks: number;
  pack: ContentPack;
  path_len: number;
  /** 本建造期接下的变招（wave = 它作用的 wave_index）；null = 没接。开波时按它改波次，之后留着供 HUD / 复盘读。 */
  gambit: GambitTaken | null;
  projectiles: Projectile[];
  prep_until: number;
  build_cooldown_credit: number;
}

export type Command =
  | { type: 'build'; tower_id: string; x: number; y: number }
  | { type: 'upgrade'; iid: number; fromLevel: number; branch?: string; tactical?: boolean }
  | { type: 'targeting'; iid: number; mode: TargetMode }
  | { type: 'start_wave' }
  | { type: 'gambit'; id: GambitId }
  | { type: 'debug_add_gold'; amount: number }
  | { type: 'debug_next_wave' };

export type GameEvent =
  | { type: 'build_ok'; iid: number; tower_id: string; x: number; y: number; cost: number }
  | { type: 'build_rejected'; code: string; message: string; tower_id: string; x: number; y: number }
  | { type: 'upgrade_ok'; iid: number; level: number; cost: number }
  | { type: 'upgrade_rejected'; code: 'WAVE_ACTIVE' | 'UNKNOWN_TOWER' | 'STALE_LEVEL' | 'MAX_LEVEL' | 'NOT_ENOUGH_GOLD' | 'UNKNOWN_BRANCH' }
  | { type: 'targeting_changed'; iid: number; mode: TargetMode }
  | { type: 'gold_changed'; gold: number; delta: number }
  | { type: 'early_wave'; gold: number; cooldown_ticks: number }
  | { type: 'wave_rejected'; code: string; message: string }
  | { type: 'wave_started'; wave: number; total: number }
  | { type: 'enemy_spawned'; iid: number; enemy_id: string }
  | { type: 'attack'; tower: number; target: number; fx: number; fy: number; tx: number; ty: number; projectile?: ProjectileDef['type']; arcHeight: number }
  | { type: 'damage_applied'; target: number; amount: number; hp: number; x: number; y: number; max_hp: number; critical: boolean; fromX: number; fromY: number; projectile?: ProjectileDef['type']; arcHeight: number; armorBlocked: number }
  | { type: 'entity_died'; iid: number; reward: number; x: number; y: number }
  | { type: 'entity_escaped'; iid: number; base_damage: number }
  | { type: 'wave_cleared'; wave: number }
  | { type: 'gambit_accepted'; id: GambitId; wave: number; bonus: number }
  | { type: 'gambit_rejected'; code: string; message: string; id: string }
  | { type: 'battle_ended'; result: 'won' | 'lost' };

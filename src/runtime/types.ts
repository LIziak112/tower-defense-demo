// Runtime types. Zero dependencies: no rendering lib, no ambient randomness, no wall clock.
export type Cell = { x: number; y: number };

export interface TowerDef {
  id: string;
  display_name: string;
  cost: number;
  damage: number;
  range: number; // milli-cell
  interval_ticks: number;
  color: string; // presentation only, never enters checksum
}
export interface EnemyDef {
  id: string;
  display_name: string;
  hp: number;
  speed: number; // milli-cell per tick
  base_damage: number;
  reward: number;
  color: string;
}
export interface WaveGroup { enemy_id: string; count: number; interval_ticks: number; branch?: number }
export interface WaveDef { id: string; groups: WaveGroup[] }
export interface MapDef {
  width: number;
  height: number;
  path: Cell[]; // primary waypoints (cell coords), axis-aligned adjacent segments
  /** 多分支并行进军路径（可选；branch 0 = path，branch 1..k = branch_paths[0..k-1]） */
  branch_paths?: Cell[][];
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
}

export type Life = 'pending' | 'alive' | 'dying' | 'escaped';

export interface TowerInst {
  iid: number; def: string; cx: number; cy: number; x: number; y: number;
  cooldown: number; life: Life;
}
export interface EnemyInst {
  iid: number; def: string; hp: number; progress: number; // milli-cell travelled along path
  x: number; y: number; life: Life;
  /** 所在分支路径下标（0 为主干，>=1 为并行分支；不设置时等价于 0） */
  branch?: number;
}
/** hp_mul：变招「铁甲」给这一波敌人加的血量倍率；没有就是 1（不写进字段，checksum 也不带）。 */
export interface SpawnPlan { enemy_id: string; at_tick: number; hp_mul?: number; branch?: number }

export type Phase = 'build' | 'wave' | 'won' | 'lost';

/** 变招（军师玩法增强 ②）：建造期接一张，下一波更难、现在拿一笔金币；每个建造期至多一张，不接无罚。规则表在 ./gambit.ts。 */
export type GambitId = 'swarm' | 'tight' | 'tough';
export interface GambitTaken { wave: number; id: GambitId; bonus: number }

export interface RoadCrater {
  id: string;
  branch: number;
  progress: number;
  cx: number;
  cy: number;
  createdAtTick: number;
}

export interface DemolishedBuilding {
  key: string;
  label: string;
  cx: number;
  cy: number;
  unlockedSlot: number;
  createdAtTick: number;
}

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
  /** 战斗中被炸毁的道路弹坑（退出或重开后自动清空复原） */
  craters?: RoadCrater[];
  /** 战斗中被推倒的皮肤建筑（退出或重开后自动清空复原） */
  demolished?: DemolishedBuilding[];
}

export type Command =
  | { type: 'build'; tower_id: string; x: number; y: number }
  | { type: 'start_wave' }
  | { type: 'gambit'; id: GambitId }
  | { type: 'blast_road'; branch?: number; x?: number; y?: number }
  | { type: 'demolish_building'; key: string; label?: string; x?: number; y?: number }
  | { type: 'advisor_bounty'; wave: number; bonus: number; predicted: number; actual: number }
  | { type: 'debug_add_gold'; amount: number }
  | { type: 'debug_next_wave' };

export type GameEvent =
  | { type: 'build_ok'; iid: number; tower_id: string; x: number; y: number; cost: number }
  | { type: 'build_rejected'; code: string; message: string; tower_id: string; x: number; y: number }
  | { type: 'wave_rejected'; code: string; message: string }
  | { type: 'wave_started'; wave: number; total: number }
  | { type: 'enemy_spawned'; iid: number; enemy_id: string; branch?: number }
  | { type: 'attack'; tower: number; target: number; fx: number; fy: number; tx: number; ty: number }
  | { type: 'damage_applied'; target: number; amount: number; hp: number }
  | { type: 'entity_died'; iid: number; reward: number; x: number; y: number }
  | { type: 'entity_escaped'; iid: number; base_damage: number }
  | { type: 'wave_cleared'; wave: number }
  | { type: 'gambit_accepted'; id: GambitId; wave: number; bonus: number }
  | { type: 'gambit_rejected'; code: string; message: string; id: string }
  | { type: 'road_blasted'; branch: number; cx: number; cy: number; cost: number; damagedEnemies: number }
  | { type: 'building_demolished'; key: string; label: string; cx: number; cy: number; bonusCp: number; damagedEnemies: number }
  | { type: 'advisor_bounty_awarded'; wave: number; bonus: number; predicted: number; actual: number }
  | { type: 'battle_ended'; result: 'won' | 'lost' };

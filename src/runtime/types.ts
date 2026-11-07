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
}

export type Life = 'pending' | 'alive' | 'dying' | 'escaped';

export interface TowerInst {
  iid: number; def: string; cx: number; cy: number; x: number; y: number;
  cooldown: number; life: Life;
}
export interface EnemyInst {
  iid: number; def: string; hp: number; progress: number; // milli-cell travelled along path
  x: number; y: number; life: Life;
}
export interface SpawnPlan { enemy_id: string; at_tick: number }

export type Phase = 'build' | 'wave' | 'won' | 'lost';

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
}

export type Command =
  | { type: 'build'; tower_id: string; x: number; y: number }
  | { type: 'start_wave' }
  | { type: 'debug_add_gold'; amount: number }
  | { type: 'debug_next_wave' };

export type GameEvent =
  | { type: 'build_ok'; iid: number; tower_id: string; x: number; y: number; cost: number }
  | { type: 'build_rejected'; code: string; message: string; tower_id: string; x: number; y: number }
  | { type: 'wave_rejected'; code: string; message: string }
  | { type: 'wave_started'; wave: number; total: number }
  | { type: 'enemy_spawned'; iid: number; enemy_id: string }
  | { type: 'attack'; tower: number; target: number; fx: number; fy: number; tx: number; ty: number }
  | { type: 'damage_applied'; target: number; amount: number; hp: number }
  | { type: 'entity_died'; iid: number; reward: number; x: number; y: number }
  | { type: 'entity_escaped'; iid: number; base_damage: number }
  | { type: 'wave_cleared'; wave: number }
  | { type: 'battle_ended'; result: 'won' | 'lost' };

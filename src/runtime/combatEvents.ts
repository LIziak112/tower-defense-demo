import type { GameEvent } from './types';

type HighFrequency = 'attack' | 'damage_applied' | 'entity_died' | 'entity_escaped' | 'enemy_spawned' | 'gold_changed' |
  'wave_started' | 'wave_cleared' | 'battle_ended';
type EventOf<K extends HighFrequency> = Extract<GameEvent, { type: K }>;
interface Pool { items: GameEvent[]; count: number }
export type EventSink = GameEvent[] | LiveCombatEvents;

/** Consumers read only items[0..count). Keeping the backing array full-sized avoids reallocating on reset. */
export class LiveCombatEvents {
  readonly items: GameEvent[];
  count = 0;
  private readonly pools = new Map<HighFrequency, Pool>();
  private readonly resetOrder: Pool[] = [];

  constructor(towers: number, projectiles: number, enemies: number) {
    this.items = new Array<GameEvent>(towers * 3 + projectiles + enemies * 3 + 4);
    this.reserve('attack', towers, { type: 'attack', tower: 0, target: 0, fx: 0, fy: 0, tx: 0, ty: 0, projectile: undefined, arcHeight: 0 });
    this.reserve('damage_applied', towers + projectiles, { type: 'damage_applied', target: 0, amount: 0, hp: 0, x: 0, y: 0, max_hp: 0, critical: false, fromX: 0, fromY: 0, projectile: undefined, arcHeight: 0, armorBlocked: 0 });
    this.reserve('entity_died', enemies, { type: 'entity_died', iid: 0, reward: 0, x: 0, y: 0 });
    this.reserve('entity_escaped', enemies, { type: 'entity_escaped', iid: 0, base_damage: 0 });
    this.reserve('enemy_spawned', enemies, { type: 'enemy_spawned', iid: 0, enemy_id: '' });
    this.reserve('gold_changed', 1, { type: 'gold_changed', gold: 0, delta: 0 });
    this.reserve('wave_started', 1, { type: 'wave_started', wave: 0, total: 0 });
    this.reserve('wave_cleared', 1, { type: 'wave_cleared', wave: 0 });
    this.reserve('battle_ended', 1, { type: 'battle_ended', result: 'won' });
  }

  private reserve<K extends HighFrequency>(type: K, count: number, sample: EventOf<K>) {
    const pool = { items: Array.from({ length: count }, () => ({ ...sample })), count: 0 };
    this.pools.set(type, pool);
    this.resetOrder.push(pool);
  }

  push(event: GameEvent) { this.items[this.count++] = event; }

  reset() {
    this.count = 0;
    for (let i = 0; i < this.resetOrder.length; i++) this.resetOrder[i].count = 0;
  }

  take<K extends HighFrequency>(type: K): EventOf<K> {
    const pool = this.pools.get(type)!;
    const item = pool.items[pool.count++] as EventOf<K> | undefined;
    if (!item) throw new Error(`Combat event pool exhausted: ${type}`);
    return item;
  }
}

export function combatEvent<K extends HighFrequency>(events: EventSink, type: K): EventOf<K> {
  const item = events instanceof LiveCombatEvents ? events.take(type) : { type } as EventOf<K>;
  events.push(item);
  return item;
}

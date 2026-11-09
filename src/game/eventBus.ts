import type { GameEvent } from '../runtime';

export function createEventBus() {
  const listeners = new Map<GameEvent['type'], ((event: GameEvent) => void)[]>();
  return {
    on<K extends GameEvent['type']>(type: K, listener: (event: Extract<GameEvent, { type: K }>) => void) {
      let handlers = listeners.get(type);
      if (!handlers) { handlers = []; listeners.set(type, handlers); }
      handlers.push(listener as (event: GameEvent) => void);
    },
    publish(events: readonly GameEvent[], count = events.length) {
      for (let i = 0; i < count; i++) {
        const event = events[i];
        const handlers = listeners.get(event.type);
        if (handlers) for (const handler of handlers) handler(event);
      }
    },
  };
}

export type BattleBus = ReturnType<typeof createEventBus>;

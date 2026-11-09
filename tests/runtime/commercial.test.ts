import { describe, expect, it } from 'vitest';
import { checksum, createBattle, createLiveBattle, step, stepInPlace, type Command, type ContentPack } from '../../src/runtime';
import { pickTarget } from '../../src/runtime/targeting';
import { DEFAULT_PACK } from '../../src/content/default';
import rules from '../../src/content/combat-rules.json';

const build = { type: 'build', tower_id: 'crossbow', x: 1, y: 0 } as const;
const liveEvents = (buffer: ReturnType<typeof stepInPlace>) => buffer.items.slice(0, buffer.count);
const start = { type: 'start_wave' } as const;

describe('commercial battle', () => {
  it('selects four distinct targets with stable ID tie breaks', () => {
    const tower = step(createBattle(DEFAULT_PACK, 7), [build], false).state.towers[0];
    const enemies = [
      [10, 90, 200, 1500], [8, 90, 200, 1500], [3, 50, 20, 2000], [4, 150, 100, 2200], [5, 100, 80, 1400],
    ].map(([iid, hp, progress, x]) => ({ iid, hp, progress, x, y: tower.y, def: 'footman', life: 'alive' as const }));
    expect(pickTarget(tower, enemies, 2000, 'first_on_path')?.iid).toBe(8);
    expect(pickTarget(tower, enemies, 2000, 'last_on_path')?.iid).toBe(3);
    expect(pickTarget(tower, enemies, 2000, 'highest_hp')?.iid).toBe(4);
    expect(pickTarget(tower, enemies, 2000, 'nearest')?.iid).toBe(8);
    expect(pickTarget(tower, enemies.slice(2), 2000, 'nearest')?.iid).toBe(5);
  });

  it('applies command-only tactical upgrades without advancing movement or the countdown', () => {
    const pack = { ...DEFAULT_PACK, wave_rules: rules.wave };
    const state = createLiveBattle(pack, 8);
    const events = liveEvents(stepInPlace(state, [build, start], false));
    expect(events).toContainEqual({ type: 'early_wave', gold: 30, cooldown_ticks: 60 });
    expect(state.tick).toBe(0);
    stepInPlace(state);
    const enemy = state.enemies[0];
    const upgrade: Command = { type: 'upgrade', iid: state.towers[0].iid, fromLevel: 1, tactical: true };
    expect(liveEvents(stepInPlace(state, [upgrade], false)).some((event) => event.type === 'upgrade_ok')).toBe(true);
    expect(state.tick).toBe(1);
    expect(enemy.progress).toBe(0);
    expect(liveEvents(stepInPlace(state, [start], false)).some((event) => event.type === 'early_wave')).toBe(false);
    const automatic = createLiveBattle({ ...pack, wave_rules: { ...rules.wave, prep_ticks: 1 } }, 2);
    stepInPlace(automatic);
    expect(liveEvents(stepInPlace(automatic)).some((event) => event.type === 'wave_started')).toBe(true);
    expect(automatic.gold).toBe(pack.map.starting_gold);
  });

  it.each([
    { type: 'ARC', ticks: 5, height: 400 },
    { type: 'HOMING', ticks: 24, speed: 300, turn_rate: 0.3 },
    { type: 'BEAM', ticks: 7, interval_ticks: 2 },
  ] as const)('replays $type through both pooled and snapshot paths', (projectile) => {
    const pack: ContentPack = {
      ...DEFAULT_PACK,
      towers: [{ ...DEFAULT_PACK.towers[0], projectile, crit_percent: 100, crit_multiplier: 1.5 }],
      enemies: DEFAULT_PACK.enemies.map((enemy) => ({ ...enemy, armor: 3 })),
    };
    const live = createLiveBattle(pack, 7);
    let snapshot = createBattle(pack, 7);
    let damageEvents = 0;
    for (let tick = 0; tick < 80; tick++) {
      const commands = tick === 0 ? [build, start] : [];
      const buffer = stepInPlace(live, commands);
      const events = liveEvents(buffer);
      const replay = step(snapshot, commands);
      expect(events).toEqual(replay.events);
      snapshot = replay.state;
      expect(checksum(live)).toBe(checksum(snapshot));
      for (const event of events) {
        if (event.type === 'attack') expect(event.arcHeight).toBe(projectile.type === 'ARC' ? projectile.height : 0);
        if (event.type === 'damage_applied') {
          expect(event.projectile).toBe(projectile.type);
          expect(event.critical).toBe(true);
          expect(event.armorBlocked).toBe(3);
          damageEvents++;
        }
      }
    }
    expect(damageEvents).toBeGreaterThan(projectile.type === 'BEAM' ? 3 : 0);
  });

  it('reuses enemy and high-frequency event records between waves', () => {
    const pack = {
      ...DEFAULT_PACK,
      enemies: [{ ...DEFAULT_PACK.enemies[0], speed: 50000 }],
      waves: ['first', 'second'].map((id) => ({ id, groups: [{ enemy_id: 'footman', count: 1, interval_ticks: 1 }] })),
    };
    const state = createLiveBattle(pack, 2);
    const first = liveEvents(stepInPlace(state, [start])).find((event) => event.type === 'enemy_spawned');
    const enemy = state.enemies[0];
    const id = enemy.iid;
    stepInPlace(state);
    const second = liveEvents(stepInPlace(state, [start])).find((event) => event.type === 'enemy_spawned');
    expect(second).toBe(first);
    expect(state.enemies[0]).toBe(enemy);
    expect(enemy.iid).not.toBe(id);
  });
});

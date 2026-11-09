// 变招（gambit）运行时规则：只在建造期、每建造期一张、即时加金、只改它作用的那一波；确定性；无变招时行为与以前完全一致。
import { describe, it, expect } from 'vitest';
import { createBattle, step, checksum, GAMBITS, gambitBonus, waveReward } from '../../src/runtime/index';
import type { BattleState, Command } from '../../src/runtime/index';
import { DEFAULT_PACK } from '../../src/content/default';

const run = (s: BattleState, cmds: Command[] = []) => step(s, cmds);
const toBuild = (s: BattleState) => { while (s.phase === 'wave') s = step(s).state; return s; };

describe('gambit', () => {
  it('建造期接下：加金、记录、事件；同建造期第二张 ALREADY_TAKEN；波内 NOT_BUILD_PHASE；未知 id UNKNOWN_GAMBIT', () => {
    const s0 = createBattle(DEFAULT_PACK, 1);
    const bonus = gambitBonus(DEFAULT_PACK, 0, 'swarm');
    expect(bonus).toBe(Math.round(waveReward(DEFAULT_PACK, 0) * GAMBITS.swarm.bonus_ratio));
    const r1 = run(s0, [{ type: 'gambit', id: 'swarm' }]);
    expect(r1.events).toContainEqual({ type: 'gambit_accepted', id: 'swarm', wave: 0, bonus });
    expect(r1.state.gold).toBe(s0.gold + bonus);
    expect(r1.state.gambit).toEqual({ wave: 0, id: 'swarm', bonus });
    const r2 = run(r1.state, [{ type: 'gambit', id: 'tough' }]);
    expect(r2.events.some((e) => e.type === 'gambit_rejected' && e.code === 'ALREADY_TAKEN')).toBe(true);
    expect(r2.state.gold).toBe(r1.state.gold);
    const w = run(r2.state, [{ type: 'start_wave' }]).state;
    expect(run(w, [{ type: 'gambit', id: 'tight' }]).events.some((e) => e.type === 'gambit_rejected' && e.code === 'NOT_BUILD_PHASE')).toBe(true);
    expect(run(s0, [{ type: 'gambit', id: 'nuke' as never }]).events.some((e) => e.type === 'gambit_rejected' && e.code === 'UNKNOWN_GAMBIT')).toBe(true);
  });
  it('swarm：下一波数量 ×1.5 向上取整；tight：间隔减半；tough：出生血量 ×1.4；都只影响接下时的那一波', () => {
    const s0 = createBattle(DEFAULT_PACK, 1);
    const swarm = run(run(s0, [{ type: 'gambit', id: 'swarm' }]).state, [{ type: 'start_wave' }]);
    expect(swarm.events.find((e) => e.type === 'wave_started')).toMatchObject({ total: Math.ceil(5 * 1.5) });
    const tight = run(run(s0, [{ type: 'gambit', id: 'tight' }]).state, [{ type: 'start_wave' }]).state;
    expect(tight.spawn_queue.map((p) => p.at_tick)).toEqual([16, 31, 46, 61]);   // 原 interval 30 → 15；首只（at 1）已在本 tick 出生
    let tough = run(run(s0, [{ type: 'gambit', id: 'tough' }]).state, [{ type: 'start_wave' }]).state;
    expect(tough.spawn_queue.every((p) => p.hp_mul === 1.4)).toBe(true);
    tough = step(tough).state;   // 第一只出生
    expect(tough.enemies[0].hp).toBe(Math.ceil(120 * 1.4));
    // 打完这一波回到建造期：下一波不受影响（原始 8 只）
    const next = run(toBuild(swarm.state), [{ type: 'start_wave' }]);
    expect(next.events.find((e) => e.type === 'wave_started')).toMatchObject({ total: 8 });
  });
  it('确定性：同脚本两次运行 checksum 一致；接变招与不接的局哈希不同；不接时 checksum 串不带变招段', () => {
    const script = (): BattleState => {
      let s = createBattle(DEFAULT_PACK, 9);
      s = run(s, [{ type: 'gambit', id: 'tough' }, { type: 'build', tower_id: 'crossbow', x: 2, y: 2 }]).state;
      s = run(s, [{ type: 'start_wave' }]).state;
      for (let i = 0; i < 200; i++) s = step(s).state;
      return s;
    };
    expect(checksum(script())).toBe(checksum(script()));
    let plain = createBattle(DEFAULT_PACK, 9);
    plain = run(plain, [{ type: 'build', tower_id: 'crossbow', x: 2, y: 2 }]).state;
    plain = run(plain, [{ type: 'start_wave' }]).state;
    for (let i = 0; i < 200; i++) plain = step(plain).state;
    expect(checksum(plain)).not.toBe(checksum(script()));
    expect(plain.gambit).toBeNull();
    expect(plain.spawn_queue.every((p) => p.hp_mul === undefined)).toBe(true);
  });
  it('没有下一波时拒绝（NO_MORE_WAVES）', () => {
    let s = createBattle(DEFAULT_PACK, 1);
    s = run(s, [{ type: 'debug_add_gold', amount: 5000 }]).state;
    // 用 debug_next_wave 把三波全开掉再清场到建造期不可能（会直接赢），所以构造：wave_index 到头且 phase=build 的状态
    const end = { ...s, wave_index: DEFAULT_PACK.waves.length, phase: 'build' as const };
    expect(run(end, [{ type: 'gambit', id: 'swarm' }]).events.some((e) => e.type === 'gambit_rejected' && e.code === 'NO_MORE_WAVES')).toBe(true);
  });
});

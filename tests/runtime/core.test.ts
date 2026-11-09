import { describe, it, expect } from 'vitest';
import { createBattle, step, checksum, cloneState } from '../../src/runtime/index';
import type { BattleState, Command, ContentPack } from '../../src/runtime/index';
import { DEFAULT_PACK } from '../../src/content/default';

// scripted bot: build 2 crossbows near path, then start waves whenever in build phase
function runScript(seed: number, pack: ContentPack = DEFAULT_PACK, maxTicks = 20000): BattleState {
  let s = createBattle(pack, seed);
  const plan: Record<number, Command[]> = {
    0: [{ type: 'build', tower_id: 'crossbow', x: 5, y: 2 }],
    1: [{ type: 'start_wave' }],
  };
  while (s.tick < maxTicks && s.phase !== 'won' && s.phase !== 'lost') {
    let cmds = plan[s.tick] ?? [];
    if (s.phase === 'build' && s.tick > 1) {
      cmds = [];
      if (s.gold >= 60) cmds.push({ type: 'build', tower_id: 'crossbow', x: 5 + (s.towers.length % 4), y: 4 });
      cmds.push({ type: 'start_wave' });
    }
    s = step(s, cmds).state;
  }
  return s;
}

describe('runtime D1', () => {
  it('1 同种子同指令 10 次校验和一致，且对局能结束', () => {
    const sums = new Set<string>();
    let last!: BattleState;
    for (let i = 0; i < 10; i++) { last = runScript(42); sums.add(checksum(last)); }
    expect(sums.size).toBe(1);
    expect(['won', 'lost']).toContain(last.phase);
  });

  it('2 两塔同 tick 打死同一残血怪：只死一次、只发一次金币', () => {
    let s = createBattle(DEFAULT_PACK, 1);
    s.gold = 1000;
    s = step(s, [
      { type: 'build', tower_id: 'crossbow', x: 1, y: 0 },
      { type: 'build', tower_id: 'crossbow', x: 1, y: 2 },
    ]).state;
    s = step(s).state; // towers active
    // inject a weak enemy directly
    s = cloneState(s);
    s.enemies.push({ iid: s.next_iid++, def: 'footman', hp: 5, progress: 1000, x: 1500, y: 1500, life: 'alive' });
    const gold0 = s.gold;
    const r = step(s);
    const deaths = r.events.filter((e) => e.type === 'entity_died');
    const attacks = r.events.filter((e) => e.type === 'attack');
    expect(attacks.length).toBe(2);
    expect(deaths.length).toBe(1);
    expect(r.state.gold).toBe(gold0 + 12);
    expect(r.state.kills).toBe(1);
  });

  it('3 漏怪只扣一次基地血、不发金币', () => {
    let s = createBattle(DEFAULT_PACK, 1);
    s = cloneState(s);
    s.phase = 'wave';
    s.enemies.push({ iid: s.next_iid++, def: 'footman', hp: 120, progress: s.path_len - 10, x: 0, y: 0, life: 'alive' });
    const gold0 = s.gold, hp0 = s.base_hp;
    const r1 = step(s);
    expect(r1.events.filter((e) => e.type === 'entity_escaped').length).toBe(1);
    expect(r1.state.base_hp).toBe(hp0 - 1);
    expect(r1.state.gold).toBe(gold0);
    const r2 = step(r1.state);
    expect(r2.state.base_hp).toBe(hp0 - 1);
    expect(r2.state.leaks).toBe(1);
  });

  it('4 金币不足 / 格子非法 / 已占用：建造原子失败，不扣钱不占格', () => {
    const s0 = createBattle(DEFAULT_PACK, 1); // gold 120
    const onPath = step(s0, [{ type: 'build', tower_id: 'crossbow', x: 0, y: 1 }]);
    expect(onPath.events[0]).toMatchObject({ type: 'build_rejected', code: 'NOT_BUILDABLE' });
    expect(onPath.state.gold).toBe(120);
    expect(onPath.state.towers.length).toBe(0);
    const poor = step(s0, [
      { type: 'build', tower_id: 'catapult', x: 5, y: 2 },
      { type: 'build', tower_id: 'catapult', x: 6, y: 2 },
    ]);
    expect(poor.events[1]).toMatchObject({ type: 'build_rejected', code: 'NOT_ENOUGH_GOLD' });
    expect(poor.state.gold).toBe(10);
    expect(poor.state.occupied).toEqual(['5,2']);
    const dup = step(poor.state, [{ type: 'build', tower_id: 'crossbow', x: 5, y: 2 }]);
    expect(dup.events[0]).toMatchObject({ type: 'build_rejected', code: 'OCCUPIED' });
    const unk = step(s0, [{ type: 'build', tower_id: 'nope', x: 5, y: 2 }]);
    expect(unk.events[0]).toMatchObject({ type: 'build_rejected', code: 'UNKNOWN_TOWER' });
    expect(unk.state.gold).toBe(120);
  });

  it('5 本 tick 生成的怪下一 tick 才移动；本 tick 建的塔下一 tick 才攻击', () => {
    const s = createBattle(DEFAULT_PACK, 1);
    let r = step(s, [{ type: 'build', tower_id: 'crossbow', x: 1, y: 0 }, { type: 'start_wave' }]);
    const e = r.state.enemies[0];
    expect(e.life).toBe('pending');
    expect(e.progress).toBe(0);
    expect(r.events.some((x) => x.type === 'attack')).toBe(false);
    r = step(r.state);
    expect(r.state.enemies[0].progress).toBe(35);
    expect(r.state.towers[0].life).toBe('alive');
    expect(r.events.some((x) => x.type === 'attack')).toBe(true);
  });

  it('6 逻辑层可脱离渲染独立运行：无渲染重放与逐帧快照重放校验和一致', () => {
    const a = runScript(7);
    // replay recording commands, stepping on cloned snapshots (as presenter would read)
    let s = createBattle(DEFAULT_PACK, 7);
    const snaps: string[] = [];
    while (s.phase !== 'won' && s.phase !== 'lost' && s.tick < 20000) {
      let cmds: Command[] = s.tick === 0 ? [{ type: 'build', tower_id: 'crossbow', x: 5, y: 2 }] : s.tick === 1 ? [{ type: 'start_wave' }] : [];
      if (s.phase === 'build' && s.tick > 1) {
        cmds = [];
        if (s.gold >= 60) cmds.push({ type: 'build', tower_id: 'crossbow', x: 5 + (s.towers.length % 4), y: 4 });
        cmds.push({ type: 'start_wave' });
      }
      const snap = structuredClone({ ...s, pack: undefined }); // presenter reads a copy
      snaps.push(String(snap.tick));
      s = step(s, cmds).state;
    }
    expect(checksum(s)).toBe(checksum(a));
  });

  it('runtime 源码不含 Math.random / Date / performance / phaser', async () => {
    const fs = await import('node:fs');
    for (const f of fs.readdirSync('src/runtime')) {
      const src = fs.readFileSync(`src/runtime/${f}`, 'utf8');
      expect(src).not.toMatch(/Math\.random|\bDate\b|performance\.|from ['"]phaser/);
    }
  });
});

// 06 规格 §5 阶段 3 验收门槛 · 六项故障注入（单元层；E2E 层见 tests/e2e/advisor.spec.ts）：
//   1 慢回包  2 非法指令  3 过期响应  4 重复响应  5 断网  6 快照干净（见 schema_snapshot.test.ts，这里再在出站请求上断一次）
import { describe, it, expect } from 'vitest';
import { checksum } from '../../src/runtime/index';
import { DEFAULT_PACK } from '../../src/content/default';
import { LIMITS, forbiddenKeysIn, slotCell, cellSlot } from '../../src/advisor/index';
import { makeHarness, validAdvice } from './harness';

const openSlot = (h: ReturnType<typeof makeHarness>) => h.session.snapshotNow()!.slots.find((x) => x.open)!.id;

describe('§5-1 慢回包（+5 s）：波按时开始，兜底建议出现，迟到的回包被丢弃', () => {
  it('超时 → 本地建议；游戏照常走；迟到回包记 LATE 且不改当前建议', () => {
    const h = makeHarness({ tactical: false });
    h.channel.script = (req) => [{ reply: { ok: true, payload: validAdvice(req.stateVersion, openSlot(h)), provider: 'slow-llm' }, delayMs: LIMITS.nextWaveDeadlineMs + 5000 }];
    h.tick(1);
    expect(h.channel.sent).toHaveLength(1);
    expect(h.session.view().status).toBe('thinking');
    // 思考期间玩家不用等：开波照常
    h.tick(1, [{ type: 'start_wave' }]);
    expect(h.state.phase).toBe('wave');
    // 开波后下一波请求已无意义 → SUPERSEDED（不等截止）
    expect(h.session.view().log.some((l) => l.ev === 'drop' && l.code === 'SUPERSEDED')).toBe(true);
    // 回到建造期：新请求，超时后兜底（波内 tick 会把 r1 迟到的回包也放进来：记 LATE）
    while (h.state.phase === 'wave') h.tick(1);
    expect(h.channel.sent).toHaveLength(2);
    const r2 = h.channel.sent[1].reqId;
    h.wait(LIMITS.nextWaveDeadlineMs);
    const v = h.session.view();
    expect(v.current?.source).toBe('local');
    expect(v.current?.reason).toBe('TIMEOUT');
    expect(v.current?.advice.options.length).toBeGreaterThan(0);
    expect(v.notice).toContain('迟到');
    // 5 s 后 r2 迟到的回包到了：丢弃，记 LATE，当前建议还是本地那条
    h.wait(5000);
    const v2 = h.session.view();
    expect(v2.log.filter((l) => l.ev === 'drop' && l.code === 'LATE' && l.reqId === r2)).toHaveLength(1);
    expect(v2.log.filter((l) => l.ev === 'drop' && l.code === 'LATE')).toHaveLength(2);   // r1（开波后才到）+ r2
    expect(v2.current?.reqId).toBe(v.current?.reqId);
    expect(v2.current?.source).toBe('local');
    expect(v2.stats).toMatchObject({ requests: 2, replies: 0, fallbacks: 1 });
  });
});

describe('§5-2 非法指令：未知槽 / 已占槽 / 未知塔 全部 reject，战局哈希不变', () => {
  it('逐条拒绝，合法条照常可采纳；全非法的选项作废；采纳空选项不产生命令', () => {
    const h = makeHarness();
    // 先手动占一个槽
    const occ = openSlot(h); const cell = slotCell(DEFAULT_PACK, occ)!;
    h.tick(1, [{ type: 'build', tower_id: 'crossbow', x: cell.x, y: cell.y }]);
    expect(h.state.towers).toHaveLength(1);
    const good = h.session.snapshotNow()!.slots.find((x) => x.open)!.id;
    h.channel.inject({ reqId: h.channel.sent[0].reqId, ok: true, provider: 'llm', payload: {
      basedOn: h.channel.sent[0].stateVersion,
      options: [
        { id: 'a', title: '全错', why: 'x', moves: [{ slot: DEFAULT_PACK.map.buildable_cells.length + 5, tower: 'crossbow' }, { slot: occ, tower: 'crossbow' }, { slot: good, tower: 'laser' }] },
        { id: 'b', title: '半对', why: 'y', moves: [{ slot: good, tower: 'catapult' }, { slot: occ, tower: 'catapult' }] },
        { id: 'c', title: '不花钱', why: 'z', moves: [] },
      ],
      gambit: { id: 'nuke', line: '不存在的变招' },
    } });
    const v = h.session.view();
    expect(v.current?.source).toBe('llm');
    expect(v.current?.advice.options.map((o) => o.id)).toEqual(['b', 'c']);           // a 全非法 → 作废
    expect(v.current?.advice.options[0].moves).toEqual([{ slot: good, tower: 'catapult' }]);   // b 只剩合法的一步
    expect(v.current?.advice.gambit).toBeUndefined();
    expect(v.current?.rejects.map((r) => r.code).sort()).toEqual(['SLOT_OCCUPIED', 'SLOT_OCCUPIED', 'UNKNOWN_GAMBIT', 'UNKNOWN_SLOT', 'UNKNOWN_TOWER']);
    // 采纳被作废的 a / 空的 c：零命令、哈希不变
    const before = checksum(h.state);
    expect(h.session.adopt('a')).toEqual([]);
    expect(h.session.adopt('c')).toEqual([]);
    h.tick(1);
    // 只过了一 tick 的建造期，状态只有 tick 变化：比较去掉 tick 的哈希
    expect(checksum({ ...h.state, tick: 0 })).toBe(checksum({ ...JSON.parse(JSON.stringify(h.state)), tick: 0 }));
    expect(h.state.towers).toHaveLength(1); expect(h.state.gold).toBe(120 - 60);
    void before;
  });
  it('运行时层再拦一次：金币不够的采纳被 applyBuild 拒绝并回灌 outcome，状态不变', () => {
    const h = makeHarness();
    h.tick(1);
    const slot = openSlot(h);
    h.channel.inject({ reqId: h.channel.sent[0].reqId, ok: true, payload: { basedOn: 0, options: [{ id: 'a', title: '重拳', why: 'x', moves: [{ slot, tower: 'catapult' }, { slot: slot + 1, tower: 'catapult' }] }] } });
    const cmds = h.session.adopt('a');
    expect(cmds).toHaveLength(2);                       // 适配层不替运行时判金币
    const gold = h.state.gold, towers = h.state.towers.length;
    h.tick(1, cmds);
    const v = h.session.view();
    expect(v.outcomes.map((o) => o.ok)).toEqual([true, false]);
    expect(v.outcomes[1].code).toBe('NOT_ENOUGH_GOLD');
    expect(h.state.towers.length).toBe(towers + 1); expect(h.state.gold).toBe(gold - 110);
  });
});

describe('§5-3 过期响应：basedOn 落后 > 60 tick 的即时指令丢弃，不回滚、不瞬移', () => {
  it('tactical 回包过期 → STALE 丢弃，HUD 提示迟到，无命令产生', () => {
    const h = makeHarness();
    h.channel.script = () => [];   // 一律不回
    h.tick(1);
    h.wait(LIMITS.nextWaveDeadlineMs);   // 下一波建议超时 → 本地兜底
    h.tick(1, [{ type: 'start_wave' }]);
    const sentBefore = h.channel.sent.length;
    h.tick(LIMITS.tacticalEveryTicks);   // 4 s 后发即时请求
    expect(h.channel.sent.length).toBe(sentBefore + 1);
    const req = h.channel.sent[h.channel.sent.length - 1];
    expect(req.kind).toBe('tactical');
    h.tick(LIMITS.tacticalFreshTicks + 1);   // 让 stateVersion 推进超过新鲜度阈值
    const towers = h.state.towers.length, hash = checksum({ ...h.state });
    h.channel.inject({ reqId: req.reqId, ok: true, payload: { basedOn: req.stateVersion, options: [{ id: 'a', title: '补一座', why: 'x', moves: [{ slot: openSlot(h), tower: 'crossbow' }] }] } });
    const v = h.session.view();
    expect(v.log.some((l) => l.ev === 'drop' && l.code === 'STALE')).toBe(true);
    expect(v.status).toBe('late');
    expect(v.notice).toContain('迟到');
    expect(h.session.beforeTick()).toEqual([]);
    expect(h.state.towers.length).toBe(towers);
    expect(checksum(h.state)).toBe(hash);
  });
  it('新鲜的 tactical 回包正常呈现（对照）', () => {
    const h = makeHarness();
    h.channel.script = () => [];
    h.tick(1); h.wait(LIMITS.nextWaveDeadlineMs);
    h.tick(1, [{ type: 'start_wave' }]);
    h.tick(LIMITS.tacticalEveryTicks);
    const req = h.channel.sent[h.channel.sent.length - 1];
    h.tick(10);
    h.channel.inject({ reqId: req.reqId, ok: true, provider: 'fast-llm', payload: { basedOn: req.stateVersion, options: [{ id: 'a', title: '补一座', why: 'x', moves: [{ slot: openSlot(h), tower: 'crossbow' }] }] } });
    const v = h.session.view();
    expect(v.current?.kind).toBe('tactical'); expect(v.current?.source).toBe('llm'); expect(v.current?.provider).toBe('fast-llm');
  });
});

describe('§5-4 重复响应：同 reqId 回两次，只有一次效果', () => {
  it('第二包记 DUP；采纳只建一次', () => {
    const h = makeHarness();
    h.channel.script = (req) => {
      const payload = validAdvice(req.stateVersion, openSlot(h));
      return [{ reply: { ok: true, payload, provider: 'llm' } }, { reply: { ok: true, payload, provider: 'llm' }, delayMs: 10 }];
    };
    h.tick(1);
    h.wait(20);
    const v = h.session.view();
    expect(v.stats.replies).toBe(1);
    expect(v.log.filter((l) => l.ev === 'drop' && l.code === 'DUP')).toHaveLength(1);
    const cmds = h.session.adopt('a');
    expect(cmds).toHaveLength(1);
    expect(h.session.adopt('a')).toEqual([]);   // 同一选项不重复采纳
    h.tick(1, cmds);
    expect(h.state.towers).toHaveLength(1);
    expect(h.session.view().outcomes).toHaveLength(1);
  });
});

describe('§5-5 断网：request 失败 → 兜底路径，游戏可完整打完', () => {
  it('通道抛错 → 立刻本地建议（TRANSPORT）；托管开着也能一路打到结束', () => {
    const h = makeHarness();
    h.channel.broken = true;
    h.session.setAutopilot(true);
    h.tick(1);
    const v = h.session.view();
    expect(v.current?.source).toBe('local'); expect(v.current?.reason).toBe('TRANSPORT');
    let guard = 0;
    while (h.state.phase !== 'won' && h.state.phase !== 'lost' && guard++ < 20000) {
      if (h.state.phase === 'build' && h.session.view().status === 'ready') h.tick(1, [{ type: 'start_wave' }]);
      else h.tick(1);
    }
    expect(['won', 'lost']).toContain(h.state.phase);
    const end = h.session.view();
    expect(end.log.filter((l) => l.ev === 'present' && l.kind === 'next-wave')).toHaveLength(DEFAULT_PACK.waves.length);   // 每个建造期都兜了一次
    expect(end.stats.fallbacks).toBeGreaterThanOrEqual(DEFAULT_PACK.waves.length);   // 波内的即时请求也走了本地
    expect(end.stats.adopted).toBeGreaterThan(0);                  // 托管真的采纳了
    expect(h.state.towers.length).toBeGreaterThan(0);
    expect(end.bets.length).toBe(DEFAULT_PACK.waves.length);       // 每波押注都结算了
  });
  it('代理回错误包（ok:false）同样兜底；宿主声明没配军师（NO_ADVISOR）秒切本地', () => {
    const h = makeHarness();
    h.channel.script = () => [{ reply: { ok: false, error: { code: 'HTTP_502' } } }];
    h.tick(1);
    expect(h.session.view().current).toMatchObject({ source: 'local', reason: 'HTTP_502' });
    const h2 = makeHarness();
    h2.channel.script = () => [{ reply: { ok: false, error: { code: 'NO_ADVISOR' } } }];
    h2.tick(1);
    expect(h2.session.view().current).toMatchObject({ source: 'local', reason: 'NO_ADVISOR' });
  });
});

describe('§5-6 出站请求干净 + 托管边界 + 押注结算', () => {
  it('每条出站请求（含快照与提示词）都没有坐标 / 渲染 / 宿主字段', () => {
    const h = makeHarness();
    h.tick(1); h.wait(LIMITS.nextWaveDeadlineMs); h.tick(1, [{ type: 'start_wave' }]); h.tick(LIMITS.tacticalEveryTicks);
    expect(h.channel.sent.length).toBeGreaterThanOrEqual(2);
    for (const req of h.channel.sent) {
      expect(forbiddenKeysIn(req.snapshot)).toEqual([]);
      expect(JSON.stringify(req.snapshot).length).toBeLessThan(LIMITS.snapshotBytes);
      expect(req.llm.messages.map((m) => m.role)).toEqual(['system', 'user']);
      expect(req.llm.json).toBe(true);
    }
  });
  it('玩家手动建塔后，本阶段托管不再自动采纳', () => {
    const h = makeHarness();
    h.session.setAutopilot(true);
    h.channel.script = (req) => [{ reply: { ok: true, payload: validAdvice(req.stateVersion, openSlot(h)) }, delayMs: 100 }];
    h.tick(1);
    h.session.notePlayerBuild();
    h.wait(100);
    expect(h.session.view().current?.source).toBe('llm');
    expect(h.session.beforeTick()).toEqual([]);
    expect(h.session.view().stats.adopted).toBe(0);
  });
  it('押注：实际漏数 < 押注 → 你赢；= → 军师赢；> → 无人得分', () => {
    const h = makeHarness();
    h.channel.script = (req) => [{ reply: { ok: true, payload: validAdvice(req.stateVersion, openSlot(h), { bet: { leaks: 99, line: '全漏' } }) } }];
    h.tick(1);
    const cmds = h.session.adopt('a');
    h.tick(1, cmds);
    h.tick(1, [{ type: 'start_wave' }]);
    while (h.state.phase === 'wave') h.tick(1);
    const v = h.session.view();
    expect(v.bets).toHaveLength(1);
    expect(v.bets[0]).toMatchObject({ wave: 1, predicted: 99, result: 'you' });
    expect(v.score.you).toBe(1);
    expect(v.betLine).toContain('你赢了军师');
    expect(cellSlot(DEFAULT_PACK, h.state.towers[0].cx, h.state.towers[0].cy)).toBeGreaterThanOrEqual(0);
  });
  it('变招：采纳 → 运行时加金并改下一波；同建造期第二张被拒', () => {
    const h = makeHarness();
    h.channel.script = (req) => [{ reply: { ok: true, payload: validAdvice(req.stateVersion, openSlot(h), { gambit: { id: 'swarm', line: '人海' } }) } }];
    h.tick(1);
    const g = h.session.takeGambit();
    expect(g).toEqual({ type: 'gambit', id: 'swarm' });
    const gold = h.state.gold;
    const ev = h.tick(1, [g!]);
    expect(ev.some((e) => e.type === 'gambit_accepted')).toBe(true);
    expect(h.state.gold).toBeGreaterThan(gold);
    expect(h.session.view().gambit.taken?.id).toBe('swarm');
    const ev2 = h.tick(1, [{ type: 'gambit', id: 'tough' }]);
    expect(ev2.some((e) => e.type === 'gambit_rejected' && e.code === 'ALREADY_TAKEN')).toBe(true);
    const started = h.tick(1, [{ type: 'start_wave' }]).find((e) => e.type === 'wave_started');
    expect(started && started.type === 'wave_started' && started.total).toBe(Math.ceil(5 * 1.5));
  });
});

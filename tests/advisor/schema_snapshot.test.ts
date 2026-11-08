// 结构化校验（06 §3「禁止自由文本当指令」）与极简快照（06 §5-6「快照不含任何坐标 / 渲染 / 宿主用户字段」）。
import { describe, it, expect } from 'vitest';
import { createBattle, step } from '../../src/runtime/index';
import { DEFAULT_PACK } from '../../src/content/default';
import { buildSnapshot, forbiddenKeysIn, parseAdvice, LIMITS, advicePrompt, cellSlot, slotCell, reachTable, snapshotSlots } from '../../src/advisor/index';

describe('AdviceSchema · 结构化回包', () => {
  const base = { basedOn: 12, options: [{ id: 'a', title: '稳守', why: '便宜', moves: [{ slot: 3, tower: 'crossbow' }] }] };
  it('合法回包通过；未知键剥掉而不是整包作废', () => {
    const r = parseAdvice({ ...base, extra: 'ignored', options: [{ ...base.options[0], note: 'x' }] });
    expect(r.ok).toBe(true);
    if (r.ok) { expect((r.advice as any).extra).toBeUndefined(); expect((r.advice.options[0] as any).note).toBeUndefined(); }
  });
  it('自由文本 / 缺 basedOn / 空 options / 超长字段 / 非整数槽位 一律 BAD_SHAPE', () => {
    for (const bad of [
      '把弩车放在左上角',
      { options: base.options },
      { basedOn: 1, options: [] },
      { basedOn: 1, options: [{ id: 'a', title: 'x'.repeat(LIMITS.titleLen + 1), why: 'y', moves: [] }] },
      { basedOn: 1, options: [{ id: 'a', title: 't', why: 'y', moves: [{ slot: 1.5, tower: 'crossbow' }] }] },
      { basedOn: 1, options: [{ id: 'd', title: 't', why: 'y', moves: [] }] },
      { basedOn: 1, options: [{ id: 'a', title: 't', why: 'y', moves: new Array(LIMITS.movesPerOption + 1).fill({ slot: 1, tower: 'crossbow' }) }] },
      { basedOn: 1, options: new Array(LIMITS.options + 1).fill(base.options[0]) },
    ]) {
      const r = parseAdvice(bad);
      expect(r.ok, JSON.stringify(bad).slice(0, 80)).toBe(false);
      if (!r.ok) expect(r.code).toBe('BAD_SHAPE');
    }
  });
  it('bet / gambit / say 可选，但给了就按形状卡', () => {
    expect(parseAdvice({ ...base, bet: { leaks: 2, line: '漏两只' } }).ok).toBe(true);
    expect(parseAdvice({ ...base, bet: { leaks: -1, line: 'x' } }).ok).toBe(false);
    expect(parseAdvice({ ...base, gambit: { id: 'swarm', line: '人海' } }).ok).toBe(true);
    expect(parseAdvice({ ...base, say: 'x'.repeat(LIMITS.sayLen + 1) }).ok).toBe(false);
  });
});

describe('Snapshot · 极简决策快照', () => {
  const s0 = createBattle(DEFAULT_PACK, 1);
  it('不含任何坐标 / 渲染 / 宿主字段（递归断言），整条出站请求与提示词里的快照同样干净', () => {
    const snap = buildSnapshot(s0);
    expect(forbiddenKeysIn(snap)).toEqual([]);
    const prompt = advicePrompt('next-wave', snap, 'zh');
    const embedded = JSON.parse(prompt.messages[1].content.split('snapshot:\n')[1]);
    expect(forbiddenKeysIn(embedded)).toEqual([]);
    expect(embedded.stateVersion).toBe(snap.stateVersion);
    // 反向验证：断言器本身认得出坐标
    expect(forbiddenKeysIn({ a: [{ x: 1, y: 2 }], color: 'red' })).toEqual(['$.a[0].x', '$.a[0].y', '$.color']);
  });
  it('槽位 = buildable_cells 下标；空槽只送覆盖最好的前 N 个，已占槽全送；大小有界', () => {
    const snap = buildSnapshot(s0);
    expect(snap.slots.length).toBeLessThanOrEqual(LIMITS.slotsInSnapshot);
    expect(snap.slots.every((x) => x.open)).toBe(true);
    const reach = reachTable(DEFAULT_PACK);
    const best = Math.max(...Object.values(reach).map((r) => Math.max(...Object.values(r))));
    expect(Math.max(...snap.slots[0].reach && Object.values(snap.slots[0].reach))).toBe(best);
    // 放一座塔后：已占槽出现在最前，open=false
    const slot = snap.slots[0].id, cell = slotCell(DEFAULT_PACK, slot)!;
    const s1 = step(s0, [{ type: 'build', tower_id: 'crossbow', x: cell.x, y: cell.y }]).state;
    const snap1 = buildSnapshot(s1);
    expect(snap1.slots[0]).toMatchObject({ id: slot, open: false, tower: 'crossbow' });
    expect(snap1.slots.filter((x) => x.open).length).toBeLessThanOrEqual(LIMITS.slotsInSnapshot);
    expect(cellSlot(DEFAULT_PACK, cell.x, cell.y)).toBe(slot);
    expect(JSON.stringify(snap1).length).toBeLessThan(LIMITS.snapshotBytes);
    expect(snapshotSlots(s1, 3).filter((x) => x.open)).toHaveLength(3);
  });
  it('阶段 / 波次 / 变招 offers 随状态走', () => {
    const b = buildSnapshot(s0);
    expect(b.phase).toBe('build'); expect(b.wave.index).toBe(0); expect(b.wave.next).toEqual([{ type: 'footman', n: 5 }]); expect(b.wave.now).toBeNull();
    expect(b.gambit.offers.map((o) => o.id).sort()).toEqual(['swarm', 'tight', 'tough']);
    const w = step(s0, [{ type: 'start_wave' }]).state;
    const ws = buildSnapshot(w);
    expect(ws.phase).toBe('wave'); expect(ws.wave.now).toEqual([{ type: 'footman', n: 5 }]); expect(ws.gambit.offers).toEqual([]);
    const g = step(s0, [{ type: 'gambit', id: 'swarm' }]).state;
    expect(buildSnapshot(g).gambit).toMatchObject({ taken: 'swarm', offers: [] });
  });
});

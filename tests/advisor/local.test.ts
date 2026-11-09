// 本地模板军师：确定性、选项真有取舍、押注来自预演、步子全部合法。
import { describe, it, expect } from 'vitest';
import { createBattle, step } from '../../src/runtime/index';
import { DEFAULT_PACK } from '../../src/content/default';
import { adviseLocal, buildSnapshot, parseAdvice, simulateWave, slotCell } from '../../src/advisor/index';

describe('LocalTemplateAdvisor', () => {
  const s0 = createBattle(DEFAULT_PACK, 3);
  it('同一状态两次建议完全一致，且通过自己的 schema', () => {
    const a = adviseLocal('next-wave', buildSnapshot(s0), s0), b = adviseLocal('next-wave', buildSnapshot(s0), s0);
    expect(a).toEqual(b);
    expect(parseAdvice(a).ok).toBe(true);
  });
  it('下一波建议：2–3 条、步子互不相同、至少一条不花钱；每步槽位与塔都合法', () => {
    const adv = adviseLocal('next-wave', buildSnapshot(s0), s0);
    expect(adv.options.length).toBeGreaterThanOrEqual(2);
    expect(adv.options.some((o) => o.moves.length === 0)).toBe(true);
    const keys = adv.options.map((o) => o.moves.map((m) => `${m.slot}:${m.tower}`).sort().join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    for (const o of adv.options) for (const m of o.moves) {
      expect(slotCell(DEFAULT_PACK, m.slot)).not.toBeNull();
      expect(DEFAULT_PACK.towers.some((t) => t.id === m.tower)).toBe(true);
    }
    // 选项 a 的总花费不超过手里的金币
    const cost = adv.options[0].moves.reduce((a, m) => a + (DEFAULT_PACK.towers.find((t) => t.id === m.tower)?.cost ?? 0), 0);
    expect(cost).toBeLessThanOrEqual(s0.gold);
  });
  it('押注 = 按选项 a 预演这一波的漏数；预演本身确定且不改原状态', () => {
    const adv = adviseLocal('next-wave', buildSnapshot(s0), s0);
    const sim = simulateWave(s0, adv.options[0].moves);
    expect(adv.bet).toBeDefined();
    expect(adv.bet!.leaks).toBe(sim.leaks);
    expect(simulateWave(s0, adv.options[0].moves)).toEqual(sim);
    expect(s0.tick).toBe(0); expect(s0.towers).toHaveLength(0);
    // 不放塔预演一定比放两座弩车漏得多（或相等）
    expect(simulateWave(s0, []).leaks).toBeGreaterThanOrEqual(sim.leaks);
  });
  it('第 2 波起才提变招，且 id 来自 offers', () => {
    expect(adviseLocal('next-wave', buildSnapshot(s0), s0).gambit).toBeUndefined();
    let s = step(s0, [{ type: 'start_wave' }]).state;
    while (s.phase === 'wave') s = step(s).state;
    const snap = buildSnapshot(s);
    const adv = adviseLocal('next-wave', snap, s);
    expect(adv.gambit).toBeDefined();
    expect(snap.gambit.offers.map((o) => o.id)).toContain(adv.gambit!.id);
  });
  it('即时建议：一条、至多一步；金币不够时建议先别动', () => {
    const w = step(s0, [{ type: 'start_wave' }]).state;
    const adv = adviseLocal('tactical', buildSnapshot(w), w);
    expect(adv.options).toHaveLength(1);
    expect(adv.options[0].moves.length).toBeLessThanOrEqual(1);
    expect(adv.bet).toBeUndefined();
    const poor = { ...w, gold: 0 };
    expect(adviseLocal('tactical', buildSnapshot(poor), poor).options[0].moves).toEqual([]);
  });
  it('英文快照 → 英文文案', () => {
    const adv = adviseLocal('next-wave', buildSnapshot(s0, { lang: 'en' }), s0, 'en');
    expect(adv.options[0].title).toMatch(/^[A-Za-z ]+$/);
  });
});

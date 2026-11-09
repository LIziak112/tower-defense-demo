// 本地模板军师（超时 / 断网 / 无代理时的兜底，也是独立打开时的默认军师）。确定性：同一状态同一建议；不读时钟、不读随机数。
// 给的是「有趣的取舍」而不是唯一最优解（冯诺依曼 #24353）：稳守 / 重拳 / 攒一手 三条路，各有收益与风险；押注按选项 a 预演得出。
import type { BattleState, Command } from '../runtime/types';
import { step } from '../runtime/sim';
import { GAMBITS, GAMBIT_IDS } from '../runtime/gambit';
import { allSlots, slotCell } from './snapshot';
import type { Advice, AdviceKind, AdviceMove, AdviceOption, Snapshot } from './types';

export const LOCAL_ADVISOR_NAME = { zh: '本地模板军师', en: 'Local template advisor' } as const;

const SAY = {
  zh: ['先稳住基地，再谈花活。', '敌人走的路是固定的，塔不是。', '省下的金币也是战斗力。', '我押一注，你来打脸。', '别贪，漏一只不致命，漏一波才是。', '守住拐角，守住全局。'],
  en: ['Hold the base first, flourish later.', 'Their road is fixed; your towers are not.', 'Gold unspent is firepower saved.', 'I will bet; you prove me wrong.', 'Leaking one is fine, leaking a wave is not.', 'Own the corners, own the map.'],
} as const;

/** 预演：在当前状态上落下 moves（一 tick 内）、开波、打到波结束；返回这一波漏了几只（含落塔失败也照常算） */
export function simulateWave(state: BattleState, moves: AdviceMove[], maxTicks = 6000): { leaks: number; result: 'cleared' | 'lost' | 'timeout' } {
  if (state.phase !== 'build' || state.wave_index >= state.pack.waves.length) return { leaks: 0, result: 'timeout' };
  const cmds: Command[] = [];
  for (const m of moves) { const c = slotCell(state.pack, m.slot); if (c) cmds.push({ type: 'build', tower_id: m.tower, x: c.x, y: c.y }); }
  cmds.push({ type: 'start_wave' });
  let s = step(state, cmds).state;
  const leaks0 = state.leaks;
  const stop = s.tick + maxTicks;
  while (s.phase === 'wave' && s.tick < stop) s = step(s).state;
  return { leaks: s.leaks - leaks0, result: s.phase === 'lost' ? 'lost' : s.phase === 'wave' ? 'timeout' : 'cleared' };
}

interface Plan { title: string; why: string; risk?: string; moves: AdviceMove[] }

const dps = (t: Snapshot['towers'][number]) => t.dmg / Math.max(0.1, t.every);

function plans(snap: Snapshot, state: BattleState, lang: 'zh' | 'en'): Plan[] {
  const zh = lang === 'zh';
  const towers = [...snap.towers].sort((a, b) => a.cost - b.cost);
  const cheapest = towers[0];
  const open = allSlots(state).filter((x) => x.open);
  const bestFor = (towerId: string, skip: Set<number>) => open.filter((x) => !skip.has(x.id)).sort((a, b) => (b.reach[towerId] ?? 0) - (a.reach[towerId] ?? 0) || a.id - b.id)[0];
  const out: Plan[] = [];
  const nextReward = (snap.wave.next ?? []).reduce((a, g) => a + g.n * (snap.enemies.find((e) => e.id === g.type)?.reward ?? 0), 0);

  // a 稳守：最便宜的塔放覆盖最好的槽，钱够就再来一座
  if (cheapest && snap.gold >= cheapest.cost && open.length) {
    const moves: AdviceMove[] = []; const used = new Set<number>(); let gold = snap.gold;
    while (gold >= cheapest.cost && moves.length < 2) { const s = bestFor(cheapest.id, used); if (!s) break; moves.push({ slot: s.id, tower: cheapest.id }); used.add(s.id); gold -= cheapest.cost; }
    const cover = moves.map((m) => open.find((x) => x.id === m.slot)?.reach[cheapest.id] ?? 0).reduce((a, b) => a + b, 0);
    out.push({
      title: zh ? '稳守' : 'Steady', moves,
      why: zh ? `用 ${moves.length} 座${cheapest.name}守拐角，合计 ${cover} 格射界（含重叠）。` : `${moves.length} ${cheapest.name}(s) cover ${cover} path cells in total, counting overlap.`,
      risk: zh ? '火力平均，后面厚血敌人可能顶不住。' : 'Even firepower; tanky waves later may push through.',
    });
  }
  // b 重拳：用更高的单发伤害换取更少的落点。
  const heavy = snap.towers.filter((t) => t.id !== cheapest?.id && t.cost <= snap.gold).sort((a, b) => b.dmg - a.dmg || b.cost - a.cost)[0];
  if (heavy && cheapest && heavy.id !== cheapest.id && open.length) {
    const s = bestFor(heavy.id, new Set());
    if (s) out.push({
      title: zh ? '重拳' : 'Heavy hand', moves: [{ slot: s.id, tower: heavy.id }],
      why: zh ? `${heavy.name}单发 ${heavy.dmg} 伤害，守住 ${s.reach[heavy.id]} 格来路。` : `${heavy.name}: ${heavy.dmg} damage per hit, covering ${s.reach[heavy.id]} path cells.`,
      risk: zh ? `出手慢（${heavy.every}s 一发），人海波会被漏过去。` : `Slow (${heavy.every}s per shot); swarms will slip past.`,
    });
  }
  // c 攒一手：这波不花钱（或只补一座），把赏金攒给下一波
  const nextNext = snap.wave.index + 1 < snap.wave.total;
  out.push({
    title: zh ? '攒一手' : 'Save up', moves: [],
    why: zh
      ? (nextNext ? `保留金币用于下波。全歼本波最多得 ${nextReward} 金赏金。` : '靠现有阵地打完最后一波。')
      : (nextNext ? `Save for the next wave. Defeating every enemy pays ${nextReward} gold.` : 'Hold the last wave with the current defenses.'),
    risk: zh ? `现在不补塔，这波可能多漏几只（基地 ${snap.base.hp}/${snap.base.max}）。` : `No new towers now: more may leak (base ${snap.base.hp}/${snap.base.max}).`,
  });
  // 去重（同一组 moves 只留一条），最多 3 条
  const seen = new Set<string>();
  return out.filter((p) => { const k = p.moves.map((m) => `${m.slot}:${m.tower}`).sort().join('|'); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 3);
}

function tactical(snap: Snapshot, state: BattleState, lang: 'zh' | 'en'): Plan[] {
  const zh = lang === 'zh';
  const affordable = [...snap.towers].filter((t) => t.cost <= snap.gold).sort((a, b) => dps(b) - dps(a))[0];
  const open = allSlots(state).filter((x) => x.open);
  if (!affordable || !open.length) {
    return [{ title: zh ? '先别动' : 'Hold', moves: [], why: zh ? `金币 ${snap.gold}，还买不起塔；等赏金。` : `Gold ${snap.gold}: nothing affordable yet; wait for bounties.` }];
  }
  const s = open.sort((a, b) => (b.reach[affordable.id] ?? 0) - (a.reach[affordable.id] ?? 0) || a.id - b.id)[0];
  const front = Math.max(0, ...Object.values(snap.field).map((f) => f.front));
  return [{
    title: zh ? '补一座' : 'Plug one', moves: [{ slot: s.id, tower: affordable.id }],
    why: zh ? `最前的敌人已走到 ${Math.round(front * 100)}%，${affordable.name}落在覆盖 ${s.reach[affordable.id]} 格的槽上还来得及。` : `Front enemy at ${Math.round(front * 100)}%; a ${affordable.name} on a ${s.reach[affordable.id]}-cell slot still makes it.`,
    risk: zh ? '花光金币，下波开局会紧。' : 'Spends your gold; next wave starts tight.',
  }];
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** 本地建议；kind=level 不在这里（关卡设计走 ai/mock.ts 的 MockProvider） */
export function adviseLocal(kind: Exclude<AdviceKind, 'level'>, snap: Snapshot, state: BattleState, lang: 'zh' | 'en' = 'zh'): Advice {
  const ps = kind === 'tactical' ? tactical(snap, state, lang) : plans(snap, state, lang);
  const ids = ['a', 'b', 'c'] as const;
  const canSimulate = kind === 'next-wave' && snap.phase === 'build' && snap.wave.index < snap.wave.total;
  const forecasts = canSimulate ? ps.map((p) => simulateWave(state, p.moves)) : [];
  const options: AdviceOption[] = ps.map((p, i) => {
    const forecast = forecasts[i];
    const result = forecast?.result === 'lost' ? (lang === 'zh' ? '预演：基地失守。' : 'Forecast: base falls. ')
      : forecast?.result === 'cleared' ? (lang === 'zh' ? `预演：漏 ${forecast.leaks} 只。` : `Forecast: ${forecast.leaks} leaks. `) : '';
    return { id: ids[i], title: clip(p.title, 12), why: clip(result + p.why, 80), risk: p.risk ? clip(p.risk, 60) : undefined, moves: p.moves };
  });
  const advice: Advice = { v: 1, basedOn: snap.stateVersion, options, say: SAY[lang][snap.wave.index % SAY[lang].length] };
  if (kind === 'next-wave' && snap.phase === 'build' && snap.wave.index < snap.wave.total) {
    const sim = forecasts[0];
    if (sim.result === 'cleared') {
      const n = sim.leaks;
      advice.bet = { leaks: n, line: lang === 'zh' ? `按 A 布防，押这波漏 ${n} 只。` : `With plan A, I wager ${n} leaks.` };
    }
    if (snap.gambit.offers.length && snap.gambit.taken === null && snap.wave.index >= 1) {
      const id = GAMBIT_IDS[snap.wave.index % GAMBIT_IDS.length];
      const g = GAMBITS[id];
      const bonus = snap.gambit.offers.find((o) => o.id === id)?.bonus ?? 0;
      advice.gambit = { id, line: lang === 'zh' ? `${g.name[lang]}：${g.line[lang]}，现在 +${bonus} 金。` : `${g.name[lang]}: ${g.line[lang]}, +${bonus} gold now.` };
    }
  }
  return advice;
}

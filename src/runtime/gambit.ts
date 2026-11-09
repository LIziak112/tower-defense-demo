// 变招规则表（军师玩法增强 ②「波间变招卡」）。零依赖、纯数据 + 两个纯函数；真正的状态改动在 sim.ts 的 applyGambit / scheduleWave 里。
// 设计口径：每张变招都是「下一波更难 ⇄ 现在拿一笔金币」的真实取舍，不接无罚；每个建造期至多一张。
import type { ContentPack, GambitId } from './types';

export interface GambitDef {
  id: GambitId;
  name: { zh: string; en: string };
  /** 下一波的改法（只改一项，便于玩家一眼看懂代价） */
  count_mul: number;      // 敌人数量倍率（向上取整）
  interval_mul: number;   // 出兵间隔倍率（至少 1 tick）
  hp_mul: number;         // 敌人血量倍率（出生时向上取整）
  /** 即时金币 = round(bonus_ratio × 下一波全部赏金) */
  bonus_ratio: number;
  line: { zh: string; en: string };
}

export const GAMBITS: Record<GambitId, GambitDef> = {
  swarm: { id: 'swarm', name: { zh: '人海', en: 'Swarm' }, count_mul: 1.5, interval_mul: 1, hp_mul: 1, bonus_ratio: 0.6, line: { zh: '下一波敌人数量 +50%', en: 'Next wave: +50% enemies' } },
  tight: { id: 'tight', name: { zh: '急行军', en: 'Rush' }, count_mul: 1, interval_mul: 0.5, hp_mul: 1, bonus_ratio: 0.4, line: { zh: '下一波敌人出得快一倍', en: 'Next wave: spawns twice as fast' } },
  tough: { id: 'tough', name: { zh: '铁甲', en: 'Ironclad' }, count_mul: 1, interval_mul: 1, hp_mul: 1.4, bonus_ratio: 0.5, line: { zh: '下一波敌人血量 +40%', en: 'Next wave: +40% enemy HP' } },
};

export const GAMBIT_IDS = Object.keys(GAMBITS) as GambitId[];
export const isGambitId = (v: unknown): v is GambitId => typeof v === 'string' && v in GAMBITS;

/** 某一波（wave_index，从 0 起）按原始内容包算的全部赏金 */
export function waveReward(pack: ContentPack, waveIndex: number): number {
  const w = pack.waves[waveIndex];
  if (!w) return 0;
  return w.groups.reduce((a, g) => a + g.count * (pack.enemies.find((e) => e.id === g.enemy_id)?.reward ?? 0), 0);
}

/** 接下这张变招现在能拿的金币；波次不存在时为 0 */
export function gambitBonus(pack: ContentPack, waveIndex: number, id: GambitId): number {
  return Math.round(waveReward(pack, waveIndex) * GAMBITS[id].bonus_ratio);
}

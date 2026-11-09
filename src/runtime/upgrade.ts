import { type EventSink } from './combatEvents';
import rules from '../content/combat-rules.json';
import type { BattleState, Command, TowerDef } from './types';

export const MAX_TOWER_LEVEL = rules.legacyLevels.length;

export function maxTowerLevel(def: TowerDef) {
  return def.levels ? def.levels.length + 1 : MAX_TOWER_LEVEL;
}

export function towerStats(def: TowerDef, level = 1, branch?: string) {
  const branchStats = branch && def.branch_upgrades?.find((upgrade) => upgrade.id === branch);
  if (branchStats) return { ...def, ...branchStats.level, upgradeCost: null };
  if (def.levels) {
    return { ...def, ...def.levels[level - 2], upgradeCost: def.levels[level - 1]?.upgrade_cost ?? null };
  }
  const rule = rules.legacyLevels[level - 1];
  return {
    ...def,
    damage: Math.round(def.damage * rule.damage / 100),
    range: Math.round(def.range * rule.range / 100),
    upgradeCost: rule.nextCost === null ? null : Math.max(1, Math.ceil(def.cost * rule.nextCost / 100)),
  };
}

export function applyUpgrade(s: BattleState, c: Extract<Command, { type: 'upgrade' }>, ev: EventSink) {
  const { iid, fromLevel, branch } = c;
  if (s.phase !== 'build' && !c.tactical) { ev.push({ type: 'upgrade_rejected', code: 'WAVE_ACTIVE' }); return; }
  const tower = s.towers.find((t) => t.iid === iid);
  const def = s.pack.towers.find((t) => t.id === tower?.def);
  if (!tower || !def) { ev.push({ type: 'upgrade_rejected', code: 'UNKNOWN_TOWER' }); return; }
  const level = tower.level ?? 1;
  if (level !== fromLevel) { ev.push({ type: 'upgrade_rejected', code: 'STALE_LEVEL' }); return; }
  const option = def.branch_upgrades?.find((item) => item.id === branch);
  if (branch !== undefined && (!option || level !== maxTowerLevel(def))) {
    ev.push({ type: 'upgrade_rejected', code: 'UNKNOWN_BRANCH' }); return;
  }
  const cost = option?.level.upgrade_cost ?? towerStats(def, level, tower.branch).upgradeCost;
  if (tower.branch || cost === null) { ev.push({ type: 'upgrade_rejected', code: 'MAX_LEVEL' }); return; }
  if (s.gold < cost) { ev.push({ type: 'upgrade_rejected', code: 'NOT_ENOUGH_GOLD' }); return; }
  tower.level = level + 1;
  tower.branch = branch;
  s.gold -= cost;
  ev.push({ type: 'upgrade_ok', iid, level: tower.level, cost });
}

import { type EventSink } from './combatEvents';
import { TARGET_MODES, type BattleState, type Command, type EnemyInst, type GameEvent, type TargetMode, type TowerInst } from './types';

export function setTargeting(state: BattleState, command: Extract<Command, { type: 'targeting' }>, events: EventSink) {
  const tower = state.towers.find((item) => item.iid === command.iid);
  if (!tower || !TARGET_MODES.includes(command.mode) || tower.targeting === command.mode) return;
  tower.targeting = command.mode;
  events.push({ type: 'targeting_changed', iid: tower.iid, mode: command.mode });
}

export function pickTarget(tower: TowerInst, enemies: EnemyInst[], range: number, mode: TargetMode) {
  const limit = range * range;
  let best: EnemyInst | undefined;
  let bestScore = -Infinity;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    if (enemy.life !== 'alive') continue;
    const dx = enemy.x - tower.x, dy = enemy.y - tower.y;
    const distance = dx * dx + dy * dy;
    if (distance > limit) continue;
    const score = mode === 'nearest' ? -distance : mode === 'highest_hp' ? enemy.hp :
      mode === 'last_on_path' ? -enemy.progress : enemy.progress;
    if (score > bestScore || (score === bestScore && best && enemy.iid < best.iid)) {
      best = enemy;
      bestScore = score;
    }
  }
  return best;
}

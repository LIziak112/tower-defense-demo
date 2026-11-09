import type { BattleState } from '../runtime';
import { createTween } from './motion';

export function nearBreach(state: BattleState) {
  if (state.phase !== 'wave') return false;
  const threshold = state.path_len * 0.85;
  for (let i = 0; i < state.enemies.length; i++) {
    const enemy = state.enemies[i];
    if (enemy.life === 'alive' && enemy.progress >= threshold) return true;
  }
  return false;
}

export function createBoardStatus() {
  const pause = createTween(150), warning = createTween(180);
  return (ctx: CanvasRenderingContext2D, now: number, paused: boolean, danger: boolean, animate: boolean) => {
    const dim = pause(paused ? 1 : 0, now, animate);
    const edge = warning(danger ? 1 : 0, now, animate);
    if (!dim && !edge) return;
    const { width, height } = ctx.canvas;
    ctx.save();
    if (dim) {
      ctx.globalAlpha = dim * 0.15;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = dim * 0.62;
      ctx.strokeStyle = '#a6ded5';
      ctx.lineWidth = 2;
      ctx.strokeRect(2, 2, width - 4, height - 4);
    }
    if (edge) {
      ctx.strokeStyle = '#fb665b';
      for (let i = 0; i < 6; i++) {
        ctx.lineWidth = 2;
        ctx.globalAlpha = edge * (0.55 - i * 0.08);
        ctx.strokeRect(1 + i * 2, 1 + i * 2, width - 2 - i * 4, height - 2 - i * 4);
      }
    }
    ctx.restore();
  };
}

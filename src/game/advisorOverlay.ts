import type { BattleState } from '../runtime';
import { slotCell } from '../advisor/snapshot';
import type { AdvisorView } from '../advisor';

export function drawAdvisorOverlay(ctx: CanvasRenderingContext2D, view: AdvisorView, state: BattleState, px: number, accent: string, previewId: string | null) {
  const { pack, occupied } = state;
  const cur = view.current;
  if (!cur) return;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'left';
  for (const o of cur.advice.options) {
    if (o.id !== previewId || cur.adopted.includes(o.id)) continue;
    for (const m of o.moves) {
      const c = slotCell(pack, m.slot);
      if (!c || occupied.includes(`${c.x},${c.y}`)) continue;
      ctx.globalAlpha = 0.94;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(c.x * px + 4, c.y * px + 4, px - 8, px - 8);
      ctx.fillText(o.id.toUpperCase(), c.x * px + 7, c.y * px + 15);
    }
  }
  ctx.restore();
}

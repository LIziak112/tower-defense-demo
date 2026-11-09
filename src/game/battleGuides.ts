import { CELL, type Cell, type ContentPack } from '../runtime';
import type { BuildPreview } from './battlefield';

const dashed = [9, 12], solid: number[] = [];
type Project = (x: number, y: number, out: Cell) => Cell;

export function createBattleGuides(hud: HTMLElement) {
  let hover: HTMLElement | null = null, focus: HTMLElement | null = null;
  const a = { x: 0, y: 0 }, b = { x: 0, y: 0 }, center = { x: 0, y: 0 };
  const upgrade = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('[data-next-range]') : null;
  hud.addEventListener('pointerover', (e) => { hover = upgrade(e.target); });
  hud.addEventListener('pointerout', (e) => { hover = upgrade(e.relatedTarget); });
  hud.addEventListener('focusin', (e) => { focus = upgrade(e.target); });
  hud.addEventListener('focusout', (e) => { focus = upgrade(e.relatedTarget); });

  function compare(ctx: CanvasRenderingContext2D, pack: ContentPack, project: Project, tower: BuildPreview, next: number,
    px: number, aspect: number, now: number) {
    const x = (tower.x + 0.5) * CELL, y = (tower.y + 0.5) * CELL;
    project(x, y, center);
    const currentRadius = tower.range * px / CELL, nextRadius = next * px / CELL;
    ctx.strokeStyle = '#e7f3f0'; ctx.lineWidth = 1.4; ctx.setLineDash(dashed);
    ctx.lineDashOffset = -now * 0.035;
    ctx.beginPath(); ctx.ellipse(center.x, center.y, currentRadius, currentRadius * aspect, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash(solid);
    ctx.strokeStyle = '#78f5b9'; ctx.lineWidth = 1.8;
    ctx.globalAlpha = now ? 0.82 + Math.sin(now * 0.005) * 0.16 : 1;
    ctx.beginPath(); ctx.ellipse(center.x, center.y, nextRadius, nextRadius * aspect, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    const path = pack.map.path;
    for (let i = 1; i < path.length; i++) {
      const ax = (path[i - 1].x + 0.5) * CELL, ay = (path[i - 1].y + 0.5) * CELL;
      const dx = (path[i].x - path[i - 1].x) * CELL, dy = (path[i].y - path[i - 1].y) * CELL;
      const length = Math.hypot(dx, dy);
      const ux = dx / length, uy = dy / length;
      const projection = (x - ax) * ux + (y - ay) * uy;
      const offset = (x - ax) * uy - (y - ay) * ux;
      if (Math.abs(offset) >= next) continue;
      const outer = Math.sqrt(next ** 2 - offset ** 2);
      const inner = Math.sqrt(Math.max(0, tower.range ** 2 - offset ** 2));
      for (let side = 0; side < 2; side++) {
        const start = Math.max(0, projection + (side ? inner : -outer));
        const end = Math.min(length, projection + (side ? outer : -inner));
        if (start >= end) continue;
        project(ax + ux * start, ay + uy * start, a); project(ax + ux * end, ay + uy * end, b);
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
    }
    ctx.stroke();
  }

  return (ctx: CanvasRenderingContext2D, pack: ContentPack, project: Project, px: number, aspect: number, now: number,
    route: boolean, tower: BuildPreview | null) => {
    const control = hover?.isConnected ? hover : focus?.isConnected ? focus : null;
    const next = tower && control ? Number(control.dataset.nextRange) : 0;
    if (!route && !(tower && next > tower.range)) return;
    ctx.save();
    if (route) {
      ctx.strokeStyle = '#b3f4e9'; ctx.lineWidth = 2;
      ctx.setLineDash(dashed); ctx.lineDashOffset = -now * 0.13;
      ctx.beginPath();
      const path = pack.map.path;
      for (let i = 0; i < path.length; i++) {
        project((path[i].x + 0.5) * CELL, (path[i].y + 0.5) * CELL, a);
        if (i) ctx.lineTo(a.x, a.y); else ctx.moveTo(a.x, a.y);
      }
      ctx.stroke();
    }
    if (tower && next > tower.range) compare(ctx, pack, project, tower, next, px, aspect, now);
    ctx.restore();
  };
}

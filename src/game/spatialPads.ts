import type { BattleState, Cell, ContentPack } from '../runtime';
import { slotCell } from '../advisor/snapshot';
import type { SpatialProjector } from './spatialMap';
import { drawBuildPreview } from './battlefield';
import { drawPillTag, rgba, type SpatialColors, type SpatialDrawOptions } from './spatialDrawing';

export function drawBastions(ctx: CanvasRenderingContext2D, state: BattleState, proj: SpatialProjector, waypoints: Cell[], colors: SpatialColors, aspectY: number, lang: 'zh' | 'en') {
  const { accent, ink, paper, danger } = colors;
  // (3.5) 起点「敌军入口」与终点「母星防线」2.5D 阶梯式立体堡垒高台
  const drawSteppedBastion = (pt: { x: number; y: number }, r: number, mainColor: string) => {
    ctx.save();
    ctx.shadowColor = 'rgba(8, 12, 20, 0.42)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = rgba(ink, 0.65);
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y + 4, r * 1.25, r * 1.25 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = rgba(paper, 0.88);
    ctx.strokeStyle = rgba(mainColor, 0.75);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y + 1.5, r * 1.18, r * 1.18 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = rgba(mainColor, 0.92);
    ctx.strokeStyle = paper;
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y - 2, r * 0.86, r * 0.86 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = rgba(paper, 0.88);
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y - 3.5, r * 0.36, r * 0.36 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
  };

  const startPt = waypoints[0];
  const portalR = Math.max(12, proj.cellPx * 0.29);
  drawSteppedBastion(startPt, portalR, danger);
  drawPillTag(
    ctx,
    lang === 'zh' ? '敌军入口' : 'Spawn',
    startPt.x,
    startPt.y - portalR * aspectY - 15,
    paper,
    danger,
    danger,
  );

  const endPt = waypoints[waypoints.length - 1];
  const baseR = Math.max(14.5, proj.cellPx * 0.35);
  drawSteppedBastion(endPt, baseR, accent);
  drawPillTag(
    ctx,
    lang === 'zh' ? `母星防线 ${state.base_hp}/${state.pack.map.base_hp}` : `Base ${state.base_hp}/${state.pack.map.base_hp}`,
    endPt.x,
    endPt.y - baseR * aspectY - 16,
    paper,
    ink,
    accent,
  );
}

export function drawPads(ctx: CanvasRenderingContext2D, state: BattleState, pack: ContentPack, proj: SpatialProjector, opts: SpatialDrawOptions, colors: SpatialColors, aspectY: number) {
  const { accent, ink, paper, hair } = colors;
  // 4. 沿途 2.5D 立体战术建塔基座（Tactical Emplacement Pads：双层立体圆台 + 侧壁厚度，无杂乱 #编号）
  const occupiedSet = new Set(state.occupied);
  const primarySlots = proj.tacticalSlots.filter((ts) => ts.adjacentToPath).slice(0, 16);
  const padR = Math.max(8, proj.cellPx * 0.21);

  const advisedMap = new Map<number, { optId: string; towerName: string; adopted: boolean }>();
  if (opts.cardView.current && (state.phase === 'build' || state.phase === 'wave')) {
    const cur = opts.cardView.current;
    for (const o of cur.advice.options) {
      if (o.id !== opts.previewId || cur.adopted.includes(o.id)) continue;
      for (const m of o.moves) {
        const cell = slotCell(pack, m.slot);
        if (!cell || state.occupied.includes(`${cell.x},${cell.y}`)) continue;
        if (!advisedMap.has(m.slot)) {
          const tName = pack.towers.find((t) => t.id === m.tower)?.display_name ?? m.tower;
          advisedMap.set(m.slot, { optId: o.id.toUpperCase(), towerName: tName, adopted: cur.adopted.includes(o.id) });
        }
      }
    }
  }

  ctx.save();
  for (const ts of primarySlots) {
    const key = `${ts.x},${ts.y}`;
    if (occupiedSet.has(key)) continue;
    const isHovered = opts.range?.x === ts.x && opts.range?.y === ts.y && opts.range.valid;
    const advised = advisedMap.get(ts.slot);
    const r = isHovered || advised ? padR * 1.18 : padR;

    ctx.fillStyle = 'rgba(10, 16, 24, 0.26)';
    ctx.beginPath();
    ctx.ellipse(ts.sx, ts.sy + 3.2, r + 1.5, (r + 1.5) * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = rgba(ink, 0.45);
    ctx.beginPath();
    ctx.ellipse(ts.sx, ts.sy + 1.8, r, r * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = isHovered
      ? rgba(accent, 0.48)
      : advised
        ? rgba(accent, 0.34)
        : rgba(paper, 0.68, '240,244,240');
    ctx.strokeStyle = isHovered || advised ? accent : rgba(hair, 0.85, '140,155,155');
    ctx.lineWidth = isHovered || advised ? 2.0 : 1.4;
    ctx.beginPath();
    ctx.ellipse(ts.sx, ts.sy, r, r * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = isHovered || advised ? rgba(paper, 0.8) : rgba(ink, 0.28);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(ts.sx, ts.sy, r * 0.55, r * 0.55 * aspectY, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = isHovered || advised ? accent : rgba(ink, 0.45);
    ctx.beginPath();
    ctx.arc(ts.sx, ts.sy, isHovered || advised ? 2.5 : 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // 5. 军师建议落点铭牌（精巧胶囊标在对应基座上方，如「A·弩车」）
  for (const [slotId, info] of advisedMap.entries()) {
    const c = slotCell(pack, slotId);
    if (!c || occupiedSet.has(`${c.x},${c.y}`)) continue;
    const pt = proj.cellToScreen(c.x + 0.5, c.y + 0.5);
    ctx.save();
    ctx.globalAlpha = info.adopted ? 0.45 : 0.96;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.8;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y, padR * 1.45, padR * 1.45 * aspectY, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    drawPillTag(
      ctx,
      `${info.optId}·${info.towerName}`,
      pt.x,
      pt.y - padR * aspectY - 12,
      paper,
      ink,
      accent,
      info.adopted ? 0.5 : 0.94,
    );
    ctx.restore();
  }

  if (opts.range) drawBuildPreview(ctx, proj.milliToScreen, opts.range, proj.cellPx, aspectY, opts.invalid);
  ctx.restore();

}

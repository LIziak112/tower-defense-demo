import type { Palette } from './palettes';
import type { BuildPreview } from './battlefield';
import type { BattleFx } from './battleFx';
import type { AdvisorView } from '../advisor';

export interface SpatialDrawOptions {
  cardView: AdvisorView;
  previewId: string | null;
  range: BuildPreview | null;
  fx: BattleFx;
  invalid: number;
  now: number;
  lang: 'zh' | 'en';
  heldText: string;
  fellText: string;
}

export function rgba(hex: string | undefined, alpha: number, fallback = '100,140,160'): string {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return `rgba(${fallback},${alpha})`;
  const s = hex.slice(1);
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function drawPillTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  bgHex: string,
  fgHex: string,
  borderHex: string,
  alpha = 0.92,
) {
  ctx.save();
  ctx.font = '600 11px "IBM Plex Sans", "PingFang SC", system-ui, sans-serif';
  const padX = 7;
  const h = 20;
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const rx = x - w / 2;
  const ry = y - h / 2;
  ctx.fillStyle = rgba(bgHex, alpha, '36,46,64');
  ctx.strokeStyle = rgba(borderHex, 0.75, '180,190,200');
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(rx, ry, w, h, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = fgHex;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

export function spatialColors(theme: Palette) {
  const accent = theme.accent ?? theme.base ?? '#356d73';
  const ink = theme.ink ?? theme.text ?? '#263443';
  const paper = theme.paper ?? '#f3f5eb';
  const hair = theme.hair ?? '#9aa8a6';
  const roadColor = theme.path ?? '#717e7d';
  const roadAlt = theme.pathAlt ?? '#5c6867';
  const danger = theme.danger ?? '#c03221';
  const okColor = theme.ok ?? '#338a72';
  return { accent, ink, paper, hair, roadColor, roadAlt, danger, okColor };
}
export type SpatialColors = ReturnType<typeof spatialColors>;

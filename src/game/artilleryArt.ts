import { CELL, type Cell, type ContentPack, type Projectile } from '../runtime';
import { drawMuzzle } from './lightStamps';
import type { Palette } from './palettes';

export function paintBattleTerrain(ctx: CanvasRenderingContext2D, pack: ContentPack, px: number, theme: Palette, trial: boolean) {
  const { width, height, path, buildable_cells } = pack.map;
  const w = width * px, h = height * px;
  ctx.fillStyle = trial ? 'hsl(170 16% 12%)' : theme.grid1;
  ctx.fillRect(0, 0, w, h);

  // Survey lines sit behind the road and the inset pads.
  ctx.strokeStyle = '#a1bfb511';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 1; x < width; x++) { ctx.moveTo(x * px, 0); ctx.lineTo(x * px, h); }
  for (let y = 1; y < height; y++) { ctx.moveTo(0, y * px); ctx.lineTo(w, y * px); }
  ctx.stroke();
  ctx.strokeStyle = '#92b0a331';
  for (const [x, y, dx, dy] of [[12, 12, 1, 1], [w - 12, 12, -1, 1], [12, h - 12, 1, -1], [w - 12, h - 12, -1, -1]]) {
    ctx.beginPath(); ctx.moveTo(x, y + 13 * dy); ctx.lineTo(x, y); ctx.lineTo(x + 13 * dx, y); ctx.stroke();
  }

  const road = new Path2D();
  road.moveTo((trial ? 0 : path[0].x + 0.5) * px, (path[0].y + 0.5) * px);
  for (const { x, y } of path) road.lineTo((x + 0.5) * px, (y + 0.5) * px);
  ctx.lineCap = trial ? 'butt' : 'round';
  ctx.lineJoin = 'round';
  for (const [color, stroke] of [['#101718', 49], ['#43504b', 45], [trial ? 'hsl(165 12% 18%)' : theme.path, 43]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = stroke;
    ctx.stroke(road);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#9baea64a';
  ctx.setLineDash([3, 9]);
  ctx.stroke(road);
  ctx.setLineDash([]);

  for (const { x, y } of buildable_cells) {
    ctx.save();
    ctx.translate((x + 0.5) * px, (y + 0.5) * px);
    ctx.fillStyle = trial ? '#26332f' : theme.pathAlt;
    ctx.strokeStyle = '#435c52';
    ctx.beginPath(); ctx.roundRect(-21, -21, 42, 42, 4); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#92c0ab77';
    ctx.beginPath();
    ctx.moveTo(-5, 0); ctx.lineTo(5, 0);
    ctx.moveTo(0, -5); ctx.lineTo(0, 5);
    ctx.stroke();
    ctx.fillStyle = '#617d71';
    for (const dx of [-16, 15]) for (const dy of [-16, 15]) ctx.fillRect(dx, dy, 1.5, 1.5);
    ctx.restore();
  }

  const gate = path[path.length - 1];
  ctx.save();
  ctx.translate((gate.x + 0.5) * px, (gate.y + 0.5) * px);
  const approach = path[path.length - 2];
  if (approach) ctx.rotate(Math.atan2(gate.y - approach.y, gate.x - approach.x));
  ctx.fillStyle = '#171e1d';
  ctx.strokeStyle = trial ? '#bc9f6d' : theme.base;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(-17, -23, 28, 46, 3); ctx.fill(); ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fillRect(-13, -20, 21, 7); ctx.fillRect(-13, 13, 21, 7);
  ctx.fillStyle = '#7c684b';
  ctx.fillRect(4, -9, 3, 18);
  ctx.restore();

  if (!trial) return;
  ctx.fillStyle = '#9bb2a7';
  ctx.font = '600 9px system-ui';
  ctx.fillText('01  /  CHANGBAN FIRING RANGE', 20, 30);
  ctx.fillText('ENTRY', 15, (path[0].y + 0.5) * px + 36);
  ctx.fillStyle = '#c3ad86';
  ctx.textAlign = 'right';
  ctx.fillText('GATE', w - 12, (gate.y + 0.5) * px + 36);
}

let mount: Path2D | undefined, housing: Path2D | undefined;

export function drawHeavyCannon(ctx: CanvasRenderingContext2D, angle: number, recoil: number, charge: number, flash: boolean) {
  mount ??= new Path2D('M-14 -19H14L21 -12V12L14 19H-14L-21 12V-12Z');
  housing ??= new Path2D('M-8 -7H8L12 -5H18V-7H24V7H18V5H12L8 7H-8Z');
  ctx.save();
  ctx.scale(1 + recoil * 0.12, 1);
  ctx.fillStyle = '#19332e';
  ctx.strokeStyle = '#0c1b1a'; ctx.lineWidth = 3;
  ctx.fill(mount); ctx.stroke(mount);
  ctx.strokeStyle = '#76c7ae'; ctx.lineWidth = 1.4;
  ctx.stroke(mount);
  ctx.fillStyle = '#5a9b87';
  ctx.fillRect(-13, -16, 18, 3); ctx.fillRect(-17, -12, 3, 12);
  ctx.fillStyle = '#a3dac6';
  for (const x of [-12, 10]) for (const y of [-12, 10]) ctx.fillRect(x, y, 2.5, 2.5);
  ctx.restore();
  ctx.save();
  ctx.translate(0, -3);
  ctx.rotate(angle);
  ctx.translate(-6 * recoil - 3 * charge, 0);
  ctx.fillStyle = '#314944';
  ctx.strokeStyle = '#102222'; ctx.lineWidth = 3;
  ctx.fill(housing); ctx.stroke(housing);
  ctx.strokeStyle = '#a8d7c7'; ctx.lineWidth = 1.3;
  ctx.stroke(housing);
  ctx.fillStyle = '#709d90'; ctx.fillRect(3, -4, 13, 2);
  ctx.fillStyle = charge > 0 ? '#fff0ab' : '#81ceb2'; ctx.fillRect(-5, -3, 4, 6);
  ctx.fillStyle = '#101c1b'; ctx.fillRect(21, -4, 2, 8);
  if (flash) drawMuzzle(ctx, 25, 0);
  ctx.restore();
}

let footmanBody: Path2D | undefined, footmanShield: Path2D | undefined;

export function drawRangeFootman(ctx: CanvasRenderingContext2D, flash: boolean) {
  footmanBody ??= new Path2D('M-11 -5L-7 -10H3L8 -6V6L3 10H-7L-11 5Z');
  footmanShield ??= new Path2D('M6 -9L12 -5V5L6 9L3 6V-6Z');
  ctx.fillStyle = flash ? '#fff' : '#c85c4d';
  ctx.strokeStyle = '#331d1d'; ctx.lineWidth = 2;
  ctx.fill(footmanBody); ctx.stroke(footmanBody);
  ctx.fillStyle = flash ? '#fff' : '#f4977a';
  ctx.fill(footmanShield); ctx.stroke(footmanShield);
  if (!flash) {
    ctx.fillStyle = '#f5b29a'; ctx.fillRect(-7, -6, 6, 2);
    ctx.fillStyle = '#843f38'; ctx.fillRect(6, -3, 2, 6);
  }
}

export function drawHeavyShell(ctx: CanvasRenderingContext2D, shot: Projectile, from: Cell, to: Cell,
  fraction: number, cellPx: number, animate: boolean) {
  const t = Math.min(1, (shot.age + fraction) / shot.duration);
  const dx = to.x - from.x, dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const muzzle = Math.min(distance * 0.5, 19);
  const x0 = from.x + dx / distance * muzzle, y0 = from.y + dy / distance * muzzle;
  const arc = 4 * shot.height * cellPx / CELL;
  const x = x0 + (to.x - x0) * t, groundY = y0 + (to.y - y0) * t;
  const lift = arc * t * (1 - t), y = groundY - 4 - lift;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.28 - 0.15 * lift / (arc / 4 || 1);
  ctx.fillStyle = '#0a1111';
  ctx.beginPath(); ctx.ellipse(x, groundY + 2, 5, 2.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  if (animate) {
    let tailX = x, tailY = y;
    ctx.strokeStyle = '#ffb268';
    for (let i = 1; i <= 6; i++) {
      const tail = t - i * 0.033;
      if (tail < 0) break;
      const nextX = x0 + (to.x - x0) * tail;
      const nextY = y0 + (to.y - y0) * tail - 4 - arc * tail * (1 - tail);
      ctx.globalAlpha = (1 - (i - 1) / 6) * 0.65;
      ctx.lineWidth = (3.8 - i * 0.55) * (shot.critical ? 1.5 : 1);
      ctx.beginPath(); ctx.moveTo(tailX, tailY); ctx.lineTo(nextX, nextY); ctx.stroke();
      tailX = nextX; tailY = nextY;
    }
  }
  const angle = Math.atan2(to.y - y0 - arc * (1 - 2 * t), to.x - x0);
  ctx.translate(x, y); ctx.rotate(angle);
  ctx.fillStyle = '#ffae5e';
  ctx.globalAlpha = 0.18;
  ctx.beginPath(); ctx.ellipse(0, 0, 10, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff0ce'; ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.ellipse(0, 0, 5.5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

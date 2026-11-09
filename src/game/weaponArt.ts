import { CELL, type Cell, type Projectile } from '../runtime';
import { unit } from './motion';

export const weaponLength = { crossbow: 17, beam: 16 };
export type Weapon = keyof typeof weaponLength;

export function weaponFor(id: string): Weapon | undefined {
  if (id === 'crossbow' || id === 'beam') return id;
}

export function drawWeapon(ctx: CanvasRenderingContext2D, weapon: Weapon, age: number, firing: boolean, animate: boolean) {
  const arrow = weapon === 'crossbow';
  const release = arrow && animate ? Math.max(0, 1 - age / 82) : 0;
  const tone = arrow ? '#a6dfb3' : '#9feeff';
  ctx.strokeStyle = '#102524'; ctx.lineWidth = 3;
  ctx.fillStyle = arrow ? '#29493e' : '#284952';
  ctx.beginPath(); ctx.roundRect(-7, -4, 23, 8, 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = tone; ctx.lineWidth = 1.3; ctx.stroke();
  if (arrow) {
    const draw = 4 * release;
    ctx.beginPath(); ctx.moveTo(7, -11); ctx.quadraticCurveTo(17, 0, 7, 11); ctx.stroke();
    ctx.strokeStyle = '#e9f1cb';
    ctx.beginPath(); ctx.moveTo(7, -11); ctx.lineTo(6 + draw, 0); ctx.lineTo(7, 11); ctx.stroke();
    if (age < 42) {
      ctx.fillStyle = '#fff5d4';
      ctx.beginPath(); ctx.moveTo(21, 0); ctx.lineTo(13, -3); ctx.lineTo(14, 3); ctx.closePath(); ctx.fill();
    }
  } else {
    ctx.fillStyle = firing ? '#dcfcff' : '#64a9b5';
    ctx.fillRect(11, -5, 5, 10);
    ctx.fillStyle = firing ? '#b5f7ff' : '#6fbbc8';
    ctx.fillRect(-4, -2, 5, 4);
  }
}

export function drawBolt(ctx: CanvasRenderingContext2D, shot: Projectile, from: Cell, to: Cell,
  fraction: number, px: number, lift: number, animate: boolean) {
  const t = unit((shot.age + fraction) / shot.duration);
  const scale = px / 56, dx = to.x - from.x, dy = to.y - from.y;
  const muzzle = Math.min(0.5, weaponLength.crossbow * scale / (Math.hypot(dx, dy) || 1));
  const along = muzzle + (1 - muzzle) * t;
  const arc = 4 * shot.height * px / CELL;
  const angle = Math.atan2(dy * (1 - muzzle) + lift - 4 - arc * (1 - 2 * t), dx * (1 - muzzle));
  ctx.save();
  ctx.translate(from.x + dx * along, from.y + dy * along - lift * (1 - t) - 4 * t - arc * t * (1 - t));
  ctx.rotate(angle);
  const tail = Math.min(19 * scale, t * Math.hypot(dx, dy)) * (1 - 0.45 * t);
  if (animate && tail > 0) {
    const width = (shot.critical ? 1.8 : 1.2) * scale * (1 - 0.6 * t);
    ctx.fillStyle = '#efca7670';
    ctx.beginPath(); ctx.moveTo(-tail, 0); ctx.lineTo(0, -width); ctx.lineTo(0, width); ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = '#fff4d1';
  ctx.beginPath(); ctx.moveTo(7 * scale, 0); ctx.lineTo(1 * scale, -2.4 * scale); ctx.lineTo(1 * scale, 2.4 * scale);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#ffe4a1'; ctx.lineWidth = 1.2 * scale;
  ctx.beginPath(); ctx.moveTo(-7 * scale, 0); ctx.lineTo(4 * scale, 0);
  for (const side of [-1, 1]) {
    ctx.moveTo(-7 * scale, side * 2 * scale);
    ctx.lineTo(-3 * scale, 0);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawBeam(ctx: CanvasRenderingContext2D, shot: Projectile, from: Cell, to: Cell,
  fraction: number, px: number, lift: number, animate: boolean) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const muzzle = Math.min(0.5, weaponLength.beam * px / 56 / (Math.hypot(dx, dy) || 1));
  const x = from.x + dx * muzzle, y = from.y + dy * muzzle - lift, endY = to.y - 4;
  const age = shot.age + fraction;
  const strength = animate ? 0.45 + 0.55 * Math.min(unit(age / 2), unit((shot.duration - age) / 4)) : 0.78;
  ctx.save();
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(to.x, endY);
  ctx.globalAlpha = strength;
  ctx.strokeStyle = '#55d9ff35'; ctx.lineWidth = 10; ctx.stroke();
  ctx.strokeStyle = '#6ce9ff85'; ctx.lineWidth = 4; ctx.stroke();
  ctx.strokeStyle = '#e0fcff'; ctx.lineWidth = 1.4; ctx.stroke();
  if (animate) {
    const pulse = (age % 6) / 6, tail = Math.max(0, pulse - 0.17);
    ctx.beginPath();
    ctx.moveTo(x + (to.x - x) * tail, y + (endY - y) * tail);
    ctx.lineTo(x + (to.x - x) * pulse, y + (endY - y) * pulse);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.8; ctx.stroke();
  }
  ctx.restore();
}

export function drawWeaponHit(ctx: CanvasRenderingContext2D, weapon: Weapon, point: Cell, from: Cell, t: number, animate: boolean) {
  const travel = animate ? 1 - (1 - t) ** 2 : 0;
  ctx.save();
  ctx.translate(point.x, point.y - 4);
  ctx.globalAlpha = 0.9 * (1 - t);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (weapon === 'beam') {
    ctx.strokeStyle = '#8aeaff';
    const radius = 4 + 9 * travel;
    ctx.ellipse(0, 0, radius, radius * 0.65, 0, 0, Math.PI * 2);
  } else {
    ctx.rotate(Math.atan2(point.y - from.y, point.x - from.x));
    ctx.strokeStyle = '#ffe7ad';
    for (const side of [-1, 0, 1]) {
      ctx.moveTo(6 * travel, side * 5 * travel);
      ctx.lineTo(7 + 9 * travel, side * (4 + 7 * travel));
    }
  }
  ctx.stroke();
  ctx.fillStyle = weapon === 'beam' ? '#e4fcff' : '#fff1cb';
  ctx.fillRect(-2, -2, 4, 4);
  ctx.restore();
}

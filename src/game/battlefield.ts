import { enemyDefinition } from '../runtime/enemies';
import { pickTarget } from '../runtime/targeting';
import { CELL, TICKS_PER_SECOND, positionAt, type Cell } from '../runtime';
import type { BattleFx } from './battleFx';
import { drawMuzzle } from './lightStamps';
import type { BattleState, ContentPack } from '../runtime/types';
import type { Palette } from './palettes';
import { drawHeavyCannon, drawRangeFootman, paintBattleTerrain } from './artilleryArt';
import { unit } from './motion';
import { towerStats } from '../runtime/upgrade';
import { drawWeapon, weaponFor } from './weaponArt';

let backdrop: { pack: ContentPack; theme: Palette; density: number; canvas: HTMLCanvasElement } | undefined;

export function drawTerrain(ctx: CanvasRenderingContext2D, pack: ContentPack, theme: Palette, px: number, trial: boolean) {
  const width = pack.map.width * px, height = pack.map.height * px;
  const density = trial ? ctx.canvas.width / width : 1;
  if (backdrop?.pack !== pack || backdrop.theme !== theme || backdrop.density !== density) {
    const canvas = document.createElement('canvas');
    canvas.width = width * density;
    canvas.height = Math.round(height * density);
    const map = canvas.getContext('2d')!;
    map.scale(density, density);
    paintBattleTerrain(map, pack, px, theme, trial);
    backdrop = { pack, theme, density, canvas };
  }
  ctx.drawImage(backdrop.canvas, 0, 0, width, height);
}

const levelLabels = Array.from({ length: 13 }, (_, level) => `Lv.${level}`);
const towerRims = ['hsl(194 58% 71%)', 'hsl(165 46% 62%)', 'hsl(154 55% 66%)'];
const towerVariant = (id: string) => id === 'arcane' || id === 'beam' ? 0 : id === 'catapult' ? 1 : 2;
const bodies: HTMLCanvasElement[] = [];
const chassis: HTMLCanvasElement[] = [];
const enemyPoses: HTMLCanvasElement[] = [];
let barrel: HTMLCanvasElement | undefined;
let softShadow: HTMLCanvasElement | undefined;
const enemyPosition = { x: 0, y: 0 };
const enemyHeading = { x: 0, y: 0 };

export function drawGroundUnits(ctx: CanvasRenderingContext2D, state: BattleState, scale: (m: number) => number, fx: BattleFx,
  seconds: number, animate: boolean, moving: boolean, trial: boolean, tickFraction: number) {
  const idle = animate ? 1 + Math.sin(seconds * 2.5) * 0.03 : 1;
  for (let i = 0; i < state.towers.length; i++) {
    const tower = state.towers[i];
    const level = tower.level ?? 1;
    const variant = towerVariant(tower.def);
    const shot = fx.field.shot(tower.iid);
    const weapon = weaponFor(tower.def);
    const recoil = shot && !weapon ? fx.field.recoil(shot.at) : 0;
    ctx.save(); ctx.translate(scale(tower.x) | 0, scale(tower.y) | 0);
    shadow(ctx, 22);
    const size = fx.towerScale(tower.iid) * idle;
    if (tower.def === 'catapult') {
      const def = moving && tower.cooldown <= 2 && state.pack.towers.find((item) => item.id === tower.def);
      const stats = def && towerStats(def, level, tower.branch);
      const target = stats && pickTarget(tower, state.enemies, stats.range * 1.025,
        tower.targeting ?? stats.targeting ?? 'first_on_path');
      const untilShot = (Math.max(1, tower.cooldown) - tickFraction) * 1000 / TICKS_PER_SECOND;
      const charge = target && animate ? unit(1 - untilShot / 40) : 0;
      const angle = target ? Math.atan2(target.y - tower.y, target.x - tower.x) : shot?.angle ?? -Math.PI / 2;
      ctx.scale(size, size);
      drawHeavyCannon(ctx, angle, recoil, charge, !!shot && fx.field.flash(shot.at));
      if (!trial) {
        ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#c5e8d8';
        ctx.fillText(levelLabels[level] ?? `Lv.${level}`, 0, 14);
      }
      ctx.restore();
      continue;
    }
    ctx.scale(size * (1 + recoil * 0.12), size);
    const index = variant * levelLabels.length + level;
    ctx.drawImage(chassis[index] ?? cacheChassis(index, variant, level), -20, -20);
    if (weapon) {
      ctx.translate(0, -3);
      ctx.rotate(shot ? Math.atan2(shot.y - tower.y, shot.x - tower.x) : -Math.PI / 2);
      drawWeapon(ctx, weapon, fx.field.shotAge(tower.iid), fx.field.beaming(tower.iid), animate);
      ctx.restore();
      continue;
    }
    ctx.save(); ctx.translate(0, -3);
    ctx.rotate(shot?.angle ?? -Math.PI / 2);
    ctx.translate(-6 * recoil, 0);
    ctx.drawImage(barrel ?? cacheBarrel(), -5, -4);
    if (shot && fx.field.flash(shot.at)) drawMuzzle(ctx, 20, 0);
    ctx.restore();
    ctx.save(); ctx.translate(0, -3);
    if (animate) ctx.rotate(seconds * 1.6);
    ctx.fillStyle = variant === 0 ? '#e6faff' : '#d1f5e4';
    ctx.strokeStyle = '#2b6265'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(6, 0); ctx.lineTo(0, 6); ctx.lineTo(-6, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    ctx.restore();
  }
  for (let i = 0; i < state.enemies.length; i++) {
    const enemy = state.enemies[i];
    const def = enemyDefinition(state.pack, enemy.def);
    const hit = fx.impact(enemy.iid), frozen = !!hit && fx.frozen(hit);
    const footman = state.enemies.length <= 64 && enemy.def === 'footman' && !def.armor;
    const position = frozen ? hit : footman && moving && enemy.life === 'alive'
      ? positionAt(state.pack.map.path, enemy.progress + Math.max(1, Math.round(def.speed * (state.pack.difficulty ?? 1))) * tickFraction, enemyPosition) : enemy;
    const x = scale(position.x), y = scale(position.y);
    const armored = !!def.armor;
    const bulk = armored ? 14 : enemy.def === 'light_cavalry' ? 11 : 9;
    const lean = animate && moving && !frozen && enemy.life === 'alive' ? Math.round(Math.sin(seconds * 11 + enemy.iid) * 4) : 0;
    const squash = fx.squash(enemy.iid);
    const flash = fx.flash(enemy.iid);
    const variant = (armored ? 3 : bulk === 11 ? 4 : 5) + (flash ? 3 : 0);
    const tint = flash ? '#fff' : armored ? 'hsl(39 59% 53%)' : bulk === 11 ? 'hsl(335 63% 62%)' : 'hsl(9 72% 62%)';
    const body = bodies[variant] ?? cacheBody(variant, tint, bulk);
    if (footman) {
      ctx.save(); ctx.translate(x, y); shadow(ctx, 15);
      if (squash && hit) {
        const direction = Math.atan2(hit.y - hit.fromY, hit.x - hit.fromX);
        ctx.rotate(direction); ctx.scale(1 - squash, 1 + squash); ctx.rotate(-direction);
      }
      const next = positionAt(state.pack.map.path, enemy.progress + def.speed * 3, enemyHeading);
      ctx.rotate(Math.atan2(next.y - enemy.y, next.x - enemy.x) + lean * Math.PI / 180);
      drawRangeFootman(ctx, flash);
      ctx.restore();
    } else if (squash && hit) {
      ctx.save(); ctx.translate(x, y); shadow(ctx, bulk + 3);
      const direction = Math.atan2(hit.y - hit.fromY, hit.x - hit.fromX);
      ctx.rotate(direction); ctx.scale(1 - squash, 1 + squash); ctx.rotate(-direction + lean * Math.PI / 180);
      ctx.drawImage(body, -20, -20); ctx.restore();
    } else {
      const pose = (variant - 3) * 9 + lean + 4;
      ctx.drawImage(enemyPoses[pose] ?? cachePose(pose, body, lean, bulk), (x | 0) - 20, (y | 0) - 20);
    }
    fx.health(ctx, enemy.iid, enemy.hp / (enemy.max_hp ?? def.hp), x - 13, y - 22, 26, 3);
  }
}

function shadow(ctx: CanvasRenderingContext2D, radius: number) {
  if (!softShadow) {
    softShadow = document.createElement('canvas');
    softShadow.width = softShadow.height = 40;
    const painter = softShadow.getContext('2d')!;
    const fade = painter.createRadialGradient(20, 20, 12, 20, 20, 20);
    fade.addColorStop(0, 'rgba(0,0,0,.35)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    painter.fillStyle = fade; painter.fillRect(0, 0, 40, 40);
  }
  ctx.drawImage(softShadow, -radius, 0, radius * 2, radius * 0.70);
}

function cacheBody(variant: number, color: string, bulk: number) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 40;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(20, 20);
  ctx.fillStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  if (variant < 3) {
    ctx.strokeStyle = 'hsl(172 37% 37%)';
    ctx.moveTo(-17, 10); ctx.lineTo(-15, -11); ctx.lineTo(-8, -17); ctx.lineTo(8, -17);
    ctx.lineTo(15, -11); ctx.lineTo(17, 10); ctx.lineTo(11, 16); ctx.lineTo(-11, 16);
  } else {
    ctx.strokeStyle = variant === 3 || variant === 6 ? '#e3e9ec' : 'hsl(8 42% 35%)';
    ctx.moveTo(-bulk, 7); ctx.lineTo(-bulk, -6); ctx.lineTo(-bulk * 0.55, -12); ctx.lineTo(bulk * 0.45, -12);
    ctx.lineTo(bulk, -4); ctx.lineTo(bulk, 7); ctx.lineTo(bulk * 0.5, 10); ctx.lineTo(-bulk * 0.5, 10);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  if (variant < 6) highlight(ctx, variant < 3 ? 14 : bulk, variant < 3 ? 16 : 11);
  return bodies[variant] = canvas;
}

function cacheChassis(index: number, variant: number, level: number) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 40;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bodies[variant] ?? cacheBody(variant, towerRims[variant], 17), 0, 0);
  ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#183130';
  ctx.fillText(levelLabels[level] ?? `Lv.${level}`, 20, 33);
  return chassis[index] = canvas;
}

function cacheBarrel() {
  barrel = document.createElement('canvas');
  barrel.width = 26; barrel.height = 8;
  const ctx = barrel.getContext('2d')!;
  ctx.fillStyle = '#233e40'; ctx.strokeStyle = '#a6e9e0'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(1, 1, 24, 6, 2); ctx.fill(); ctx.stroke();
  return barrel;
}

function cachePose(index: number, body: HTMLCanvasElement, lean: number, bulk: number) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 40;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(20, 20); shadow(ctx, bulk + 3);
  ctx.rotate(lean * Math.PI / 180); ctx.drawImage(body, -20, -20);
  return enemyPoses[index] = canvas;
}

function highlight(ctx: CanvasRenderingContext2D, rx: number, ry: number) {
  ctx.fillStyle = 'rgba(255,255,255,.18)';
  ctx.beginPath();
  ctx.moveTo(-rx * 0.86, -ry * 0.46); ctx.lineTo(-rx * 0.45, -ry * 0.90);
  ctx.lineTo(rx * 0.60, -ry * 0.90); ctx.lineTo(-rx * 0.12, -ry * 0.08); ctx.lineTo(-rx * 0.86, 0);
  ctx.closePath(); ctx.fill();
}

export interface BuildPreview { x: number; y: number; range: number; valid: boolean; tower?: string; ghostX?: number; ghostY?: number }

export function drawBuildPreview(ctx: CanvasRenderingContext2D, project: (x: number, y: number) => Cell,
  preview: BuildPreview, cellPx: number, aspect: number, offset: number) {
  const x = preview.x * CELL, y = preview.y * CELL;
  const center = project(x + CELL / 2, y + CELL / 2);
  const a = project(x, y), b = project(x + CELL, y), c = project(x + CELL, y + CELL), d = project(x, y + CELL);
  const radius = preview.range * cellPx / CELL;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = preview.valid ? '#55dbab' : '#f47c72';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath();
  ctx.globalAlpha = 0.16; ctx.fill(); ctx.globalAlpha = 0.95; ctx.stroke();
  ctx.setLineDash([5, 4]);
  ctx.globalAlpha = 0.52;
  ctx.beginPath(); ctx.ellipse(center.x, center.y, radius, radius * aspect, 0, 0, 2 * Math.PI); ctx.stroke();
  ctx.setLineDash([]);
  if (preview.tower) {
    ctx.globalAlpha = 0.60;
    const ghost = project(((preview.ghostX ?? preview.x) + 0.5) * CELL, ((preview.ghostY ?? preview.y) + 0.5) * CELL);
    ctx.translate(ghost.x + offset, ghost.y);
    const size = cellPx / 56;
    ctx.scale(size, size * aspect);
    const weapon = weaponFor(preview.tower);
    if (preview.tower === 'catapult') drawHeavyCannon(ctx, -Math.PI / 2, 0, 0, false);
    else {
      const variant = towerVariant(preview.tower);
      ctx.drawImage(bodies[variant] ?? cacheBody(variant, towerRims[variant], 17), -20, -20);
      ctx.rotate(-Math.PI / 2);
      if (weapon) drawWeapon(ctx, weapon, Infinity, false, false);
      else ctx.drawImage(barrel ?? cacheBarrel(), -5, -4);
    }
  }
  ctx.restore();
}

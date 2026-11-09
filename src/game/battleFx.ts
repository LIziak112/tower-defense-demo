import { CELL, type BattleState, type Cell } from '../runtime';
import type { BattleBus } from './eventBus';
import { createDamageAtlas, damageSprite, goldSprite } from './damageAtlas';
import { createFieldEffects } from './fieldEffects';
import { drawHeavyShell } from './artilleryArt';
import { drawBeam, drawBolt, drawWeaponHit, type Weapon } from './weaponArt';
import { easeOut as ease, springOffset, unit as clamp } from './motion';
type Project = (x: number, y: number, out: Cell) => Cell;
type Timed = { until: number };
type Hit = Timed & { iid: number; at: number; buffer: number; ratio: number; x: number; y: number; fromX: number; fromY: number; frozenUntil: number; flashMs: number; squash: number };

function ring<T extends Timed>(size: number, create: () => T) {
  const items = Array.from({ length: size }, create);
  let index = 0;
  return {
    items,
    take() { const item = items[index]; index = (index + 1) % size; return item; },
    clear() { for (const item of items) item.until = 0; },
  };
}
const barUnits = 65536;
const detailedProjectileLimit = 96;
const barValue = (hp: number, maxHp: number) => (clamp(hp / maxHp) * barUnits) | 0;
const whiteBar = (hit: Hit, now: number) => (hit.buffer + (hit.ratio - hit.buffer) * ease((now - hit.at - 120) / 160)) | 0;
const damageLabels = Array.from({ length: 2501 }, (_, i) => `−${i}`);
const goldLabels = Array.from({ length: 101 }, (_, i) => `+${i}`);
const labelDrift = Int8Array.from({ length: 1024 }, () => ((Math.random() - 0.5) * 32) | 0);
const alphaSteps = new Array<number | null>(257).fill(null);
for (let i = 0; i < alphaSteps.length; i++) alphaSteps[i] = i / 256;
const opacity = (value: number) => alphaSteps[(clamp(value) * 256) | 0]!;
const labelRise = Int16Array.from({ length: 651 }, (_, ms) => Math.round(52 * ms / 650 - 23 * (ms / 650) ** 2));
const critShake = Int8Array.from({ length: 651 }, (_, ms) => Math.round(Math.sin(ms * 80 / 650) * (1 - ms / 650) * 4));

export function createBattleFx(bus: BattleBus, motion: () => boolean) {
  const field = createFieldEffects(bus, motion);
  const labels = ring(1024, () => ({ until: 0, x: 0, y: 0, text: '', color: '', drift: 0, critical: false, sprite: -1 }));
  const coins = ring(256, () => ({ until: 0, x: 0, y: 0 }));
  const dust = ring(384, () => ({ until: 0, x: 0, y: 0, vx: 0, vy: 0 }));
  const trails = ring(256, () => ({ until: 0, x: 0, y: 0, tx: 0, ty: 0 }));
  const hits = ring<Hit>(2048, () => ({ until: 0, iid: 0, at: 0, buffer: barUnits, ratio: barUnits, x: 0, y: 0, fromX: 0, fromY: 0, frozenUntil: 0, flashMs: 0, squash: 0 }));
  const sparks = ring(96, () => ({ until: 0, at: 0, weapon: 'crossbow' as Weapon, x: 0, y: 0, fromX: 0, fromY: 0 }));
  const byEnemy = new Map<number, Hit>();
  const towerPops = new Map<number, number>();
  const beamKeys = new Uint32Array(2048), beamFrames = new Uint32Array(2048);
  let beamFrame = 0;
  const drawSprite = createDamageAtlas();
  let now = 0;
  let driftIndex = 0;
  const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };

  function label(x: number, y: number, text: string, color: string, critical = false, sprite = -1) {
    const item = labels.take();
    item.x = x; item.y = y; item.text = text; item.color = color;
    item.drift = labelDrift[driftIndex++ & (labelDrift.length - 1)];
    item.critical = critical; item.sprite = sprite; item.until = now + 650;
  }
  function smoke(x: number, y: number) {
    if (!motion()) return;
    for (let i = 0; i < 9; i++) {
      const item = dust.take();
      item.x = x; item.y = y; item.until = now + 360;
      item.vx = (Math.random() - 0.5) * 68; item.vy = -Math.random() * 42;
    }
  }
  bus.on('attack', (event) => {
    if (event.projectile) return;
    const item = trails.take();
    item.x = event.fx; item.y = event.fy; item.tx = event.tx; item.ty = event.ty; item.until = now + 130;
  });
  bus.on('damage_applied', (event) => {
    let hit = byEnemy.get(event.target);
    if (hit && hit.until > now) {
      if (hit.at !== now) hit.buffer = whiteBar(hit, now);
    } else if (!hit) {
      hit = hits.take();
      if (byEnemy.get(hit.iid) === hit) byEnemy.delete(hit.iid);
      hit.iid = event.target;
      hit.frozenUntil = 0;
      hit.buffer = barValue(event.hp + event.amount, event.max_hp);
      byEnemy.set(event.target, hit);
    } else {
      hit.buffer = barValue(event.hp + event.amount, event.max_hp);
    }
    if (now >= hit.frozenUntil) { hit.x = event.x; hit.y = event.y; }
    const heavy = event.critical || event.arcHeight >= 600;
    const weapon = event.projectile === 'BEAM' ? 'beam' : event.projectile === 'ARC' && event.arcHeight < 600 ? 'crossbow' : undefined;
    if (heavy) hit.frozenUntil = now + 40;
    hit.flashMs = heavy ? 70 : weapon === 'beam' ? 0 : 42;
    hit.squash = heavy ? 0.25 : weapon === 'beam' ? 0 : 0.10;
    if (weapon) {
      const spark = sparks.take();
      spark.at = now; spark.until = now + (weapon === 'beam' ? 120 : 105); spark.weapon = weapon;
      spark.x = event.x; spark.y = event.y; spark.fromX = event.fromX; spark.fromY = event.fromY;
    }
    hit.fromX = event.fromX; hit.fromY = event.fromY;
    hit.at = now;
    hit.until = now + 280;
    hit.ratio = barValue(event.hp, event.max_hp);
    label(event.x, event.y, damageLabels[event.amount] ?? `−${event.amount}`, event.critical ? '#fff0a7' : '#ffe3af',
      event.critical, damageSprite(event.amount, event.critical));
  });
  bus.on('entity_died', (e) => {
    label(e.x, e.y, goldLabels[e.reward] ?? `+${e.reward}`, '#ffe29b', false, goldSprite(e.reward));
    const coin = coins.take();
    coin.x = e.x; coin.y = e.y; coin.until = now + 380;
    smoke(e.x, e.y);
  });
  bus.on('build_ok', (e) => {
    towerPops.set(e.iid, now);
    const x = e.x * CELL + CELL / 2, y = e.y * CELL + CELL / 2;
    label(x, y, `−${e.cost}`, '#f1c986');
    smoke(x, y);
  });
  bus.on('upgrade_ok', (e) => towerPops.set(e.iid, now));
  function drawProjectiles(ctx: CanvasRenderingContext2D, state: BattleState, project: Project, cellPx: number,
    fraction: number, lift: number, animate: boolean, dense: boolean) {
    for (let i = 0; i < trails.items.length; i++) {
      const item = trails.items[i];
      if (item.until <= now) continue;
      const from = project(item.x, item.y, a), to = project(item.tx, item.ty, b);
      ctx.globalAlpha = opacity((item.until - now) / 130);
      ctx.beginPath(); ctx.moveTo(from.x | 0, (from.y | 0) - 8); ctx.lineTo(to.x | 0, (to.y | 0) - 4); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    beamFrame = (beamFrame + 1) >>> 0;
    if (!beamFrame) { beamFrames.fill(0); beamFrame = 1; }
    let hasBeam = false;
    if (dense) ctx.beginPath();
    for (const shot of state.projectiles) {
      if (shot.kind === 'ARC' && !dense) {
        const from = project(shot.from_x, shot.from_y, a), to = project(shot.to_x, shot.to_y, b);
        if (shot.height >= 600) drawHeavyShell(ctx, shot, from, to, fraction, cellPx, animate);
        else drawBolt(ctx, shot, from, to, fraction, cellPx, lift, animate);
        continue;
      }
      if (shot.kind !== 'BEAM') continue;
      const link = (shot.source * 0x100000 + shot.target) >>> 0;
      const slot = (Math.imul(shot.source, 31) + shot.target) & (beamKeys.length - 1);
      if (beamFrames[slot] === beamFrame && beamKeys[slot] === link) continue;
      beamFrames[slot] = beamFrame;
      beamKeys[slot] = link;
      const from = project(shot.from_x, shot.from_y, a), to = project(shot.to_x, shot.to_y, b);
      if (dense) {
        ctx.moveTo(from.x, from.y - lift); ctx.lineTo(to.x, to.y - 4);
        hasBeam = true;
      } else {
        drawBeam(ctx, shot, from, to, fraction, cellPx, lift, animate);
      }
    }
    if (hasBeam) {
      ctx.strokeStyle = '#6ce9ff75'; ctx.lineWidth = 5; ctx.stroke();
      ctx.strokeStyle = '#e0fcff'; ctx.lineWidth = 1.4; ctx.stroke();
    }
    if (!state.projectiles.length) return;
    const origin = project(0, 0, b), ox = origin.x, oy = origin.y;
    const axis = project(CELL, 0, b), xx = (axis.x - ox) / CELL, xy = (axis.y - oy) / CELL;
    const vertical = project(0, CELL, b), yx = (vertical.x - ox) / CELL, yy = (vertical.y - oy) / CELL;
    ctx.fillStyle = dense ? '#fff0cc' : '#eee3ff';
    ctx.beginPath();
    for (const shot of state.projectiles) {
      const arc = shot.kind === 'ARC';
      if (shot.kind !== 'HOMING' && !(arc && dense)) continue;
      const point = project(shot.x, shot.y, a);
      const t = shot.age / shot.duration;
      const height = arc ? 4 * shot.height * cellPx / CELL : 0;
      const x = point.x | 0, y = (point.y - 6 - height * t * (1 - t)) | 0;
      const dx = arc ? (shot.to_x - shot.from_x) / shot.duration : Math.cos(shot.angle) * 240;
      const dy = arc ? (shot.to_y - shot.from_y) / shot.duration : Math.sin(shot.angle) * 240;
      const vx = dx * xx + dy * yx, vy = dx * xy + dy * yy - height * (1 - 2 * t) / shot.duration;
      const magnitude = Math.sqrt(vx * vx + vy * vy) || 1, ux = vx / magnitude, uy = vy / magnitude;
      const width = Math.max(0, 1 - t) * (shot.critical ? 3 : 2);
      const length = Math.min(20, 5 + magnitude);
      ctx.moveTo((x + ux * 3) | 0, (y + uy * 3) | 0);
      ctx.lineTo((x - uy * width) | 0, (y + ux * width) | 0);
      ctx.lineTo((x - ux * length) | 0, (y - uy * length) | 0);
      ctx.lineTo((x + uy * width) | 0, (y - ux * width) | 0);
      ctx.closePath();
    }
    ctx.fill();
  }
  function drawLabels(ctx: CanvasRenderingContext2D, project: Project, animate: boolean) {
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#151b24';
    for (let i = 0; i < labels.items.length; i++) {
      const item = labels.items[i];
      if (item.until <= now) continue;
      const ms = 650 - (item.until - now);
      const point = project(item.x, item.y, a);
      const x = (point.x | 0) + (animate ? ((item.drift * ms / 650) | 0) + (item.critical ? critShake[ms] : 0) : 0);
      const y = (point.y | 0) - 13 - (animate ? labelRise[ms] : 0);
      ctx.globalAlpha = opacity((650 - ms) / 260);
      if (item.sprite >= 0) { drawSprite(ctx, item.sprite, x, y); continue; }
      ctx.font = item.critical ? 'bold 19.5px system-ui' : 'bold 13px system-ui';
      ctx.fillStyle = item.color;
      ctx.strokeText(item.text, x, y); ctx.fillText(item.text, x, y);
    }
  }
  return {
    field,
    clock(value: number) { now = Math.max(now, Math.floor(value)); field.clock(now); },
    clear() { labels.clear(); coins.clear(); dust.clear(); trails.clear(); hits.clear(); sparks.clear(); byEnemy.clear(); towerPops.clear(); field.clear(); },
    towerScale(iid: number) {
      const at = towerPops.get(iid);
      if (at === undefined || !motion()) return 1;
      const elapsed = now - at;
      if (elapsed >= 250) { towerPops.delete(iid); return 1; }
      return 1 - 0.12 * springOffset(elapsed / 1000, 32, 14) * (1 - elapsed / 250);
    },
    flash(iid: number) { const hit = byEnemy.get(iid); return !!hit && now - hit.at < hit.flashMs; },
    impact(iid: number) { const hit = byEnemy.get(iid); return hit && now - hit.at < 120 ? hit : undefined; },
    frozen(hit: Hit) { return motion() && now < hit.frozenUntil; },
    squash(iid: number) {
      const hit = byEnemy.get(iid);
      return hit && hit.squash && motion() && now - hit.at < 120 ? hit.squash * springOffset((now - hit.at) / 1000, 44, 26) : 0;
    },
    health(ctx: CanvasRenderingContext2D, iid: number, hp: number, x: number, y: number, width: number, height: number) {
      if (hp >= 1) return;
      const hit = byEnemy.get(iid);
      const active = hit && hit.until > now;
      ctx.fillStyle = '#18212a';
      ctx.fillRect(x - 1, y - 1, width + 2, height + 2);
      ctx.fillStyle = '#f8f2df';
      ctx.fillRect(x, y, (width * (active ? whiteBar(hit, now) / barUnits : hp)) | 0, height);
      ctx.fillStyle = '#d45351';
      ctx.fillRect(x, y, (width * hp) | 0, height);
    },
    draw(ctx: CanvasRenderingContext2D, state: BattleState, project: Project, cellPx: number, color: string,
      fraction: number, aspect: number, lift: number) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.globalCompositeOperation = 'lighter';
      const animate = motion();
      const dense = state.projectiles.length > detailedProjectileLimit;
      drawProjectiles(ctx, state, project, cellPx, fraction, lift, animate, dense);
      if (!dense) for (const spark of sparks.items) {
        if (spark.until <= now) continue;
        drawWeaponHit(ctx, spark.weapon, project(spark.x, spark.y, a), project(spark.fromX, spark.fromY, b),
          (now - spark.at) / (spark.until - spark.at), animate);
      }
      ctx.globalCompositeOperation = 'source-over';
      field.landing(ctx, project, cellPx, aspect);
      field.blast(ctx, project);
      for (let i = 0; i < dust.items.length; i++) {
        const item = dust.items[i];
        if (item.until <= now) continue;
        const age = 1 - (item.until - now) / 360;
        const pt = project(item.x, item.y, a);
        ctx.globalAlpha = opacity((1 - age) * 0.55);
        ctx.fillStyle = '#cebc9b';
        ctx.beginPath(); ctx.arc((pt.x + item.vx * age) | 0, (pt.y + item.vy * age) | 0, (2 + age * 4) | 0, 0, Math.PI * 2); ctx.fill();
      }
      for (let i = 0; i < coins.items.length; i++) {
        const coin = coins.items[i];
        if (coin.until <= now) continue;
        const age = 1 - (coin.until - now) / 380;
        const pt = project(coin.x, coin.y, a);
        ctx.globalAlpha = opacity((1 - age) * 3);
        ctx.fillStyle = '#f2ca69';
        ctx.beginPath();
        ctx.ellipse((pt.x + (animate ? age * 10 : 0)) | 0, (pt.y - (animate ? 32 * age * (1 - age) : 0)) | 0, 3, 4.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      drawLabels(ctx, project, animate);
      ctx.restore();
    },
  };
}
export type BattleFx = ReturnType<typeof createBattleFx>;

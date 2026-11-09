import { CELL, type Cell, type ContentPack, type Projectile } from '../runtime';
import type { BattleBus } from './eventBus';
import { easeOut, springOffset, unit } from './motion';

type Project = (x: number, y: number, out: Cell) => Cell;

export function createFieldEffects(bus: BattleBus, motion: () => boolean) {
  const shots = new Map<number, { at: number; angle: number; x: number; y: number; casingAt: number }>();
  const beams = new Set<number>();
  const casings = Array.from({ length: 128 }, () => ({ at: -Infinity, x: 0, y: 0, angle: 0 }));
  const marks = Array.from({ length: 256 }, () => ({ at: -Infinity, x: 0, y: 0, angle: 0 }));
  const builds = Array.from({ length: 32 }, () => ({ at: -Infinity, x: 0, y: 0 }));
  let now = 0, nextCasing = 0, nextMark = 0, nextBuild = 0;
  let impactX = 0, impactY = 0, impactAt = -Infinity;
  let blastX = 0, blastY = 0, blastAngle = 0, blastAt = -Infinity;
  const point = { x: 0, y: 0 };

  bus.on('attack', (e) => {
    let shot = shots.get(e.tower);
    if (!shot) { shot = { at: now, angle: 0, x: 0, y: 0, casingAt: -Infinity }; shots.set(e.tower, shot); }
    shot.at = now; shot.x = e.tx; shot.y = e.ty;
    shot.angle = Math.atan2(e.ty - e.fy, e.tx - e.fx);
    if (!motion() || e.arcHeight < 600 || now - shot.casingAt < 150) return;
    shot.casingAt = now;
    const casing = casings[nextCasing++ & (casings.length - 1)];
    casing.at = now; casing.x = e.fx; casing.y = e.fy; casing.angle = shot.angle - 2.2;
  });
  bus.on('build_ok', (e) => {
    const build = builds[nextBuild++ & (builds.length - 1)];
    build.x = impactX = (e.x + 0.5) * CELL; build.y = impactY = (e.y + 0.5) * CELL;
    build.at = impactAt = now;
  });
  bus.on('damage_applied', (e) => {
    if (e.arcHeight < 600) return;
    blastX = e.x; blastY = e.y; blastAt = now;
    blastAngle = Math.atan2(e.y - e.fromY, e.x - e.fromX);
    if (now - impactAt < 180) return;
    impactX = e.x; impactY = e.y; impactAt = now;
  });
  bus.on('entity_died', (e) => {
    const mark = marks[nextMark++ & 255];
    mark.at = now; mark.x = e.x; mark.y = e.y; mark.angle = (e.iid % 31) * 0.49;
  });

  return {
    clock(time: number) { now = time; },
    clear() {
      shots.clear(); beams.clear(); impactAt = blastAt = -Infinity;
      for (const item of builds) item.at = -Infinity;
      for (const item of casings) item.at = -Infinity;
      for (const item of marks) item.at = -Infinity;
    },
    shot(iid: number) { return shots.get(iid); },
    shotAge(iid: number) { return now - (shots.get(iid)?.at ?? -Infinity); },
    trackBeams(projectiles: readonly Projectile[]) {
      beams.clear();
      for (const projectile of projectiles) {
        if (projectile.kind !== 'BEAM') continue;
        beams.add(projectile.source);
        const shot = shots.get(projectile.source);
        if (shot) { shot.x = projectile.to_x; shot.y = projectile.to_y; }
      }
    },
    beaming(iid: number) { return beams.has(iid); },
    recoil(at: number) {
      const age = now - at;
      return motion() && age < 180 ? springOffset(age / 1000, 32, 20) : 0;
    },
    flash(at: number) { return now - at < 35; },
    grid(ctx: CanvasRenderingContext2D, pack: ContentPack, px: number) {
      ctx.strokeStyle = 'rgba(181, 206, 200, .15)';
      ctx.lineWidth = 1;
      const seconds = (now - impactAt) / 1000;
      if (!motion() || seconds >= 0.34) return;
      const ox = impactX / CELL * px, oy = impactY / CELL * px;
      const impulse = springOffset(seconds, 24, 12) * 12;
      ctx.beginPath();
      for (const cell of pack.map.buildable_cells) {
        if (Math.hypot((cell.x + 0.5) * px - ox, (cell.y + 0.5) * px - oy) > 120 + px) continue;
        for (let corner = 0; corner < 4; corner++) {
          const x = cell.x * px + (corner === 0 || corner === 3 ? 5 : px - 5);
          const y = cell.y * px + (corner < 2 ? 5 : px - 5);
          const dx = x - ox, dy = y - oy, distance2 = dx * dx + dy * dy;
          const push = distance2 > 0 && distance2 < 14400 ? impulse * (1 / Math.sqrt(distance2) - 1 / 120) : 0;
          if (corner) ctx.lineTo(x + dx * push, y + dy * push);
          else ctx.moveTo(x + dx * push, y + dy * push);
        }
        ctx.closePath();
      }
      ctx.stroke();
    },
    landing(ctx: CanvasRenderingContext2D, project: Project, cellPx: number, aspect: number) {
      const animate = motion();
      ctx.save();
      ctx.strokeStyle = '#b2fce0'; ctx.lineWidth = 1.6;
      for (const build of builds) {
        const age = now - build.at;
        if (age >= 280) continue;
        const p = project(build.x, build.y, point);
        const r = (22 + (animate ? easeOut(age / 280) * 13 : 0)) * cellPx / 56;
        const corner = cellPx / 8;
        ctx.globalAlpha = (1 - age / 280) * 0.85;
        ctx.beginPath();
        for (const x of [-1, 1]) for (const y of [-1, 1]) {
          ctx.moveTo(p.x + x * (r - corner), p.y + y * r * aspect);
          ctx.lineTo(p.x + x * r, p.y + y * r * aspect);
          ctx.lineTo(p.x + x * r, p.y + y * (r - corner) * aspect);
        }
        ctx.stroke();
      }
      ctx.restore();
    },
    blast(ctx: CanvasRenderingContext2D, project: Project) {
      const age = now - blastAt;
      if (age >= 300) return;
      const p = project(blastX, blastY, point);
      const animate = motion();
      const fade = 1 - age / 300;
      const travel = animate ? easeOut(age / 300) : 0;
      ctx.save();
      ctx.translate(p.x, p.y - 4);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = fade * 0.75;
      ctx.strokeStyle = '#ffb76f'; ctx.lineWidth = 2 * fade;
      ctx.beginPath(); ctx.ellipse(0, 4, 7 + travel * 22, 4 + travel * 13, 0, 0, Math.PI * 2); ctx.stroke();
      if (animate) {
        ctx.rotate(blastAngle);
        ctx.strokeStyle = '#ffd7a0';
        ctx.beginPath();
        for (let i = 0; i < 9; i++) {
          const direction = i * 2.4, reach = (i % 3 + 2) * 8;
          const x = travel * (12 + Math.cos(direction) * reach);
          const y = travel * Math.sin(direction) * reach;
          ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(direction) * fade * 6, y + Math.sin(direction) * fade * 6);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = unit(1 - age / 78) * 0.86;
      ctx.fillStyle = '#fff4d7';
      ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(0, -10); ctx.lineTo(12, 0); ctx.lineTo(0, 8); ctx.closePath(); ctx.fill();
      ctx.restore();
    },
    marks(ctx: CanvasRenderingContext2D, project: Project) {
      ctx.save();
      ctx.fillStyle = '#0d0807';
      for (let i = 0; i < marks.length; i++) {
        const mark = marks[i], age = now - mark.at;
        if (age >= 11500) continue;
        const p = project(mark.x, mark.y, point);
        ctx.save();
        ctx.globalAlpha = 0.25 * (1 - Math.max(0, age - 10000) / 1500);
        ctx.translate(p.x, p.y); ctx.rotate(mark.angle);
        ctx.beginPath();
        ctx.moveTo(-13, 1); ctx.lineTo(-5, -6); ctx.lineTo(8, -4); ctx.lineTo(13, 2); ctx.lineTo(3, 6);
        ctx.closePath(); ctx.fill(); ctx.restore();
      }
      ctx.restore();
    },
    casings(ctx: CanvasRenderingContext2D, project: Project) {
      if (!motion()) return;
      ctx.save();
      ctx.fillStyle = '#bb9762';
      for (let fade = 0; fade < 2; fade++) {
        ctx.globalAlpha = fade ? 0.40 : 0.85;
        ctx.beginPath();
        for (let i = 0; i < casings.length; i++) {
          const casing = casings[i], elapsed = now - casing.at;
          if (elapsed >= 440 || Number(elapsed > 335) !== fade) continue;
          const t = elapsed / 1000;
          const lift = t < 0.23 ? 220 * t - 956.5 * t * t : Math.max(0, 68 * (t - 0.23) - 378 * (t - 0.23) ** 2);
          const p = project(casing.x, casing.y, point);
          const x = p.x + Math.cos(casing.angle) * t * 82, y = p.y + Math.sin(casing.angle) * t * 82 - 10 - lift;
          const dx = Math.cos(casing.angle + t * 23), dy = Math.sin(casing.angle + t * 23);
          ctx.moveTo((x - 2 * dx + dy) | 0, (y - 2 * dy - dx) | 0);
          ctx.lineTo((x + 2 * dx + dy) | 0, (y + 2 * dy - dx) | 0);
          ctx.lineTo((x + 2 * dx - dy) | 0, (y + 2 * dy + dx) | 0);
          ctx.lineTo((x - 2 * dx - dy) | 0, (y - 2 * dy + dx) | 0);
          ctx.closePath();
        }
        ctx.fill();
      }
      ctx.restore();
    },
  };
}

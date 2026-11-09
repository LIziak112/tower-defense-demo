import type { BattleState, ContentPack } from '../runtime';
import type { Palette } from './palettes';
import type { SpatialProjector } from './spatialMap';
import { rgba, spatialColors, type SpatialDrawOptions } from './spatialDrawing';
import { drawSpatialTrack } from './spatialTrack';
import { drawBastions, drawPads } from './spatialPads';
import { drawWeapon, weaponFor } from './weaponArt';

export function drawSpatialBattlefield(
  ctx: CanvasRenderingContext2D,
  state: BattleState,
  pack: ContentPack,
  theme: Palette,
  proj: SpatialProjector,
  opts: SpatialDrawOptions,
) {
  const { width, height } = ctx.canvas;
  // 1. 透明画布清屏：直接透出底下 #hub-view 的空间/平面皮肤地图，严禁绘制任何不透明底板或大矩形网格框
  ctx.clearRect(0, 0, width, height);

  const colors = spatialColors(theme);
  const { accent, ink, paper, danger, okColor } = colors;
  const aspectY = Math.max(0.52, Math.min(0.88, Math.sin(proj.pitch)));

  const waypoints = pack.map.path.map((c) => proj.cellToScreen(c.x + 0.5, c.y + 0.5));
  if (waypoints.length < 2) return;

  // 2. 场景地标与片区脉络微光引线（将宿主皮肤地图中的地标与防线终点/起点轻柔衔接）
  if (proj.hostMap) {
    const scaleX = width / Math.max(1, proj.hostMap.w);
    const scaleY = height / Math.max(1, proj.hostMap.h);
    const basePt = waypoints[waypoints.length - 1];
    ctx.save();
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = rgba(accent, 0.28);
    for (const lm of proj.hostMap.landmarks.slice(0, 4)) {
      const lx = lm.x * scaleX;
      const ly = lm.y * scaleY;
      const mx = (lx + basePt.x) * 0.5;
      const my = (ly + basePt.y) * 0.5 - 18;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.quadraticCurveTo(mx, my, basePt.x, basePt.y);
      ctx.stroke();
      ctx.fillStyle = rgba(accent, 0.24);
      ctx.beginPath();
      ctx.ellipse(lx, ly, 6, 6 * aspectY, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawSpatialTrack(ctx, waypoints, proj.cellPx, colors, aspectY, opts.now);
  drawBastions(ctx, state, proj, waypoints, colors, aspectY, opts.lang);
  drawPads(ctx, state, pack, proj, opts, colors, aspectY);
  opts.fx.field.marks(ctx, proj.milliToScreen);
  // 7. 已建防御塔（2.5D 等轴测立体炮座 + 转向炮管 + 徽章）
  for (const tw of state.towers) {
    const def = pack.towers.find((d) => d.id === tw.def)!;
    const center = proj.cellToScreen(tw.cx + 0.5, tw.cy + 0.5);
    const towerColor = tw.def === 'arcane' || tw.def === 'beam' ? '#90d7e1' : '#7bdfb9';
    const baseRad = Math.max(10, proj.cellPx * 0.25);
    const lift = Math.max(6, proj.cellPx * 0.16);

    const weapon = weaponFor(tw.def);
    const shot = opts.fx.field.shot(tw.iid);
    const target = shot && proj.milliToScreen(shot.x, shot.y);
    const aimAngle = target ? Math.atan2(target.y - center.y, target.x - center.x) : -Math.PI / 4;
    ctx.save();
    const scale = opts.fx.towerScale(tw.iid) * (1 + (opts.now ? Math.sin(opts.now * 0.0025) * 0.03 : 0));
    ctx.translate(center.x, center.y);
    ctx.scale(scale, scale);
    ctx.translate(-center.x, -center.y);

    // 塔座地面阴影
    ctx.fillStyle = 'rgba(10, 16, 24, 0.30)';
    ctx.beginPath();
    ctx.ellipse(center.x, center.y + 3, baseRad * 1.15, baseRad * 1.15 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    // 等轴测下层装甲底盘
    ctx.fillStyle = theme.tower ?? paper;
    ctx.strokeStyle = towerColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(center.x, center.y, baseRad, baseRad * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 2.5D 炮塔转台主体
    const turretY = center.y - lift;
    const turretR = Math.max(7.5, proj.cellPx * 0.18);

    if (!weapon) {
      ctx.strokeStyle = towerColor;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(center.x, turretY);
      ctx.lineTo(center.x + Math.cos(aimAngle) * (turretR * 1.45), turretY + Math.sin(aimAngle) * (turretR * 1.45));
      ctx.stroke();
    }

    // 炮塔圆顶
    ctx.fillStyle = towerColor;
    ctx.strokeStyle = paper;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(center.x, turretY, turretR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (weapon) {
      ctx.save();
      ctx.translate(center.x, turretY);
      ctx.rotate(aimAngle);
      ctx.scale(proj.cellPx / 56, proj.cellPx / 56);
      drawWeapon(ctx, weapon, opts.fx.field.shotAge(tw.iid), opts.fx.field.beaming(tw.iid), !!opts.now);
      ctx.restore();
    }
    ctx.fillStyle = paper;
    ctx.font = 'bold 10px "IBM Plex Sans", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tw.level ? String(tw.level) : def.display_name[0], center.x, weapon ? center.y + 4 : turretY + 0.5);
    ctx.restore();
  }

  // 8. 行军中的敌军与圆角生命条（带地面椭圆阴影与立体护甲剪影）
  for (const e of state.enemies) {
    const def = pack.enemies.find((d) => d.id === e.def)!;
    const hit = opts.fx.impact(e.iid), frozen = !!hit && opts.fx.frozen(hit);
    const pt = proj.milliToScreen(frozen ? hit.x : e.x, frozen ? hit.y : e.y);
    const r = Math.max(6.5, proj.cellPx * 0.17);
    ctx.save();

    // 地面椭圆阴影
    ctx.fillStyle = 'rgba(10, 16, 24, 0.28)';
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y + 3, r * 0.95, r * 0.95 * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    const liftY = pt.y - 3;
    const squash = opts.fx.squash(e.iid);
    ctx.save();
    ctx.translate(pt.x, liftY);
    if (squash && hit) {
      const from = proj.milliToScreen(hit.fromX, hit.fromY);
      const angle = Math.atan2(pt.y - from.y, pt.x - from.x);
      ctx.rotate(angle); ctx.scale(1 - squash, 1 + squash); ctx.rotate(-angle);
    }
    ctx.fillStyle = opts.fx.flash(e.iid) ? '#fff' : def.armor ? '#bb9347' : '#e77e6b';
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.2); ctx.lineTo(r * 0.95, 0); ctx.lineTo(0, r * 0.85); ctx.lineTo(-r * 0.95, 0);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = def.armor ? '#e3e9ec' : '#6b3930'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    opts.fx.health(ctx, e.iid, e.hp / (e.max_hp ?? def.hp), pt.x - 13, liftY - r * 1.2 - 8, 26, 4);
    ctx.restore();
  }

  // 10. 胜负结算横幅
  if (state.phase === 'won' || state.phase === 'lost') {
    ctx.save();
    const bannerW = Math.min(360, width - 40);
    const bannerH = 68;
    const bx = (width - bannerW) / 2;
    const by = (height - bannerH) / 2;
    ctx.fillStyle = rgba(paper, 0.94, '36,46,64');
    ctx.strokeStyle = state.phase === 'won' ? okColor : danger;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bx, by, bannerW, bannerH, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = 'bold 28px "IBM Plex Sans", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(state.phase === 'won' ? opts.heldText : opts.fellText, width / 2, height / 2);
    ctx.restore();
  }
}

import type { Cell } from '../runtime';
import { rgba, type SpatialColors } from './spatialDrawing';

export function drawSpatialTrack(ctx: CanvasRenderingContext2D, waypoints: Cell[], cellPx: number, colors: SpatialColors, aspectY: number, now: number) {
  const { accent, ink, paper, roadColor, roadAlt, hair } = colors;
  // 3. 五层 2.5D 等轴测立体轨道（Spline Track & Dual Rails with 3D Extruded Side Wall & Ambient Shadow）
  const trackW = Math.max(20, cellPx * 0.54);
  const innerW = Math.max(14, cellPx * 0.38);
  const railOffset = Math.max(7.5, cellPx * 0.22);
  const deckThickness = Math.max(4.5, cellPx * 0.11);

  const traceCenterPath = (offsetX = 0, offsetY = 0) => {
    ctx.beginPath();
    ctx.moveTo(waypoints[0].x + offsetX, waypoints[0].y + offsetY);
    for (let i = 1; i < waypoints.length; i++) {
      ctx.lineTo(waypoints[i].x + offsetX, waypoints[i].y + offsetY);
    }
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // (3.1) 第 1 层：地面柔和环境光遮蔽阴影（Ambient Occlusion Shadow）+ 2.5D 立体侧壁（Extruded Side Wall）
  ctx.save();
  ctx.shadowColor = 'rgba(8, 12, 20, 0.38)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 5;
  traceCenterPath(0, deckThickness);
  ctx.strokeStyle = rgba(ink, 0.68, '36,46,58');
  ctx.lineWidth = trackW + 3;
  ctx.stroke();
  ctx.restore();

  // 立体下缘暗部侧墙（表现出石板/栈道高出地面的 3D 厚度）
  for (let d = deckThickness; d >= 1.5; d -= 1.5) {
    traceCenterPath(0, d);
    ctx.strokeStyle = rgba(ink, 0.52, '42,52,64');
    ctx.lineWidth = trackW + 2;
    ctx.stroke();
  }

  // (3.2) 第 2 层：立体受光顶面路基与内层装甲轨床
  traceCenterPath(0, 0);
  ctx.strokeStyle = rgba(paper, 0.65, '240,244,240');
  ctx.lineWidth = trackW + 1.5;
  ctx.stroke();

  traceCenterPath(0, 0);
  ctx.strokeStyle = rgba(roadColor, 0.92, '113,126,125');
  ctx.lineWidth = trackW - 1.5;
  ctx.stroke();

  traceCenterPath(0, 0);
  ctx.strokeStyle = rgba(roadAlt, 0.82, '88,100,102');
  ctx.lineWidth = innerW;
  ctx.stroke();

  // (3.3) 第 3 层：等轴测立体轨枕石板（Beveled Sleepers）与双侧平行立体护栏导轨（Dual 3D Rails）
  const sleeperStep = Math.max(10, cellPx * 0.25);
  const sleeperHalf = railOffset * 0.88;

  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1) continue;
    const ux = dx / segLen, uy = dy / segLen;
    const nx = -uy, ny = ux;

    // 轨枕暗影槽与亮面横档（一明一暗形成真实凹凸雕刻感）
    for (let d = sleeperStep * 0.6; d < segLen - sleeperStep * 0.4; d += sleeperStep) {
      const px = a.x + ux * d;
      const py = a.y + uy * d;
      ctx.strokeStyle = rgba(ink, 0.36);
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(px - nx * sleeperHalf, py - ny * sleeperHalf + 1.2);
      ctx.lineTo(px + nx * sleeperHalf, py + ny * sleeperHalf + 1.2);
      ctx.stroke();

      ctx.strokeStyle = rgba(paper, 0.42, '245,248,245');
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(px - nx * sleeperHalf, py - ny * sleeperHalf);
      ctx.lineTo(px + nx * sleeperHalf, py + ny * sleeperHalf);
      ctx.stroke();
    }

    // 左右双平行立体护栏导轨（含侧壁暗影 + 主轨色 + 顶部受光高光）
    for (const sign of [-1, 1]) {
      const rx0 = a.x + nx * railOffset * sign;
      const ry0 = a.y + ny * railOffset * sign;
      const rx1 = b.x + nx * railOffset * sign;
      const ry1 = b.y + ny * railOffset * sign;

      ctx.beginPath();
      ctx.moveTo(rx0, ry0 + 2);
      ctx.lineTo(rx1, ry1 + 2);
      ctx.strokeStyle = rgba(ink, 0.55);
      ctx.lineWidth = 3.2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(rx0, ry0);
      ctx.lineTo(rx1, ry1);
      ctx.strokeStyle = rgba(accent, 0.88);
      ctx.lineWidth = 2.2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(rx0, ry0 - 0.8);
      ctx.lineTo(rx1, ry1 - 0.8);
      ctx.strokeStyle = rgba(paper, 0.55, '255,255,255');
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }
  }

  // 折角枢纽立体转盘（带 3D 底座厚度与内环铆钉）
  for (let i = 1; i < waypoints.length - 1; i++) {
    const wp = waypoints[i];
    const r = railOffset * 0.98;
    ctx.fillStyle = rgba(ink, 0.55);
    ctx.beginPath();
    ctx.ellipse(wp.x, wp.y + 2.5, r, r * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = rgba(roadAlt, 0.95);
    ctx.strokeStyle = rgba(accent, 0.85);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(wp.x, wp.y, r, r * aspectY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // (3.4) 第 4 层：轨道中央发光能量导引槽与动态流光脉冲
  ctx.save();
  ctx.shadowColor = accent;
  ctx.shadowBlur = 6;
  traceCenterPath(0, 0);
  ctx.strokeStyle = rgba(accent, 0.48);
  ctx.lineWidth = 4.5;
  ctx.stroke();
  ctx.restore();

  traceCenterPath(0, 0);
  ctx.strokeStyle = rgba(paper, 0.90, '255,255,255');
  ctx.lineWidth = 2.0;
  ctx.setLineDash([8, 10]);
  ctx.lineDashOffset = -((now * 0.032) % 18);
  ctx.stroke();
  ctx.setLineDash([]);

  // 沿途动态流光方向标（Chevrons）
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 24) continue;
    const ang = Math.atan2(dy, dx);
    const sz = Math.max(4.5, cellPx * 0.11);
    const phase = ((now * 0.045) % 42) / 42;
    const tPos = 0.25 + phase * 0.5;
    const mx = a.x + dx * tPos;
    const my = a.y + dy * tPos;
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(-sz, -sz * 0.75);
    ctx.lineTo(sz * 0.55, 0);
    ctx.lineTo(-sz, sz * 0.75);
    ctx.strokeStyle = rgba(paper, 0.95, '255,255,255');
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

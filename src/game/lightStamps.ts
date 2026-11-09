let muzzle: HTMLCanvasElement | undefined;

export function drawMuzzle(ctx: CanvasRenderingContext2D, x: number, y: number) {
  if (!muzzle) {
    muzzle = document.createElement('canvas'); muzzle.width = muzzle.height = 32;
    const painter = muzzle.getContext('2d')!;
    painter.translate(16, 16);
    painter.fillStyle = '#fff4cc';
    painter.shadowColor = '#fbd99b'; painter.shadowBlur = 6;
    painter.beginPath();
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6, radius = i % 2 ? 2.5 : 8;
      painter.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    painter.closePath(); painter.fill();
  }
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(muzzle, x - 16, y - 16);
  ctx.globalCompositeOperation = 'source-over';
}

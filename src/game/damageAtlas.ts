const maximum = 160;
const rowsPerKind = maximum + 1;
const columns = 16;
const width = 64, height = 28;
export const damageSprite = (amount: number, critical: boolean) => amount <= maximum ? amount + (critical ? rowsPerKind : 0) : -1;
export const goldSprite = (amount: number) => amount <= maximum ? amount + rowsPerKind * 2 : -1;

export function createDamageAtlas() {
  const atlas = document.createElement('canvas');
  atlas.width = width * columns;
  atlas.height = height * Math.ceil(rowsPerKind * 3 / columns);
  const ctx = atlas.getContext('2d')!;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#151b24';
  ctx.textAlign = 'center';
  for (let i = 0; i < rowsPerKind * 3; i++) {
    const kind = Math.floor(i / rowsPerKind);
    const text = `${kind === 2 ? '+' : '−'}${i % rowsPerKind}`;
    ctx.fillStyle = kind === 2 ? '#ffe29b' : kind === 1 ? '#fff0a7' : '#ffe3af';
    ctx.font = kind === 1 ? 'bold 19.5px system-ui' : 'bold 13px system-ui';
    const x = (i % columns) * width + width / 2, y = Math.floor(i / columns) * height + 21;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }
  return (target: CanvasRenderingContext2D, index: number, x: number, y: number) => {
    target.drawImage(atlas, (index % columns) * width, Math.floor(index / columns) * height, width, height,
      Math.round(x - width / 2), Math.round(y - 21), width, height);
  };
}

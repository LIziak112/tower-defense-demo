// 测试用的宿主相机：按 Hikos 三维引擎（three.js 正交相机，由 focus / azimuth / pitch / zoom / span 决定）的同一套几何，
// 手算「世界坐标 → 舞台 CSS 像素」的 4×4 行主序矩阵——也就是宿主 hikos:camera 里的 m。
// 相机位置 = focus + (sin a·cos p, sin p, cos a·cos p)·距离，看向 focus；正交半高 = span / zoom。

export interface CameraSpec {
  w: number;
  h: number;
  azimuth?: number;
  pitch?: number;
  zoom?: number;
  /** 缩放为 1 时的正交半高（世界单位）；宿主按场景大小定 */
  span?: number;
  focus?: [number, number, number];
  seq?: number;
}

export function orthoCamera(spec: CameraSpec) {
  const { w, h } = spec;
  const a = spec.azimuth ?? -0.38, p = spec.pitch ?? 0.78, zoom = spec.zoom ?? 1, span = spec.span ?? 60;
  const [fx, fy, fz] = spec.focus ?? [0, 0, 0];
  const ppu = (h * zoom) / (2 * span);
  // 相机的右、上两个轴（世界坐标）
  const r = [Math.cos(a), 0, -Math.sin(a)];
  const u = [-Math.sin(a) * Math.sin(p), Math.cos(p), -Math.cos(a) * Math.sin(p)];
  const dot = (v: number[]) => v[0] * fx + v[1] * fy + v[2] * fz;
  const m = [
    ppu * r[0], ppu * r[1], ppu * r[2], w / 2 - ppu * dot(r),
    -ppu * u[0], -ppu * u[1], -ppu * u[2], h / 2 + ppu * dot(u),
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  return { type: 'hikos:camera', v: 1, seq: spec.seq ?? 1, w, h, m, ppu, azimuth: a, pitch: p, zoom };
}

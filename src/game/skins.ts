// Hikos 城市皮肤 → 游戏配色。数值来自接入说明 01_1b297d9c §2.2 / §3.3 / §3.4（宿主场景源码里的字面量），四款第一批开放皮肤。
// 注意：这是「配色占位」——宿主场景没有位图，精灵图资产包（任务 435686a6 / 请求 9a9a3ab3）到了再接；在那之前塔 / 敌 / 地块都是按这些色值程序化绘制。
import type { HostContext, HostTheme } from './hikos';
import type { Palette } from './palettes';

export interface SkinSpec {
  id: string;
  name: { zh: string; en: string };
  base: HostTheme;
  /** UI 变量（--k-acc / --k-bg / --k-ink / 纸 / 发丝线） */
  accent: string; bg: string; ink: string; paper: string; hair: string;
  /** 敌人路径用道路色（§3.4），可建地块用地块板 / 铺装两色交错，塔身用建筑主体色 */
  road: string; plot: string; paving: string; body: string;
  /** 皮肤的有效 / 无效色：生命条 / 敌人 */
  ok: string; danger: string;
}

export const HIKOS_SKINS: Record<string, SkinSpec> = {
  'union-atlas-3d': {
    id: 'union-atlas-3d', name: { zh: '共和国 · 工业沙盘', en: 'Union Industrial Atlas' }, base: 'day',
    accent: '#a72e25', bg: '#f2ebdd', ink: '#393e38', paper: '#faf6e8', hair: '#d8cfbb',
    road: '#c7c6b2', plot: '#dedac8', paving: '#d2ccb7', body: '#f1ecdc', ok: '#577f68', danger: '#b4382c',
  },
  'metropolis-riverside-3d': {
    id: 'metropolis-riverside-3d', name: { zh: '都会 · 河岸', en: 'Riverside Metropolis' }, base: 'day',
    accent: '#356d73', bg: '#e8ede7', ink: '#354e52', paper: '#f3f5eb', hair: '#c7d3cc',
    road: '#717e7d', plot: '#e9e9da', paving: '#d8dbd1', body: '#e9e9da', ok: '#477b69', danger: '#b95d50',
  },
  'gothic-cathedral-3d': {
    id: 'gothic-cathedral-3d', name: { zh: '暮钟 · 圣堂', en: 'Vesper Cathedral' }, base: 'night',
    accent: '#e4c596', bg: '#182333', ink: '#e6e1da', paper: '#242e40', hair: '#435065',
    road: '#676c77', plot: '#74747d', paving: '#525866', body: '#827d92', ok: '#9bcebe', danger: '#f28c88',
  },
  'harbor-district-3d': {
    id: 'harbor-district-3d', name: { zh: '潮汐 · 港湾片区', en: 'Tidal Harbor Districts' }, base: 'day',
    accent: '#256e7c', bg: '#e0e9e7', ink: '#254452', paper: '#eff6ef', hair: '#b6cecd',
    road: '#9f8c70', plot: '#d7d5c6', paving: '#c9c7b8', body: '#d7d5c6', ok: '#338a72', danger: '#c26b55',
  },
};

/** 宿主没给 skin（或不认识）时的兜底：accent 缺省 1450e8（接入说明 §1.5），bg / ink 跟随 theme。 */
const FALLBACK: Record<HostTheme, { bg: string; ink: string; paper: string; hair: string }> = {
  day: { bg: '#eef0ea', ink: '#2a2f33', paper: '#f7f8f3', hair: '#cfd5cc' },
  night: { bg: '#141a24', ink: '#e4e6ea', paper: '#1d2533', hair: '#3b4657' },
};
export const DEFAULT_ACCENT = '#1450e8';
/** 宿主规则：敌人用 ui.status.danger（四款都是 #C03221）、生命用 ui.status.ok；琥珀 / 暖金只代表人，不给敌人 */
const STATUS = { ok: '#178a55', danger: '#c03221' };

function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
}
/** a 向 b 混 t（0–1） */
export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

/** 宿主上下文 → 一套皮肤规格（已知皮肤取字面量，否则从 accent/bg/ink/theme 推） */
export function skinForContext(ctx: HostContext): SkinSpec {
  const known = ctx.skin ? HIKOS_SKINS[ctx.skin] : undefined;
  if (known) {
    // 宿主运行中给的 accent/bg/ink 优先（皮肤改色时宿主会同步），没给就用说明里的字面量
    return { ...known, accent: ctx.accent ?? known.accent, bg: ctx.bg ?? known.bg, ink: ctx.ink ?? known.ink };
  }
  const f = FALLBACK[ctx.theme];
  const bg = ctx.bg ?? f.bg, ink = ctx.ink ?? f.ink, accent = ctx.accent ?? DEFAULT_ACCENT;
  const night = ctx.theme === 'night';
  return {
    id: ctx.skin ?? 'generic', name: ctx.name ?? { zh: '通用', en: 'Generic' }, base: ctx.theme,
    accent, bg, ink,
    paper: ctx.bg ? mix(bg, night ? '#ffffff' : '#ffffff', night ? 0.06 : 0.45) : f.paper,
    hair: mix(bg, ink, 0.22),
    road: mix(bg, ink, 0.38), plot: mix(bg, ink, 0.05), paving: mix(bg, ink, 0.11),
    body: night ? mix(bg, ink, 0.42) : mix(bg, '#ffffff', 0.55),
    ok: STATUS.ok, danger: STATUS.danger,
  };
}

/** 皮肤规格 → 画布调色板（palettes.ts 的 Palette，带可选扩展字段） */
export function paletteForSkin(s: SkinSpec): Palette {
  const night = s.base === 'night';
  // 道路色与地块色在宿主场景里本就相近（都是城市地面），棋盘上要能一眼看出敌人路径：把路面向墨色压 12% / 20%，色相不变
  return {
    bg: s.bg,
    path: mix(s.road, s.ink, 0.12),
    pathAlt: mix(s.road, s.ink, 0.2),
    grid1: s.plot,
    grid2: s.paving,
    base: s.accent,
    shot: night ? mix(s.accent, '#ffffff', 0.25) : s.accent,
    text: s.ink,
    accent: s.accent, paper: s.paper, ink: s.ink, hair: s.hair, tower: s.body, ok: s.ok, danger: s.danger,
  };
}

export function paletteForContext(ctx: HostContext): Palette {
  return paletteForSkin(skinForContext(ctx));
}

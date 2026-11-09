export type Palette = {
  bg: string;
  path: string;
  pathAlt: string;
  grid1: string;
  grid2: string;
  base: string;
  shot: string;
  text: string;
  /** 以下是 Hikos 皮肤（skins.ts）带的扩展字段；内置三套没有，渲染时按旧配色兜底 */
  accent?: string;
  paper?: string;
  ink?: string;
  hair?: string;
  tower?: string;
  ok?: string;
  danger?: string;
};

export const PALETTES: Record<string, Palette> = {
  default: {
    bg: '#111920',
    paper: '#1e2b34',
    hair: '#41515a',
    accent: '#f1cf8d',
    path: 'hsl(192 16% 18%)',
    pathAlt: 'hsl(192 16% 15%)',
    grid1: 'hsl(192 16% 12%)',
    grid2: 'hsl(192 16% 12%)',
    base: '#e9c785',
    shot: '#fff0c8',
    text: '#f2eee4'
  },
  neon: {
    bg: '#090a0f',
    path: 'hsl(220 22% 18%)',
    pathAlt: 'hsl(220 22% 15%)',
    grid1: 'hsl(220 22% 12%)',
    grid2: 'hsl(220 22% 12%)',
    base: '#00ffcc',
    shot: '#ffd9fb',
    text: '#00ffff'
  },
  retro: {
    bg: '#2b2b2b',
    path: 'hsl(42 14% 18%)',
    pathAlt: 'hsl(42 14% 15%)',
    grid1: 'hsl(42 14% 12%)',
    grid2: 'hsl(42 14% 12%)',
    base: '#ffeb3b',
    shot: '#ffe2c9',
    text: '#ffffff'
  }
};

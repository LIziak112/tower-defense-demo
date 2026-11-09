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
    bg: '#1b2430',
    path: '#5a4a36',
    pathAlt: '#4c3f2d',
    grid1: '#26323f',
    grid2: '#2b3846',
    base: '#d8b45a',
    shot: '#ffe9a0',
    text: '#ffffff'
  },
  neon: {
    bg: '#090a0f',
    path: '#160029',
    pathAlt: '#1a0033',
    grid1: '#0d0d1a',
    grid2: '#121224',
    base: '#00ffcc',
    shot: '#ff00ff',
    text: '#00ffff'
  },
  retro: {
    bg: '#2b2b2b',
    path: '#a3a3a3',
    pathAlt: '#8e8e8e',
    grid1: '#3c3c3c',
    grid2: '#333333',
    base: '#ffeb3b',
    shot: '#ff5722',
    text: '#ffffff'
  }
};

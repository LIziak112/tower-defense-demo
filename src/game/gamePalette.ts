import type { Palette } from './palettes';

export function applyGamePalette(theme: Palette, hostTheme: 'day' | 'night', insitu: boolean, skin: string | null, lang: 'zh' | 'en') {
  const r = document.documentElement.style;
  r.setProperty('--td-bg', theme.bg);
  r.setProperty('--td-paper', theme.paper ?? '#2b3846');
  r.setProperty('--td-ink', theme.ink ?? theme.text);
  r.setProperty('--td-hair', theme.hair ?? '#555');
  r.setProperty('--td-accent', theme.accent ?? '#ffd36a');
  r.setProperty('--td-danger', theme.danger ?? '#ff9a8a');
  r.setProperty('--td-ok', theme.ok ?? '#338a72');
  const effectiveTheme = hostTheme;
  document.documentElement.dataset.theme = effectiveTheme;
  r.colorScheme = effectiveTheme === 'night' ? 'dark' : 'light';
  document.documentElement.dataset.insitu = insitu ? 'true' : 'false';
  if (skin) document.documentElement.dataset.skin = skin;
  document.documentElement.lang = lang;
}

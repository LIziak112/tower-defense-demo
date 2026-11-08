import { describe, it, expect } from 'vitest';
import { contextFromMessage, contextFromQuery, createHostBridge, DEFAULT_CONTEXT, hostOrigin, parseHex, parseSkin } from '../../src/game/hikos';
import { HIKOS_SKINS, paletteForContext, skinForContext, DEFAULT_ACCENT, mix } from '../../src/game/skins';

describe('hikos URL query（接入说明 §1.5）', () => {
  it('宿主拼的完整 query 全部解析', () => {
    const c = contextFromQuery('?v=1&skin=union-atlas-3d&accent=a72e25&bg=f2ebdd&ink=393e38&theme=day&lang=zh');
    expect(c).toEqual({ ...DEFAULT_CONTEXT, skin: 'union-atlas-3d', accent: '#a72e25', bg: '#f2ebdd', ink: '#393e38', theme: 'day', lang: 'zh' });
  });
  it('hex 只认 6 位，其它用缺省（null）', () => {
    expect(parseHex('a72e25')).toBe('#a72e25');
    expect(parseHex('#A72E25')).toBe('#a72e25');
    expect(parseHex('abc')).toBeNull();
    expect(parseHex('red')).toBeNull();
    expect(parseHex('a72e25; background:url(x)')).toBeNull();
    expect(parseHex(undefined)).toBeNull();
  });
  it('theme / lang 越界回缺省；不认识的协议版本按 1', () => {
    const c = contextFromQuery('?v=7&theme=dusk&lang=fr');
    expect(c.v).toBe(1); expect(c.theme).toBe('day'); expect(c.lang).toBe('zh');
    expect(contextFromQuery('?theme=night&lang=en')).toMatchObject({ theme: 'night', lang: 'en' });
  });
  it('skin 只认 kebab 小写', () => {
    expect(parseSkin('gothic-cathedral-3d')).toBe('gothic-cathedral-3d');
    expect(parseSkin('<img src=x>')).toBeNull();
    expect(parseSkin('')).toBeNull();
  });
});

describe('hikos:context 合并（§1.6，字段只增不改）', () => {
  const base = contextFromQuery('?skin=union-atlas-3d&accent=a72e25&theme=day&lang=zh');
  it('带全字段的 context 覆盖，并带上显示名与 reducedMotion', () => {
    const c = contextFromMessage({ type: 'hikos:context', v: 1, skin: 'gothic-cathedral-3d', name: { zh: '暮钟 · 圣堂', en: 'Vesper Cathedral' }, accent: 'e4c596', bg: '182333', ink: 'e6e1da', theme: 'night', lang: 'en', reducedMotion: true }, base);
    expect(c).toMatchObject({ skin: 'gothic-cathedral-3d', accent: '#e4c596', bg: '#182333', ink: '#e6e1da', theme: 'night', lang: 'en', reducedMotion: true });
    expect(c.name).toEqual({ zh: '暮钟 · 圣堂', en: 'Vesper Cathedral' });
  });
  it('缺字段保留上一次；非法值不污染', () => {
    const c = contextFromMessage({ type: 'hikos:context', lang: 'en' }, base);
    expect(c.skin).toBe('union-atlas-3d'); expect(c.accent).toBe('#a72e25'); expect(c.lang).toBe('en');
    expect(contextFromMessage('garbage', base)).toBe(base);
    expect(contextFromMessage({ theme: 'x', accent: 'nope' }, base)).toMatchObject({ theme: 'day', accent: null });
  });
});

describe('宿主源（§1.6 源校验）', () => {
  it('同源托管：宿主源 = 自己的 location.origin', () => {
    expect(hostOrigin('?v=1', 'https://space.hikos.cn')).toBe('https://space.hikos.cn');
  });
  it('联调才允许 ?host= 覆盖：游戏自己在 localhost 上，且目标也只认 localhost / 127.0.0.1', () => {
    expect(hostOrigin('?host=http://localhost:5173', 'http://localhost:4173')).toBe('http://localhost:5173');
    expect(hostOrigin('?host=http://127.0.0.1:8080', 'http://localhost:4173')).toBe('http://127.0.0.1:8080');
    expect(hostOrigin('?host=https://evil.example', 'http://localhost:4173')).toBe('http://localhost:4173');
    expect(hostOrigin('?host=http://localhost.evil.example', 'http://localhost:4173')).toBe('http://localhost:4173');
    // 线上（非 localhost）一律忽略 ?host=
    expect(hostOrigin('?host=http://localhost:5173', 'https://space.hikos.cn')).toBe('https://space.hikos.cn');
    expect(hostOrigin('?host=https://evil.example', 'https://space.hikos.cn')).toBe('https://space.hikos.cn');
  });
});

describe('皮肤配色（§2.2 / §3.3 / §3.4）', () => {
  it('四款开放皮肤都有规格，且 UI 变量与接入说明一致', () => {
    expect(Object.keys(HIKOS_SKINS).sort()).toEqual(['gothic-cathedral-3d', 'harbor-district-3d', 'metropolis-riverside-3d', 'union-atlas-3d']);
    expect(HIKOS_SKINS['union-atlas-3d']).toMatchObject({ accent: '#a72e25', bg: '#f2ebdd', ink: '#393e38', base: 'day' });
    expect(HIKOS_SKINS['metropolis-riverside-3d']).toMatchObject({ accent: '#356d73', bg: '#e8ede7', ink: '#354e52' });
    expect(HIKOS_SKINS['gothic-cathedral-3d']).toMatchObject({ accent: '#e4c596', bg: '#182333', ink: '#e6e1da', base: 'night' });
    expect(HIKOS_SKINS['harbor-district-3d']).toMatchObject({ accent: '#256e7c', bg: '#e0e9e7', ink: '#254452' });
  });
  it('已知皮肤：敌人路径用道路色、基地 / 选中用 accent、文字用墨色', () => {
    const p = paletteForContext(contextFromQuery('?skin=union-atlas-3d'));
    expect(p.path).toBe(mix('#c7c6b2', '#393e38', 0.12)); expect(p.base).toBe('#a72e25'); expect(p.text).toBe('#393e38'); expect(p.tower).toBe('#f1ecdc');
    expect(p.path).not.toBe(p.grid1); expect(p.path).not.toBe(p.grid2);
  });
  it('宿主运行中给的 accent/bg/ink 覆盖字面量', () => {
    const s = skinForContext(contextFromQuery('?skin=union-atlas-3d&accent=123456'));
    expect(s.accent).toBe('#123456'); expect(s.bg).toBe('#f2ebdd');
  });
  it('不认识的皮肤 / 没给皮肤：accent 缺省 1450e8，bg/ink 跟随 theme，敌人用 danger 不用琥珀', () => {
    const day = paletteForContext(contextFromQuery('?skin=some-new-skin'));
    expect(day.accent).toBe(DEFAULT_ACCENT); expect(day.danger).toBe('#c03221');
    const night = paletteForContext(contextFromQuery('?theme=night&accent=ff8800'));
    expect(night.accent).toBe('#ff8800'); expect(night.bg).toBe('#141a24');
    const custom = paletteForContext(contextFromQuery('?accent=112233&bg=f0f0f0&ink=101010'));
    expect(custom.bg).toBe('#f0f0f0'); expect(custom.text).toBe('#101010');
    for (const p of [day, night, custom]) for (const v of Object.values(p)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('出站顺序（§1.6：td:ready 是第一条）', () => {
  function fakeWindow(embedded: boolean) {
    const sent: Record<string, unknown>[] = [];
    const parent = { postMessage: (m: Record<string, unknown>) => { sent.push(m); } };
    const win: Record<string, unknown> = {
      location: { search: '?v=1&skin=union-atlas-3d', origin: 'https://space.hikos.cn' },
      addEventListener() {}, removeEventListener() {},
    };
    win.parent = embedded ? parent : win;
    return { win: win as unknown as Window, sent };
  }
  it('ready 之前报的状态先记着，ready 后紧跟补发一条；之后状态去重', () => {
    const { win, sent } = fakeWindow(true);
    const b = createHostBridge(win);
    b.state('playing');
    expect(sent).toEqual([]);
    b.ready(); b.ready();
    b.state('playing'); b.state('paused');
    expect(sent.map((m) => m.type)).toEqual(['td:ready', 'td:state', 'td:state']);
    expect(sent[0]).toEqual({ type: 'td:ready', v: 1 });
    expect(sent[1]).toEqual({ type: 'td:state', state: 'playing' });
    expect(sent[2]).toEqual({ type: 'td:state', state: 'paused' });
  });
  it('独立打开（不在 iframe 里）什么都不发', () => {
    const { win, sent } = fakeWindow(false);
    const b = createHostBridge(win);
    b.state('playing'); b.ready(); b.exit();
    expect(b.embedded).toBe(false);
    expect(sent).toEqual([]);
  });
});

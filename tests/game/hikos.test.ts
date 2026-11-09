import { sanitizeLlmPack } from '../../src/content/sanitize';
import { describe, it, expect } from 'vitest';
import { contextFromMessage, contextFromQuery, createHostBridge, DEFAULT_CONTEXT, hostOrigin, parseHex, parseSkin } from '../../src/game/hikos';
import { HIKOS_SKINS, paletteForContext, skinForContext, DEFAULT_ACCENT, mix } from '../../src/game/skins';
import { createSpatialProjector, parseSpatialMap } from '../../src/game/spatialMap';
import { cleanTechTerms, extractNaturalAdvisorSpeech, normalizeLlmAdvice } from '../../src/game/chatFormat';
import { validatePack } from '../../src/content/validate';
import { parseAdvice } from '../../src/advisor/types';
import { DEFAULT_PACK } from '../../src/content/default';
import { slotCell } from '../../src/advisor/snapshot';

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
  it('advisor.agent 携带频道在岗智能体姓名、头衔、头像与人设提示词，且后续消息缺省保留', () => {
    const c1 = contextFromMessage({
      type: 'hikos:context',
      v: 1,
      advisor: {
        enabled: true,
        provider: 'hikos',
        agent: { name: '姜尚', title: '太公', avatar: 'data:image/svg+xml,<svg/>', color: '356d73', persona: '奇正相生，稳守反击。' },
      },
    }, base);
    expect(c1.advisor).toEqual({
      enabled: true,
      provider: 'hikos',
      agent: { name: '姜尚', title: '太公', avatar: 'data:image/svg+xml,<svg/>', color: '#356d73', persona: '奇正相生，稳守反击。' },
    });
    const c2 = contextFromMessage({ type: 'hikos:context', v: 1, advisor: { enabled: false, provider: null } }, c1);
    expect(c2.advisor?.enabled).toBe(false);
    expect(c2.advisor?.agent?.name).toBe('姜尚');
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

describe('空间皮肤地图原位投影（任务 94bbcebe：外部坐标与等轴测正逆映射）', () => {
  it('hikos:context 与 hikos:map 解析空间场景地标、节点与相机姿态', () => {
    const base = contextFromQuery('?v=1&skin=metropolis-riverside-3d&insitu=1');
    expect(base.insitu).toBe(true);
    const merged = contextFromMessage({
      type: 'hikos:context',
      v: 1,
      insitu: true,
      map: {
        skin: 'metropolis-riverside-3d',
        layout: 'river-grid',
        w: 1440,
        h: 856,
        azimuth: -0.38,
        pitch: 0.78,
        zoom: 1.2,
        center: { x: 740, y: 420 },
        home: { key: 'home', kind: 'landmark', label: '母星', x: 740, y: 420, wx: 0, wz: 0 },
        landmarks: [{ key: 'home', kind: 'landmark', label: '母星', x: 740, y: 420, wx: 0, wz: 0 }],
        nodes: [{ key: 'channel:mother:hall', kind: 'entity', label: '# 大厅', group: '公共区', color: '#356d73', x: 640, y: 360, wx: -14, wz: -8 }],
      },
    }, base);
    expect(merged.insitu).toBe(true);
    expect(merged.map).toBeTruthy();
    expect(merged.map?.layout).toBe('river-grid');
    expect(merged.map?.home?.label).toBe('母星');
    expect(merged.map?.nodes).toHaveLength(1);
  });

  it('cellToScreen 与 screenToCell 在任意相机 azimuth/pitch/zoom 下保持格坐标精确双射，且提取沿途建塔点位', () => {
    const hostMap = parseSpatialMap({
      skin: 'union-atlas-3d',
      layout: 'concentric-town',
      w: 1280,
      h: 800,
      azimuth: -0.42,
      pitch: 0.82,
      zoom: 1.15,
      center: { x: 660, y: 390 },
      home: { key: 'home', kind: 'landmark', label: '母星', x: 660, y: 390 },
    });
    const proj = createSpatialProjector(DEFAULT_PACK, 1280, 800, hostMap);
    expect(proj.tacticalSlots.length).toBeGreaterThan(10);
    expect(proj.tacticalSlots[0].adjacentToPath).toBe(true);

    for (let cy = 0; cy < DEFAULT_PACK.map.height; cy++) {
      for (let cx = 0; cx < DEFAULT_PACK.map.width; cx++) {
        const pt = proj.cellToScreen(cx + 0.5, cy + 0.5);
        const back = proj.screenToCell(pt.x, pt.y);
        expect(back.cx).toBe(cx);
        expect(back.cy).toBe(cy);
        expect(back.inBounds).toBe(true);
      }
    }

    for (const ts of proj.tacticalSlots.slice(0, 12)) {
      const cell = slotCell(DEFAULT_PACK, ts.slot);
      expect(cell).toEqual({ x: ts.x, y: ts.y });
      const back = proj.screenToCell(ts.sx, ts.sy);
      expect(back.slot).toBe(ts.slot);
    }
  });

  it('大厅 #25648：gothic-cathedral-3d (-2.55 rad) 等全皮肤视角自动折叠对齐，军师输出去技术词、屏蔽原始 JSON 并支持 LLM 回包自愈', () => {
    // 1. gothic-cathedral-3d 的 azimuth = -2.55 折叠到正前等轴测舒适区间 [-0.68, 0.68] 且保持双射
    const gothicMap = parseSpatialMap({
      skin: 'gothic-cathedral-3d',
      layout: 'concentric-town',
      w: 1210,
      h: 834,
      azimuth: -2.55,
      pitch: 0.65,
      zoom: 1.0,
      center: { x: 605, y: 400 },
    });
    const gothicProj = createSpatialProjector(DEFAULT_PACK, 1210, 834, gothicMap);
    expect(gothicProj.azimuth).toBeGreaterThanOrEqual(-0.68);
    expect(gothicProj.azimuth).toBeLessThanOrEqual(0.68);
    const p0 = gothicProj.cellToScreen(3.5, 4.5);
    expect(gothicProj.screenToCell(p0.x, p0.y)).toMatchObject({ cx: 3, cy: 4, inBounds: true });

    // 2. 剥离「流式」「Mock」「TIMEOUT」内部技术词，且从 JSON 增量流中提取自然语言而非暴露 JSON 编码
    expect(cleanTechTerms('军师正在流式生成关卡（已流式输出 2217 字）· 本地模板军师（Mock，未接 LLM）· TIMEOUT')).not.toMatch(/流式|Mock|TIMEOUT/);
    const rawJsonChunk = '{"meta":{"theme":"长坂坡雨夜","description":"雨夜突袭"},"enemies":[{"id":"enemy_heavy_01","display_name":"虎豹骑","speed_milli_per_tick":85}]}';
    const speechHtml = extractNaturalAdvisorSpeech(rawJsonChunk, '军师正在流式生成关卡…');
    expect(speechHtml).toContain('长坂坡雨夜');
    expect(speechHtml).toContain('虎豹骑');
    expect(speechHtml).not.toContain('speed_milli_per_tick');
    expect(speechHtml).not.toContain('enemy_heavy_01');
    expect(speechHtml).not.toContain('流式');

    // 3. normalizeLlmAdvice 裁剪角色扮演超长文本，通过 parseAdvice
    const norm = normalizeLlmAdvice({
      basedOn: 0,
      say: '老夫姜尚观此阵势，敌军先锋虽然来势汹汹，但只要在河岸折角布设双弩即可稳如泰山，主公勿忧，且看老夫一计定乾坤！',
      options: [{ id: 'a', title: '稳守河岸折角大阵之策', why: '理由充分', moves: [{ slot: 1, tower: 'crossbow' }] }],
    }, 15);
    const parsed = parseAdvice(norm);
    expect(parsed.ok).toBe(true);

    // 4. sanitizeLlmPack 自动剔除压在路径上的 buildable_cells 并夹紧越界数值，一次通过 validatePack
    const flawedPack = {
      meta: { theme: '太公奇阵', description: '奇门遁甲' },
      towers: [{ id: 'crossbow', display_name: '神臂弩', components: { Health: { max: 100 }, Attack: { damage: 999, range_milli: 9000, interval_ticks: 1 }, Targeting: { mode: 'first_on_path' }, Buildable: { cost: 5 }, Presentation: { asset_id: 'unknown_tower', palette_id: 'unknown_pal' } } }],
      enemies: [{ id: 'cavalry', display_name: '虎豹骑', components: { Health: { max: 50000 }, Movement: { speed_milli_per_tick: 999 }, PathFollower: { base_damage: 2 }, Reward: { gold: 500 }, Presentation: { asset_id: 'unknown_enemy', palette_id: 'unknown_pal' } } }],
      map: {
        grid: { width: 12, height: 9 },
        path: [[0, 1], [4, 1], [4, 3], [9, 3], [9, 6], [11, 6]],
        buildable_cells: [[0, 1], [2, 1], [4, 2]], // 全部压在路径上！
        base: { max_health: 20 },
        starting_gold: 150,
        presentation: { tileset_id: 'unknown_tile', palette_id: 'unknown_pal' },
      },
      waves: [{ id: 'w1', groups: [{ enemy_id: 'cavalry', count: 100, interval_ticks: 20 }] }],
    };
    const healed = sanitizeLlmPack(flawedPack);
    const vr = validatePack(healed);
    expect(vr.ok).toBe(true);
  });
});

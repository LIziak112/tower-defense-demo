import { describe, it, expect } from 'vitest';
import { contextFromMessage, contextFromQuery, createHostBridge, DEFAULT_CONTEXT, hostOrigin, parseHex, parseSkin } from '../../src/game/hikos';
import { HIKOS_SKINS, paletteForContext, skinForContext, DEFAULT_ACCENT, mix } from '../../src/game/skins';
import { createSpatialProjector, getMinionModelKind, parseSpatialMap } from '../../src/game/spatialMap';
import { cleanTechTerms, extractNaturalAdvisorSpeech, normalizeLlmAdvice, sanitizeLlmPack } from '../../src/game/chatFormat';
import {
  buildCulturalMappingTable,
  CAMPAIGN_MAX_LEVEL,
  computeCounterPreview,
  generateCampaignPack,
  getCulturalLexicon,
  getSkin3dAssetManifest,
  localizePackForSkin,
  replaceAncientTerms,
  SKIN_CULTURAL_LEXICONS,
} from '../../src/game/culturalThemes';
import { validatePack } from '../../src/content/validate';
import { balanceWarnings, dryRun } from '../../src/content/dryrun';
import { adviseLocal } from '../../src/advisor/local';
import { advicePrompt } from '../../src/advisor/prompt';
import { createBattle } from '../../src/runtime/sim';
import { buildSnapshot, slotCell } from '../../src/advisor/snapshot';
import { parseAdvice } from '../../src/advisor/types';
import { DEFAULT_PACK } from '../../src/content/default';

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

    // 3. normalizeLlmAdvice 裁剪角色扮演超长文本并补齐缺省 basedOn，通过 parseAdvice
    const norm = normalizeLlmAdvice({
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

  it('大厅 #25801 ①②③：四款皮肤原生道路复用率 80%–100%、起终点绑定原生建筑、小兵复用原生车人模型、全视口安全区无遮挡', () => {
    const skins = [
      { id: 'union-atlas-3d', layout: 'river-grid', azimuth: -0.38, pitch: 0.78 },
      { id: 'metropolis-riverside-3d', layout: 'district-grid', azimuth: -0.38, pitch: 0.78 },
      { id: 'gothic-cathedral-3d', layout: 'concentric-town', azimuth: -2.55, pitch: 0.65 },
      { id: 'harbor-district-3d', layout: 'quays', azimuth: -0.32, pitch: 0.74 },
    ] as const;

    for (const sk of skins) {
      const hostMap = parseSpatialMap({
        skin: sk.id,
        layout: sk.layout,
        w: 1440,
        h: 856,
        azimuth: sk.azimuth,
        pitch: sk.pitch,
        zoom: 1.0,
        center: { x: 740, y: 420 },
        home: { key: 'home', kind: 'landmark', label: '母星核心', x: 860, y: 460, wx: 0, wz: 0 },
        spawnBuilding: { key: 'channel:mother:gate', kind: 'entity', label: '外环原生哨站', x: 420, y: 280, wx: -18, wz: -12 },
        baseBuilding: { key: 'home', kind: 'landmark', label: '母星核心', x: 860, y: 460, wx: 0, wz: 0 },
        ambientTrafficCleared: true,
        landmarks: [{ key: 'home', kind: 'landmark', label: '母星核心', x: 860, y: 460, wx: 0, wz: 0 }],
        nodes: [{ key: 'channel:mother:gate', kind: 'entity', label: '外环原生哨站', x: 420, y: 280, wx: -18, wz: -12 }],
      });
      const proj = createSpatialProjector(DEFAULT_PACK, 1440, 856, hostMap);
      expect(proj.roadPlan.nativeRatio).toBeGreaterThanOrEqual(0.8);
      expect(proj.roadPlan.nativeRatio).toBeLessThanOrEqual(1.0);
      expect(proj.roadPlan.bridgeRatio).toBeGreaterThanOrEqual(0);
      expect(proj.roadPlan.bridgeRatio).toBeLessThanOrEqual(0.2);
      expect(Math.round((proj.roadPlan.nativeRatio + proj.roadPlan.bridgeRatio) * 1000)).toBe(1000);
      expect(proj.roadPlan.startBuilding.label).toBe('外环原生哨站');
      expect(proj.roadPlan.endBuilding.label).toBe('母星核心');
      expect(proj.hostMap?.ambientTrafficCleared).toBe(true);

      // 验证所有路径节点均落在顶部 HUD、左右侧栏与底部 Dock 之间的安全区内
      for (const wp of proj.waypoints) {
        expect(wp.x).toBeGreaterThanOrEqual(280);
        expect(wp.x).toBeLessThanOrEqual(1440 - 280);
        expect(wp.y).toBeGreaterThanOrEqual(80);
        expect(wp.y).toBeLessThanOrEqual(856 - 130);
      }
    }

    // 验证小兵分类映射：重甲/盾车 -> heavy_vehicle，轻骑/港口 -> vehicle，普通步卒 -> pedestrian
    expect(getMinionModelKind({ id: 'shield', display_name: '重盾甲士', hp: 260, speed: 45 }, 'union-atlas-3d')).toBe('heavy_vehicle');
    expect(getMinionModelKind({ id: 'raider', display_name: '轻骑斥候', hp: 90, speed: 95 }, 'metropolis-riverside-3d')).toBe('vehicle');
    expect(getMinionModelKind({ id: 'grunt', display_name: '步卒', hp: 100, speed: 55 }, 'union-atlas-3d')).toBe('pedestrian');
    expect(getMinionModelKind({ id: 'grunt', display_name: '步卒', hp: 100, speed: 55 }, 'harbor-district-3d')).toBe('vehicle');
  });

  it('大厅 #25801 ④：全面去除“金币”统一使用 CP，且支持单局胜 +10 CP / 败 -10 CP 宿主桥接结算与幂等回包', () => {
    const battle = createBattle(DEFAULT_PACK, 42);
    const snap = buildSnapshot(battle);
    const localAdv = adviseLocal('next-wave', snap, battle, 'zh');
    const localJson = JSON.stringify(localAdv);
    expect(localJson).not.toContain('金币');
    expect(localJson).toContain('CP');

    const msgsZh = advicePrompt('next-wave', snap, 'zh');
    expect(JSON.stringify(msgsZh)).not.toContain('金币是唯一资源');
    expect(JSON.stringify(msgsZh)).toContain('CP');

    const bw = balanceWarnings(DEFAULT_PACK);
    expect(JSON.stringify(bw)).not.toContain('金币');
    expect(cleanTechTerms('花费 60 金币可得 30 赏金与 15 金')).toBe('花费 60 CP可得 30 CP 奖励与 15 CP');

    // 验证 createHostBridge 结算往返（td:settle:request -> hikos:settle:reply）
    const sent: Record<string, unknown>[] = [];
    let listener: ((e: MessageEvent) => void) | null = null;
    const parent = { postMessage: (m: Record<string, unknown>) => { sent.push(m); } };
    const win = {
      location: { search: '?v=1&skin=union-atlas-3d', origin: 'https://space.hikos.cn' },
      parent,
      addEventListener: (_t: string, fn: (e: MessageEvent) => void) => { listener = fn; },
      removeEventListener: () => { listener = null; },
    } as unknown as Window;

    const replies: Record<string, unknown>[] = [];
    const bridge = createHostBridge(win, {
      onSettleReply: (r) => replies.push(r as unknown as Record<string, unknown>),
    });
    bridge.ready();
    bridge.send({ type: 'td:settle:request', v: 1, matchId: 'm-win-1', outcome: 'won', deltaCp: 10 });
    expect(sent.at(-1)).toMatchObject({ type: 'td:settle:request', matchId: 'm-win-1', outcome: 'won', deltaCp: 10 });

    listener!({
      source: parent,
      origin: 'https://space.hikos.cn',
      data: {
        type: 'hikos:settle:reply',
        v: 1,
        matchId: 'm-win-1',
        ok: true,
        outcome: 'won',
        deltaCp: 10,
        appliedCp: 10,
        balanceCp: 1010,
        netCp: 10,
        wonCount: 1,
        lostCount: 0,
        idempotent: false,
      },
    } as unknown as MessageEvent);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ matchId: 'm-win-1', ok: true, outcome: 'won', deltaCp: 10, appliedCp: 10, balanceCp: 1010, idempotent: false });
    expect(bridge.context.wallet).toEqual({ balanceCp: 1010, netCp: 10, wonCount: 1, lostCount: 0 });
  });

  it('大厅 #26153 ①②③：四款皮肤世界观文化词表、专属弹道/动效规格、参谋敕令三选一、兵种克制与危机挑战词缀', () => {
    const table = buildCulturalMappingTable();
    expect(table).toHaveLength(4);

    const ancientWords = /军师议事|弩车|投石车|火油台|步卒|轻骑|重甲/;
    for (const row of table) {
      expect(row.councilTitle.current).not.toMatch(ancientWords);
      expect(row.advisorRole.current).not.toMatch(ancientWords);
      for (const tw of row.towers) {
        expect(tw.current).not.toMatch(ancientWords);
        expect(tw.weapon.length).toBeGreaterThan(2);
      }
      for (const en of row.enemies) {
        expect(en.current).not.toMatch(ancientWords);
        expect(en.counter.length).toBeGreaterThan(2);
      }
    }

    // 四款皮肤各自拥有不同专属弹道样式（prism_beam / emp_arc / holy_lance / naval_shell）
    const styles = new Set(Object.values(SKIN_CULTURAL_LEXICONS).map((l) => l.vfx.projectileStyle));
    expect(styles).toEqual(new Set(['prism_beam', 'emp_arc', 'holy_lance', 'naval_shell']));

    // 自由文本替换去除古代中国称谓
    const gothicText = replaceAncientTerms('军师议事：在折角布设弩车与投石车拦截步卒与轻骑', 'gothic-cathedral-3d', 'zh');
    expect(gothicText).toContain('圣堂守夜审判庭');
    expect(gothicText).toContain('圣光钟楼');
    expect(gothicText).toContain('净罪重弩炮');
    expect(gothicText).toContain('黯影障壁食尸鬼');
    expect(gothicText).not.toMatch(ancientWords);

    // 参谋敕令三选一与危机词缀对关卡包的确定性风险-回报调制
    const base = DEFAULT_PACK;
    const overclocked = localizePackForSkin(base, 'union-atlas-3d', 'zh', 'overclock', ['emp_fog', 'vanguard_surge']);
    expect(overclocked.meta.theme).toBe('星院联邦 · 工业星图');
    expect(overclocked.towers[0].display_name).toBe('脉冲棱镜塔');
    expect(overclocked.towers[0].damage).toBeGreaterThan(base.towers[0].damage);
    expect(overclocked.towers[0].interval_ticks).toBeGreaterThan(base.towers[0].interval_ticks);
    expect(overclocked.towers[0].range).toBeLessThan(base.towers[0].range);
    expect(overclocked.enemies[0].speed).toBeGreaterThan(base.enemies[0].speed);

    // 兵种克制矩阵：crossbow 克 footman (shield)，catapult 克 heavy_armor (armor)，fire_brazier 克 light_cavalry (speed)
    expect(computeCounterPreview('crossbow', 'footman', 'metropolis-riverside-3d')).toMatchObject({ isCounter: true, multiplier: 1.35, tagZh: '破盾暴击' });
    expect(computeCounterPreview('catapult', 'heavy_armor', 'harbor-district-3d')).toMatchObject({ isCounter: true, multiplier: 1.35, tagZh: '穿甲重击' });
    expect(computeCounterPreview('fire_brazier', 'light_cavalry', 'gothic-cathedral-3d')).toMatchObject({ isCounter: true, multiplier: 1.35, tagZh: '截击压制' });
    expect(computeCounterPreview('crossbow', 'heavy_armor', 'union-atlas-3d')).toMatchObject({ isResisted: true, multiplier: 0.8, tagZh: '护甲偏转' });

    // 路线分流支线验证
    const proj = createSpatialProjector(DEFAULT_PACK, 1440, 856, parseSpatialMap({ skin: 'harbor-district-3d', w: 1440, h: 856 }));
    expect(proj.roadPlan.splitBranchSegments.length).toBeGreaterThanOrEqual(2);
    expect(getCulturalLexicon('harbor-district-3d').routeSplitLabel.zh).toContain('分流');
  });

  it('大厅 #26188 / #26210：1000 关递增战役、6 兵种、同心环城真实道路拓扑、前 3 关平衡校准与 3D 守兵炮台清单', () => {
    expect(CAMPAIGN_MAX_LEVEL).toBe(1000);
    const p1 = generateCampaignPack(1, 'union-atlas-3d', 'zh');
    const p2 = generateCampaignPack(2, 'metropolis-riverside-3d', 'zh');
    const p3 = generateCampaignPack(3, 'gothic-cathedral-3d', 'zh');
    const p1000 = generateCampaignPack(1000, 'harbor-district-3d', 'zh');

    expect(p1.enemies.length).toBeGreaterThanOrEqual(6);
    expect(p2.enemies.length).toBeGreaterThanOrEqual(6);
    expect(p3.enemies.length).toBeGreaterThanOrEqual(6);
    expect(p1000.enemies.length).toBeGreaterThanOrEqual(6);
    expect(p1000.waves.length).toBeGreaterThan(p1.waves.length);
    expect(p1000.enemies[0].hp).toBeGreaterThan(p1.enemies[0].hp);

    // base_damage 上限 <= 3 且快车移速 <= 52（第 1 关）
    expect(Math.max(...p1.enemies.map((e) => e.base_damage))).toBeLessThanOrEqual(3);
    expect(p1.enemies.find((e) => e.id === 'light_cavalry')?.speed).toBe(52);

    // 前 3 关在合理布防下必胜、不造塔或不合理偏置布防必败
    for (const pk of [p1, p2, p3]) {
      expect(dryRun(pk, 'no_towers', 7).result).toBe('lost');
      expect(dryRun(pk, 'poor_placement', 7).result).toBe('lost');
      expect(dryRun(pk, 'greedy', 7).result).toBe('won');
    }

    // 同心环城（gothic-cathedral-3d）真实圆环+放射路网拓扑：折点数 >= 12，终点锚定 home
    const gothicProj = createSpatialProjector(p3, 1440, 856, parseSpatialMap({
      skin: 'gothic-cathedral-3d',
      layout: 'concentric-town',
      w: 1440,
      h: 856,
      azimuth: -2.55,
      pitch: 0.65,
      zoom: 1,
      home: { key: 'home', kind: 'landmark', label: '圣堂主座', x: 720, y: 420 },
      spawnBuilding: { key: 'belfry', kind: 'entity', label: '外环钟楼门', x: 460, y: 290 },
    }));
    expect(gothicProj.waypoints.length).toBeGreaterThanOrEqual(12);
    expect(gothicProj.roadPlan.endBuilding.key).toBe('home');
    expect(gothicProj.roadPlan.nativeRatio).toBeGreaterThanOrEqual(0.8);

    // 四款皮肤 3D 炮台与守兵素材清单完整性
    const manifest = getSkin3dAssetManifest();
    expect(manifest).toHaveLength(4);
    for (const m of manifest) {
      expect(m.turrets3d).toHaveLength(3);
      expect(m.garrisonDefender.nameZh.length).toBeGreaterThan(2);
      expect(m.license).toContain('CC0');
    }
  });
});

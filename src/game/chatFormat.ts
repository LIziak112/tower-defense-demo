// 军师自然语言聊天式输出格式化与 LLM 结构化回包容错归一化（大厅 #25648 / 任务 997eeae6）。
// 1. 严禁向玩家展示原始 JSON 编码（如 {"meta":...} / speed_milli_per_tick）或内部技术词汇（「流式」「TIMEOUT」「Mock」）；
// 2. 复用 Hikos 聊天窗口（richchat.js）的消息气泡与轻量安全 Markdown 渲染风格，从增量流中实时提取自然语言战策；
// 3. 对真 LLM 返回的关卡内容包（RawPack）与战局建议（Advice）做确定性容错修剪（剔除压在路径上的建塔格、夹紧轻微越界数值、裁剪超长文案），
//    防止因一两个坐标或字数瑕疵触发多轮重试超时降级到 Mock。

import assets from '../content/assets.json';
import { GUARDRAILS as G } from '../content/guardrails';
import A from '../content/packs/changban_rain_night.json';
import type { RawPack } from '../content/schema';
import { expandPath } from '../content/validate';
import { LIMITS } from '../advisor/types';

const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c] || c);
}

/** 过滤内部技术词汇（「流式」「Mock」「TIMEOUT」等），转化为自然军师用语 */
export function cleanTechTerms(text: string, lang: 'zh' | 'en' = 'zh'): string {
  if (!text) return '';
  let out = text
    .replace(/流式生成/g, '推演设计')
    .replace(/流式修正/g, '复盘推演')
    .replace(/流式推演/g, '沙盘推演')
    .replace(/已流式输出\s*\d+\s*字/g, '正在拟定阵法')
    .replace(/流式/g, '实时')
    .replace(/（Mock，未接通?\s*LLM）/gi, '')
    .replace(/\(Mock,\s*LLM not connected\)/gi, '')
    .replace(/本地模板军师/g, lang === 'zh' ? '沙盘参谋' : 'Tactical Aide')
    .replace(/本地模板/g, lang === 'zh' ? '沙盘推演' : 'tactical preset')
    .replace(/\bTIMEOUT\b/g, lang === 'zh' ? '推演超时' : 'timed out')
    .replace(/\bTRANSPORT\b/g, lang === 'zh' ? '通道繁忙' : 'channel busy')
    .replace(/\bBAD_SHAPE\b/g, lang === 'zh' ? '格式校准' : 'format check')
    .replace(/\bNO_ADVISOR\b/g, lang === 'zh' ? '离线模式' : 'offline');
  return out.trim();
}

/** 轻量安全 Markdown 渲染（与 Hikos richchat.js 同源：先转义再处理粗体、行内代码、列表与段落） */
export function renderChatMarkdown(src: string): string {
  const cleaned = cleanTechTerms(src);
  if (!cleaned) return '';
  const lines = cleaned.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let listItems: string[] = [];

  const formatInline = (escaped: string) =>
    escaped
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');

  const flushList = () => {
    if (listItems.length) {
      out.push('<ul class="chat-md-list">' + listItems.map((item) => `<li>${item}</li>`).join('') + '</ul>');
      listItems = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    const bullet = /^[-*·•]\s+(.*)$/.exec(line);
    if (bullet) {
      listItems.push(formatInline(escHtml(bullet[1])));
      continue;
    }
    flushList();
    out.push(`<p class="chat-md-p">${formatInline(escHtml(line))}</p>`);
  }
  flushList();
  return out.join('');
}

function unescapeJsonStr(s: string): string {
  return s
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * 从正在增量到达的关卡 JSON 或建议 JSON 文本中提取自然语言要素，渲染为像聊天窗口一样的军师发言气泡内容。
 * 绝不暴露 `{`、`}`、`speed_milli_per_tick` 等任何 JSON 语法或内部字段名。
 */
export function extractNaturalAdvisorSpeech(rawText: string, stage?: string, lang: 'zh' | 'en' = 'zh'): string {
  const lines: string[] = [];
  const cleanStage = cleanTechTerms(stage || '', lang);

  if (rawText) {
    // 1. 战局军师建议字段（say / options / bet）
    const sayMatch = rawText.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (sayMatch?.[1]) {
      const say = unescapeJsonStr(sayMatch[1]);
      if (say) lines.push(`「${say}」`);
    }

    // 2. 关卡设计字段（theme / description / towers / enemies / waves）
    const themeMatch = rawText.match(/"theme"\s*:\s*"((?:[^"\\]|\\.)*)/);
    const descMatch = rawText.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (themeMatch?.[1]) {
      const th = unescapeJsonStr(themeMatch[1]);
      const ds = descMatch?.[1] ? unescapeJsonStr(descMatch[1]) : '';
      lines.push(ds ? `**战役主题：${th}** —— ${ds}` : `**战役主题：${th}**`);
    } else if (descMatch?.[1]) {
      lines.push(`**战局构想**：${unescapeJsonStr(descMatch[1])}`);
    }

    // 提取已出现的兵种 / 防御塔中文名
    const names: string[] = [];
    const nameRegex = /"display_name"\s*:\s*"((?:[^"\\]|\\.)+)"/g;
    let m: RegExpExecArray | null;
    while ((m = nameRegex.exec(rawText)) !== null) {
      const nm = unescapeJsonStr(m[1]);
      if (nm && !names.includes(nm)) names.push(nm);
    }
    if (names.length > 0) {
      lines.push(`- 已推演兵种与器械：**${names.slice(0, 6).join('、')}**`);
    }

    // 提取已出现的战术选项标题与理由
    const optRegex = /"title"\s*:\s*"((?:[^"\\]|\\.)+)"\s*,\s*"why"\s*:\s*"((?:[^"\\]|\\.)*)/g;
    let om: RegExpExecArray | null;
    let optCount = 0;
    while ((om = optRegex.exec(rawText)) !== null && optCount < 3) {
      const title = unescapeJsonStr(om[1]);
      const why = unescapeJsonStr(om[2]);
      if (title) {
        lines.push(why ? `- **${title}**：${why}` : `- **${title}**`);
        optCount++;
      }
    }

    // 提取波次进度
    const waveMatches = rawText.match(/"enemy_id"\s*:/g);
    if (waveMatches && waveMatches.length > 0 && !optCount) {
      lines.push(`- 正在编排第 **${Math.min(10, waveMatches.length)}** 组敌军攻势波次…`);
    }
  }

  if (!lines.length) {
    lines.push(cleanStage || (lang === 'zh' ? '正在勘察地图地势、推演兵力布防方案…' : 'Analyzing terrain and formulating tactical deployment…'));
  } else if (cleanStage && !lines[0].includes(cleanStage)) {
    lines.unshift(cleanStage);
  }

  return renderChatMarkdown(lines.join('\n'));
}

const clipStr = (v: unknown, maxLen: number, fallback: string): string => {
  if (typeof v !== 'string') return fallback;
  const t = v.trim();
  if (!t) return fallback;
  return t.length <= maxLen ? t : t.slice(0, maxLen - 1) + '…';
};

/**
 * 在通道层对真 LLM 返回的战局建议（Advice）做容错修剪：
 * 保持 `parseAdvice` 本身的严格 Schema 校验不变，但防止真 LLM 因角色扮演多写几个字或漏写 `basedOn` 而被判 BAD_SHAPE / STALE 降级到 Mock。
 */
export function normalizeLlmAdvice(raw: unknown, fallbackStateVersion = 0): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (typeof obj.basedOn !== 'number' || !Number.isFinite(obj.basedOn) || obj.basedOn < fallbackStateVersion) {
    obj.basedOn = fallbackStateVersion;
  } else {
    obj.basedOn = Math.round(obj.basedOn);
  }
  if (typeof obj.say === 'string') {
    const s = obj.say.trim();
    if (s) obj.say = clipStr(s, LIMITS.sayLen, s);
    else delete obj.say;
  }
  if (Array.isArray(obj.options)) {
    const validIds = ['a', 'b', 'c'] as const;
    obj.options = obj.options.slice(0, LIMITS.options).map((item, idx) => {
      if (!item || typeof item !== 'object') return item;
      const o = { ...(item as Record<string, unknown>) };
      if (o.id !== 'a' && o.id !== 'b' && o.id !== 'c') o.id = validIds[idx] ?? 'a';
      if (typeof o.title === 'string') o.title = clipStr(o.title, LIMITS.titleLen, '稳守');
      if (typeof o.why === 'string') o.why = clipStr(o.why, LIMITS.whyLen, '扼守要道');
      if (typeof o.risk === 'string') {
        const rk = o.risk.trim();
        if (rk) o.risk = clipStr(rk, LIMITS.riskLen, rk);
        else delete o.risk;
      }
      if (Array.isArray(o.moves)) {
        o.moves = o.moves
          .slice(0, LIMITS.movesPerOption)
          .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
          .map((m) => ({
            slot: typeof m.slot === 'number' ? Math.max(0, Math.min(4095, Math.round(m.slot))) : 0,
            tower: typeof m.tower === 'string' && m.tower.trim() ? m.tower.trim().slice(0, 32) : 'crossbow',
          }));
      } else {
        o.moves = [];
      }
      return o;
    });
  }
  if (obj.bet && typeof obj.bet === 'object') {
    const b = { ...(obj.bet as Record<string, unknown>) };
    const leaks = typeof b.leaks === 'number' && Number.isFinite(b.leaks) ? Math.max(0, Math.min(99, Math.round(b.leaks))) : 0;
    const line = clipStr(b.line, LIMITS.lineLen, leaks === 0 ? '稳守不漏' : `预计漏 ${leaks} 只`);
    obj.bet = { leaks, line };
  }
  if (obj.gambit && typeof obj.gambit === 'object') {
    const g = { ...(obj.gambit as Record<string, unknown>) };
    if (typeof g.id === 'string' && g.id.trim()) {
      obj.gambit = {
        id: g.id.trim().slice(0, 16),
        line: clipStr(g.line, LIMITS.lineLen, '博取额外赏金'),
      };
    } else {
      delete obj.gambit;
    }
  }
  return obj;
}

const VALID_ASSETS = assets.assets.map((a) => a.asset_id);
const VALID_PALETTES = assets.palettes.map((p) => p.palette_id);
const VALID_TILESETS = assets.tilesets.map((t) => t.tileset_id);

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.max(min, Math.min(max, n));
}

function pickValidId(v: unknown, allowed: string[], fallback: string): string {
  return typeof v === 'string' && allowed.includes(v) ? v : fallback;
}

/**
 * 对真 LLM 生成的关卡内容包（RawPack）做确定性自愈校准：
 * - 自动修复轻微越界的塔/敌军数值到 GUARDRAILS 区间；
 * - 自动过滤压在 path 上或越界/重复的 buildable_cells，若不足则沿 path 两侧自动铺设合法建塔位；
 * - 自动修正未知的 Presentation asset_id / palette_id / tileset_id；
 * 使真 LLM 单次生成即可通过 validatePack，避免因手写坐标失误触发 3 轮重试超时降级到 Mock。
 */
export function sanitizeLlmPack(input: unknown): RawPack {
  const fallback = A as RawPack;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input as RawPack;
  const check = input as Record<string, any>;
  // 若返回的对象连关卡包的基本顶层骨架（meta / towers / enemies / map / waves）都不具备（例如测试桩故意返回战局建议对象），原样交由 validatePack 报错重试
  if (!check.meta || !Array.isArray(check.towers) || !Array.isArray(check.enemies) || !check.map || !Array.isArray(check.waves)) {
    return input as RawPack;
  }
  const raw = JSON.parse(JSON.stringify(input)) as Record<string, any>;

  // 1. meta
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const theme = typeof meta.theme === 'string' && meta.theme.trim() ? meta.theme.trim().slice(0, 40) : fallback.meta.theme;
  const description = typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim().slice(0, 160) : fallback.meta.description;

  // 2. towers
  const rawTowers = Array.isArray(raw.towers) && raw.towers.length ? raw.towers.slice(0, 6) : fallback.towers;
  const seenTowerIds = new Set<string>();
  const towers = rawTowers.map((t: any, i: number) => {
    const fbTower = fallback.towers[i % fallback.towers.length];
    let id = typeof t?.id === 'string' && /^[a-z0-9_]+$/i.test(t.id.trim()) ? t.id.trim().toLowerCase() : fbTower.id;
    if (seenTowerIds.has(id)) id = `${id}_${i + 1}`;
    seenTowerIds.add(id);
    const comp = t?.components && typeof t.components === 'object' ? t.components : {};
    const towerAssets = VALID_ASSETS.filter((a) => a.startsWith('tower_'));
    return {
      id,
      display_name: typeof t?.display_name === 'string' && t.display_name.trim() ? t.display_name.trim().slice(0, 20) : fbTower.display_name,
      components: {
        Health: { max: clampInt(comp.Health?.max, 10, 1000, 100) },
        Attack: {
          damage: clampInt(comp.Attack?.damage, G.tower_damage.min, G.tower_damage.max, fbTower.components.Attack.damage),
          range_milli: clampInt(comp.Attack?.range_milli, G.tower_range_milli.min, G.tower_range_milli.max, fbTower.components.Attack.range_milli),
          interval_ticks: clampInt(comp.Attack?.interval_ticks, G.tower_interval_ticks.min, G.tower_interval_ticks.max, fbTower.components.Attack.interval_ticks),
        },
        Targeting: { mode: 'first_on_path' as const },
        Buildable: {
          cost: clampInt(comp.Buildable?.cost, G.tower_cost.min, G.tower_cost.max, fbTower.components.Buildable.cost),
        },
        Presentation: {
          asset_id: pickValidId(comp.Presentation?.asset_id, VALID_ASSETS, towerAssets[i % towerAssets.length] || fbTower.components.Presentation.asset_id),
          palette_id: pickValidId(comp.Presentation?.palette_id, VALID_PALETTES, fbTower.components.Presentation.palette_id),
        },
      },
    };
  });

  // 3. enemies
  const rawEnemies = Array.isArray(raw.enemies) && raw.enemies.length ? raw.enemies.slice(0, 6) : fallback.enemies;
  const seenEnemyIds = new Set<string>();
  const enemies = rawEnemies.map((e: any, i: number) => {
    const fbEnemy = fallback.enemies[i % fallback.enemies.length];
    let id = typeof e?.id === 'string' && /^[a-z0-9_]+$/i.test(e.id.trim()) ? e.id.trim().toLowerCase() : fbEnemy.id;
    if (seenEnemyIds.has(id)) id = `${id}_${i + 1}`;
    seenEnemyIds.add(id);
    const comp = e?.components && typeof e.components === 'object' ? e.components : {};
    const enemyAssets = VALID_ASSETS.filter((a) => a.startsWith('enemy_'));
    return {
      id,
      display_name: typeof e?.display_name === 'string' && e.display_name.trim() ? e.display_name.trim().slice(0, 20) : fbEnemy.display_name,
      components: {
        Health: {
          max: clampInt(comp.Health?.max, G.enemy_max_health.min, G.enemy_max_health.max, fbEnemy.components.Health.max),
        },
        Movement: {
          speed_milli_per_tick: clampInt(comp.Movement?.speed_milli_per_tick, G.enemy_speed.min, G.enemy_speed.max, fbEnemy.components.Movement.speed_milli_per_tick),
        },
        PathFollower: {
          base_damage: clampInt(comp.PathFollower?.base_damage, 1, 20, fbEnemy.components.PathFollower.base_damage),
        },
        Reward: {
          gold: clampInt(comp.Reward?.gold, G.enemy_gold.min, G.enemy_gold.max, fbEnemy.components.Reward.gold),
        },
        Presentation: {
          asset_id: pickValidId(comp.Presentation?.asset_id, VALID_ASSETS, enemyAssets[i % enemyAssets.length] || fbEnemy.components.Presentation.asset_id),
          palette_id: pickValidId(comp.Presentation?.palette_id, VALID_PALETTES, fbEnemy.components.Presentation.palette_id),
        },
      },
    };
  });

  // 4. map & path & buildable_cells
  const rawMap = raw.map && typeof raw.map === 'object' ? raw.map : {};
  const W = clampInt(rawMap.grid?.width, 6, 24, fallback.map.grid.width);
  const H = clampInt(rawMap.grid?.height, 6, 20, fallback.map.grid.height);
  const inGrid = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < W && y < H;

  let path: [number, number][] = Array.isArray(rawMap.path)
    ? rawMap.path
        .filter((c: any) => Array.isArray(c) && c.length >= 2)
        .map((c: any): [number, number] => [Math.round(Number(c[0])), Math.round(Number(c[1]))])
        .filter(([x, y]: [number, number]) => inGrid(x, y))
        .slice(0, G.path_points.max)
    : [];

  let pathExpanded = expandPath(path);
  if (path.length < G.path_points.min || pathExpanded.errors.length > 0) {
    // 若 LLM 给的折点不连通或自交，使用适配当前网格尺寸的合法折线路径
    path = W === fallback.map.grid.width && H === fallback.map.grid.height
      ? (fallback.map.path.map((c) => [c[0], c[1]]) as [number, number][])
      : [
          [0, 1],
          [Math.floor(W * 0.35), 1],
          [Math.floor(W * 0.35), Math.floor(H * 0.45)],
          [Math.floor(W * 0.75), Math.floor(H * 0.45)],
          [Math.floor(W * 0.75), H - 2],
          [W - 1, H - 2],
        ];
    pathExpanded = expandPath(path);
  }

  const onPath = new Set(pathExpanded.cells.map(([x, y]) => `${x},${y}`));
  const seenBuild = new Set<string>();
  const buildable_cells: [number, number][] = [];

  if (Array.isArray(rawMap.buildable_cells)) {
    for (const c of rawMap.buildable_cells) {
      if (!Array.isArray(c) || c.length < 2) continue;
      const x = Math.round(Number(c[0])), y = Math.round(Number(c[1]));
      const k = `${x},${y}`;
      if (!inGrid(x, y) || onPath.has(k) || seenBuild.has(k)) continue;
      seenBuild.add(k);
      buildable_cells.push([x, y]);
    }
  }

  // 若合法建塔格少于 12 个，自动沿路径两侧补齐紧邻路径的战术建塔位
  if (buildable_cells.length < 12) {
    for (const [px, py] of pathExpanded.cells) {
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const nx = px + dx, ny = py + dy;
        const k = `${nx},${ny}`;
        if (inGrid(nx, ny) && !onPath.has(k) && !seenBuild.has(k)) {
          seenBuild.add(k);
          buildable_cells.push([nx, ny]);
        }
      }
    }
  }

  // 5. waves
  const validEnemyIds = enemies.map((e) => e.id);
  const rawWaves = Array.isArray(raw.waves) && raw.waves.length >= G.wave_count.min
    ? raw.waves.slice(0, G.wave_count.max)
    : fallback.waves;

  const waves = rawWaves.map((w: any, wi: number) => {
    const rawGroups = Array.isArray(w?.groups) && w.groups.length ? w.groups.slice(0, 4) : [{ enemy_id: validEnemyIds[0], count: 6, interval_ticks: 24 }];
    const groups: { enemy_id: string; count: number; interval_ticks: number }[] = rawGroups.map((g: any, gi: number) => ({
      enemy_id: typeof g?.enemy_id === 'string' && validEnemyIds.includes(g.enemy_id) ? g.enemy_id : validEnemyIds[(wi + gi) % validEnemyIds.length],
      count: clampInt(g?.count, 1, G.wave_total_enemies.max, 6),
      interval_ticks: clampInt(g?.interval_ticks, 5, 180, 24),
    }));
    // 确保单波敌人总数在 [G.wave_total_enemies.min, G.wave_total_enemies.max] 内
    const total = groups.reduce((acc: number, g) => acc + g.count, 0);
    if (total < G.wave_total_enemies.min) {
      groups[0].count += G.wave_total_enemies.min - total;
    } else if (total > G.wave_total_enemies.max) {
      const scale = G.wave_total_enemies.max / total;
      let rem = G.wave_total_enemies.max;
      groups.forEach((g, idx: number) => {
        if (idx === groups.length - 1) g.count = Math.max(1, rem);
        else {
          g.count = Math.max(1, Math.floor(g.count * scale));
          rem -= g.count;
        }
      });
    }
    return {
      id: typeof w?.id === 'string' && w.id.trim() ? w.id.trim().slice(0, 24) : `w${wi + 1}`,
      groups,
    };
  });

  return {
    meta: {
      theme,
      description,
      ...(typeof meta.generated_from === 'string' ? { generated_from: meta.generated_from } : {}),
    },
    towers,
    enemies,
    map: {
      grid: { width: W, height: H },
      path,
      buildable_cells,
      base: { max_health: clampInt(rawMap.base?.max_health, 5, 100, fallback.map.base.max_health) },
      starting_gold: clampInt(rawMap.starting_gold, 60, 2000, fallback.map.starting_gold),
      presentation: {
        tileset_id: pickValidId(rawMap.presentation?.tileset_id, VALID_TILESETS, fallback.map.presentation.tileset_id),
        palette_id: pickValidId(rawMap.presentation?.palette_id, VALID_PALETTES, fallback.map.presentation.palette_id),
      },
    },
    waves,
  };
}

// 军师自然语言聊天式输出格式化与 LLM 结构化回包容错归一化（大厅 #25648 / 任务 997eeae6）。
// 1. 严禁向玩家展示原始 JSON 编码（如 {"meta":...} / speed_milli_per_tick）或内部技术词汇（「流式」「TIMEOUT」「Mock」）；
// 2. 复用 Hikos 聊天窗口（richchat.js）的消息气泡与轻量安全 Markdown 渲染风格，从增量流中实时提取自然语言战策；
// 3. 对真 LLM 返回的关卡内容包（RawPack）与战局建议（Advice）做确定性容错修剪（剔除压在路径上的建塔格、夹紧轻微越界数值、裁剪超长文案），
//    防止因一两个坐标或字数瑕疵触发多轮重试超时降级到 Mock。

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

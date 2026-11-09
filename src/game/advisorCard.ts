import type { BattleState } from '../runtime/types';
import { GAMBITS } from '../runtime/gambit';
import { slotCell } from '../advisor/snapshot';
import type { AdvisorView } from '../advisor/session';
import { cleanTechTerms, extractNaturalAdvisorSpeech } from './chatFormat';

export interface CardHandlers {
  adopt(optionId: string): void;
  takeGambit(): void;
  setAutopilot(on: boolean): void;
  preview(optionId: string): void;
}

const STR = {
  zh: {
    title: '军师',
    local: '沙盘推演',
    llm: '实时献策',
    thinking: '推演战局中…',
    adopt: '采纳',
    adopted: '已采纳',
    noSpend: '蓄锐待机',
    bet: '军师押注：',
    gambit: '奇策',
    take: '启用',
    taken: '已启用',
    auto: '托管',
    score: (y: number, a: number) => `${y}:${a}`,
    risk: '留神：',
    fold: '收起',
    unfold: '展开',
  },
  en: {
    title: 'Advisor',
    local: 'Tactical Preset',
    llm: 'Live Strategy',
    thinking: 'Analyzing…',
    adopt: 'Adopt',
    adopted: 'Adopted',
    noSpend: 'Hold gold',
    bet: 'Wager: ',
    gambit: 'Gambit',
    take: 'Take',
    taken: 'Taken',
    auto: 'Auto',
    score: (y: number, a: number) => `${y}:${a}`,
    risk: 'Risk: ',
    fold: 'Collapse',
    unfold: 'Expand',
  },
} as const;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const isSafeAvatarUrl = (u?: string): boolean =>
  !!u && (/^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/i.test(u) || /^https?:\/\//i.test(u) || u.startsWith('/'));

let cardCollapsed = false;

export function renderAdvisorCard(root: HTMLElement, view: AdvisorView, state: BattleState, lang: 'zh' | 'en', previewId: string | null, h: CardHandlers) {
  const { pack, phase, gold, occupied } = state;
  const s = STR[lang];
  root.innerHTML = '';
  root.dataset.status = view.status;
  root.dataset.source = view.current?.source ?? 'none';
  root.dataset.provider = view.provider.kind;
  root.dataset.collapsed = cardCollapsed ? 'true' : 'false';
  const ag = view.provider.agent ?? null;
  if (ag?.name) root.dataset.agent = ag.name; else delete root.dataset.agent;
  const towerName = (id: string) => pack.towers.find((t) => t.id === id)?.display_name ?? id;

  // 1. 紧凑头部栏（头像 + 军师名 + 状态胶囊 + 比分 + 托管开关 + 折叠按钮）
  const head = el('div', 'adv-head');
  if (ag?.name) {
    if (isSafeAvatarUrl(ag.avatar)) {
      const img = el('img', 'adv-avatar');
      img.src = ag.avatar!;
      img.alt = ag.name;
      head.append(img);
    } else {
      const glyph = el('span', 'adv-avatar adv-avatar-glyph', [...ag.name][0] ?? '军');
      if (ag.color) glyph.style.setProperty('--adv-c', ag.color);
      head.append(glyph);
    }
  } else {
    head.append(el('span', 'adv-avatar adv-avatar-glyph', '军'));
  }

  const titleWrap = el('div', 'adv-title-wrap');
  const titleText = ag?.name
    ? `${ag.name}${ag.title ? ` · ${ag.title}` : ''}`
    : s.title;
  const titleEl = el('span', 'adv-title', titleText);
  if (ag?.persona) titleEl.title = ag.persona;
  titleWrap.append(titleEl);

  const badge = el('span', `adv-badge ${view.current?.source === 'llm' || view.status === 'thinking' ? 'llm' : 'local'}`);
  if (view.status === 'thinking') {
    badge.textContent = s.thinking;
  } else if (view.current) {
    badge.textContent = view.current.source === 'llm' ? s.llm : s.local;
  } else {
    badge.textContent = cleanTechTerms(view.provider.name, lang);
  }
  badge.id = 'adv-badge';
  titleWrap.append(badge);
  head.append(titleWrap);

  const metaRight = el('div', 'adv-head-right');
  const scoreEl = el('span', 'adv-score', s.score(view.score.you, view.score.advisor));
  scoreEl.title = lang === 'zh' ? `押注比分：你 ${view.score.you} : ${view.score.advisor} 军师` : `Wager score: You ${view.score.you} : ${view.score.advisor} Advisor`;
  metaRight.append(scoreEl);

  const auto = el('label', 'adv-auto');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.id = 'adv-autopilot';
  cb.checked = view.autopilot;
  cb.onchange = () => h.setAutopilot(cb.checked);
  auto.append(cb, document.createTextNode(s.auto));
  metaRight.append(auto);

  const foldBtn = el('button', 'adv-fold-btn', cardCollapsed ? '▸' : '▾');
  foldBtn.type = 'button';
  foldBtn.title = cardCollapsed ? s.unfold : s.fold;
  foldBtn.setAttribute('aria-label', cardCollapsed ? s.unfold : s.fold);
  foldBtn.onclick = (ev) => {
    ev.stopPropagation();
    cardCollapsed = !cardCollapsed;
    renderAdvisorCard(root, view, state, lang, previewId, h);
  };
  metaRight.append(foldBtn);
  head.append(metaRight);
  root.append(head);

  // 折叠态下只保留军师一句话锦囊，释放左侧地图视野
  const cur = view.current;
  if (cardCollapsed) {
    if (cur?.advice.say) {
      root.append(el('p', 'adv-say adv-say-compact', `「${cur.advice.say}」`));
    }
    return;
  }

  // 2. 聊天式思考气泡（复用自然语言提取器，绝不输出原始 JSON）
  if (view.status === 'thinking') {
    const bubble = el('div', 'adv-chat-bubble thinking');
    const dot = el('span', 'adv-pulse-dot');
    const body = el('div', 'adv-chat-body');
    body.innerHTML = extractNaturalAdvisorSpeech(view.thinking?.streamText || '', s.thinking, lang);
    bubble.append(dot, body);
    root.append(bubble);
  }

  if (view.betLine) root.append(el('p', 'adv-betline', view.betLine));
  if (view.notice && view.status !== 'thinking' && cur?.reason !== 'NO_TRANSPORT') {
    const cleanedNotice = cleanTechTerms(view.notice, lang);
    if (cleanedNotice) root.append(el('p', 'adv-notice', cleanedNotice));
  }
  if (!cur) return;

  if (cur.advice.say) {
    root.append(el('p', 'adv-say', `「${cur.advice.say}」`));
  }

  // 3. 紧凑型战术方案列表（两三路有取舍的打法）
  const canAct = phase === 'build' || phase === 'wave';
  const list = el('div', 'adv-options');
  for (const o of cur.advice.options) {
    const card = el('div', 'adv-opt');
    card.dataset.option = o.id;

    const topRow = el('div', 'adv-line');
    const tag = el('span', 'adv-opt-tag', o.id.toUpperCase());
    const titleB = el('b', 'adv-opt-title', o.title);

    // 汇总器械数量（如「弩车×2」），不再罗列生硬的「槽38←弩车」
    const counts = new Map<string, number>();
    let cost = 0;
    let blocked = false;
    for (const m of o.moves) {
      const nm = towerName(m.tower);
      counts.set(nm, (counts.get(nm) ?? 0) + 1);
      cost += pack.towers.find((tower) => tower.id === m.tower)?.cost ?? 0;
      const cell = slotCell(pack, m.slot);
      if (!cell || occupied.includes(`${cell.x},${cell.y}`)) blocked = true;
    }
    const movesSummary = o.moves.length
      ? [...counts.entries()].map(([nm, n]) => (n > 1 ? `${nm}×${n}` : nm)).join(' + ')
      : s.noSpend;
    const movesChip = el('span', 'adv-moves', `${movesSummary} · ${cost}${lang === 'zh' ? ' 金' : ' gold'}`);

    const isAdopted = cur.adopted.includes(o.id);
    const btn = el('button', `adv-adopt${isAdopted ? ' is-adopted' : ''}`, isAdopted ? s.adopted : s.adopt);
    btn.type = 'button';
    btn.dataset.adopt = o.id;
    btn.disabled = !canAct || isAdopted || !o.moves.length || cost > gold || blocked;
    btn.onclick = () => h.adopt(o.id);

    topRow.append(tag, titleB, movesChip);
    card.append(topRow);

    card.append(el('p', 'adv-why', o.why));
    if (o.risk) card.append(el('p', 'adv-risk', s.risk + o.risk));
    if (o.moves.length) {
      const actions = el('div', 'adv-actions');
      const preview = el('button', 'adv-preview', lang === 'zh' ? '看落点' : 'Show positions');
      preview.type = 'button';
      preview.setAttribute('aria-pressed', String(previewId === o.id));
      preview.disabled = isAdopted || blocked || !canAct;
      preview.onclick = () => h.preview(o.id);
      actions.append(preview, btn);
      card.append(actions);
      if (!isAdopted && (blocked || cost > gold)) {
        card.append(el('p', 'adv-risk', lang === 'zh' ? (blocked ? '落点已占用' : '金币不足') : (blocked ? 'A position is occupied' : 'Not enough gold')));
      }
    } else {
      btn.hidden = true;
      card.append(btn);
    }

    list.append(card);
  }
  root.append(list);

  // 4. 押注与奇策变招底栏
  if (cur.advice.bet) root.append(el('p', 'adv-bet', s.bet + cur.advice.bet.line));
  if (view.gambit.offer || view.gambit.taken) {
    const g = el('div', 'adv-gambit');
    const id = view.gambit.taken?.id ?? view.gambit.offer!.id;
    g.dataset.gambit = id;
    const gInfo = el('div', 'adv-gambit-info');
    gInfo.append(el('b', undefined, `${s.gambit} · ${GAMBITS[id].name[lang]}`));
    gInfo.append(el('span', undefined, view.gambit.taken ? `${GAMBITS[id].line[lang]} (+${view.gambit.taken.bonus})` : view.gambit.offer!.line));
    const b = el('button', 'adv-take', view.gambit.taken ? s.taken : s.take);
    b.type = 'button';
    b.dataset.gambitTake = '';
    b.disabled = !!view.gambit.taken || phase !== 'build';
    b.onclick = () => h.takeGambit();
    g.append(gInfo, b);
    root.append(g);
  }
}

/** 棋盘叠层（非原位独立页兜底）：把当前建议各选项的落点画出来 */

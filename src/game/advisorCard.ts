// 军师 HUD 卡片（表现层）：只读 AdvisorView，点击只回调；军师文本是不可信输入，一律 textContent，不进 innerHTML。
// 卡片口径（#24353）：两三条有取舍的路各自一张小卡、点一下采纳；押注一行；变招一张；来源徽记（LLM / 本地）与战绩常驻；不刷屏（一次只显示当前这条建议）。
import type { ContentPack } from '../runtime/types';
import { GAMBITS } from '../runtime/gambit';
import { slotCell } from '../advisor/snapshot';
import type { AdvisorView } from '../advisor/session';

export interface CardHandlers {
  adopt(optionId: string): void;
  takeGambit(): void;
  setAutopilot(on: boolean): void;
}

const STR = {
  zh: { title: '军师', local: '本地模板', llm: 'LLM', thinking: '思考中…', adopt: '采纳', adopted: '已采纳', noSpend: '这条不花钱', bet: '军师押：', gambit: '变招', take: '接', taken: '已接', auto: '托管', score: (y: number, a: number) => `你 ${y} : ${a} 军师`, risk: '风险：', slot: '槽', arrow: ' ← ', late: '迟到' },
  en: { title: 'Advisor', local: 'local template', llm: 'LLM', thinking: 'thinking…', adopt: 'Adopt', adopted: 'Adopted', noSpend: 'Spends nothing', bet: 'Advisor bets: ', gambit: 'Gambit', take: 'Take', taken: 'Taken', auto: 'Autopilot', score: (y: number, a: number) => `You ${y} : ${a} Advisor`, risk: 'Risk: ', slot: 'slot ', arrow: ' ← ', late: 'late' },
} as const;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export function renderAdvisorCard(root: HTMLElement, view: AdvisorView, pack: ContentPack, lang: 'zh' | 'en', phase: string, h: CardHandlers) {
  const s = STR[lang];
  root.innerHTML = '';
  root.dataset.status = view.status;
  root.dataset.source = view.current?.source ?? 'none';
  root.dataset.provider = view.provider.kind;
  const towerName = (id: string) => pack.towers.find((t) => t.id === id)?.display_name ?? id;

  const head = el('div', 'adv-head');
  head.append(el('span', 'adv-title', s.title));
  const badge = el('span', `adv-badge ${view.current?.source === 'llm' ? 'llm' : 'local'}`);
  if (view.status === 'thinking' && view.thinking) badge.textContent = `${view.provider.name} · ${s.thinking}`;
  else if (view.current) badge.textContent = view.current.source === 'llm' ? `${s.llm} · ${view.current.provider ?? ''}${view.current.latencyMs != null ? ` · ${Math.round(view.current.latencyMs)}ms` : ''}` : `${s.local}${view.current.reason && view.current.reason !== 'NO_TRANSPORT' ? ` · ${view.current.reason}` : ''}`;
  else badge.textContent = view.provider.name;
  badge.id = 'adv-badge';
  head.append(badge);
  head.append(el('span', 'adv-score', s.score(view.score.you, view.score.advisor)));
  const auto = el('label', 'adv-auto');
  const cb = el('input'); cb.type = 'checkbox'; cb.id = 'adv-autopilot'; cb.checked = view.autopilot; cb.onchange = () => h.setAutopilot(cb.checked);
  auto.append(cb, document.createTextNode(' ' + s.auto));
  head.append(auto);
  root.append(head);

  if (view.betLine) root.append(el('p', 'adv-betline', view.betLine));
  if (view.notice) root.append(el('p', 'adv-notice', view.notice));
  const cur = view.current;
  if (!cur) return;
  if (cur.advice.say) root.append(el('p', 'adv-say', `「${cur.advice.say}」`));

  const canAct = phase === 'build' || phase === 'wave';
  const list = el('div', 'adv-options');
  for (const o of cur.advice.options) {
    const card = el('div', 'adv-opt'); card.dataset.option = o.id;
    const line = el('div', 'adv-line');
    line.append(el('b', undefined, `${o.id} · ${o.title}`));
    const moves = o.moves.map((m) => `${s.slot}${m.slot}${s.arrow}${towerName(m.tower)}`).join(lang === 'zh' ? '，' : ', ');
    line.append(el('span', 'adv-moves', moves || s.noSpend));
    card.append(line);
    card.append(el('p', 'adv-why', o.why));
    if (o.risk) card.append(el('p', 'adv-risk', s.risk + o.risk));
    const rejects = cur.rejects.filter((r) => r.option === o.id);
    if (rejects.length) card.append(el('p', 'adv-reject', rejects.map((r) => `✗ ${s.slot}${r.slot ?? '?'} ${r.code}`).join('　')));
    const btn = el('button', 'adv-adopt', cur.adopted.includes(o.id) ? s.adopted : s.adopt);
    btn.dataset.adopt = o.id;
    btn.disabled = !canAct || cur.adopted.includes(o.id) || !o.moves.length;
    btn.onclick = () => h.adopt(o.id);
    card.append(btn);
    list.append(card);
  }
  root.append(list);

  if (cur.advice.bet) root.append(el('p', 'adv-bet', s.bet + cur.advice.bet.line));
  if (view.gambit.offer || view.gambit.taken) {
    const g = el('div', 'adv-gambit');
    const id = view.gambit.taken?.id ?? view.gambit.offer!.id;
    g.dataset.gambit = id;
    g.append(el('b', undefined, `${s.gambit} · ${GAMBITS[id].name[lang]}`));
    g.append(el('span', undefined, view.gambit.taken ? `${GAMBITS[id].line[lang]} · +${view.gambit.taken.bonus}` : view.gambit.offer!.line));
    const b = el('button', 'adv-take', view.gambit.taken ? s.taken : s.take);
    b.dataset.gambitTake = '';
    b.disabled = !!view.gambit.taken || phase !== 'build';
    b.onclick = () => h.takeGambit();
    g.append(b);
    root.append(g);
  }
  const last = view.outcomes[view.outcomes.length - 1];
  if (last && view.outcomes.length && !view.notice) root.append(el('p', `adv-outcome ${last.ok ? 'ok' : 'bad'}`, `${last.option} · ${s.slot}${last.slot} ${last.ok ? '✓' : '✗ ' + (last.message ?? last.code ?? '')}`));
}

/** 棋盘叠层：把当前建议各选项的落点画出来（a/b/c 字母 + 描边），只读不改状态 */
export function drawAdvisorOverlay(ctx: CanvasRenderingContext2D, view: AdvisorView, pack: ContentPack, px: number, accent: string) {
  const cur = view.current;
  if (!cur) return;
  ctx.save();
  ctx.lineWidth = 2; ctx.strokeStyle = accent; ctx.fillStyle = accent; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
  const seen = new Set<string>();
  for (const o of cur.advice.options) {
    for (const m of o.moves) {
      const c = slotCell(pack, m.slot);
      if (!c) continue;
      const k = `${c.x},${c.y}`;
      ctx.globalAlpha = cur.adopted.includes(o.id) ? 0.35 : 0.9;
      ctx.setLineDash(o.id === 'a' ? [] : [4, 3]);
      ctx.strokeRect(c.x * px + 4, c.y * px + 4, px - 8, px - 8);
      if (!seen.has(k)) { ctx.fillText(o.id, c.x * px + 7, c.y * px + 15); seen.add(k); }
      else ctx.fillText(o.id, c.x * px + 7 + 10 * (o.id === 'b' ? 1 : 2), c.y * px + 15);
    }
  }
  ctx.restore();
}

import { AdvisorSession, HostChannel, selectChannel, type AdvisorAgent, type AdvisorView } from '../advisor';
import { LlmContentProvider } from '../ai/llm';
import type { BattleState, Command } from '../runtime';
import type { HostContext, createHostBridge } from './hikos';
import { renderAdvisorCard } from './advisorCard';

interface AdvisorOptions {
  bridge: ReturnType<typeof createHostBridge>; tactical: boolean; advisorBox: HTMLElement;
  reply: ((m: Record<string, unknown>) => void)[]; stream: ((m: Record<string, unknown>) => void)[];
  read(): { state: BattleState; lang: 'zh' | 'en'; inLobby: boolean };
  isInsitu(): boolean; enter(): void; fit(): void; run(commands: Command[]): void;
}
export function createAdvisorView(opts: AdvisorOptions) {
  const { advisorBox } = opts;
  let hostChannel: HostChannel | null = null;
  const advisorSel = selectChannel({
    search: location.search, embedded: opts.bridge.embedded,
    makeHost: () => (hostChannel = new HostChannel((m) => opts.bridge.send(m), (cb) => opts.reply.push(cb), '频道智能体军师', () => Date.now(), (cb) => opts.stream.push(cb))),
  });
  const session = new AdvisorSession({ channel: advisorSel.channel, lang: opts.bridge.context.lang, tactical: opts.tactical, onChange: () => scheduleCard() });
  const llmLevelProvider = advisorSel.channel ? new LlmContentProvider(advisorSel.channel, { lang: opts.bridge.context.lang }) : null;

  let cardRaf = 0;
  let cardView: AdvisorView = session.view();
  let previewId: string | null = null;
  function scheduleCard() { cancelAnimationFrame(cardRaf); cardRaf = requestAnimationFrame(renderCard); }
  function renderCard() {
    const previous = cardView.current?.reqId;
    cardView = session.view();
    if (previous !== cardView.current?.reqId) previewId = cardView.current?.advice.options.find((o) => o.moves.length)?.id ?? null;
    const { inLobby, state, lang } = opts.read();
    advisorBox.style.display = inLobby && !opts.isInsitu() ? 'none' : 'block';
    renderAdvisorCard(advisorBox, cardView, state, lang, previewId, {
      adopt: (id) => {
        if (inLobby) opts.enter();
        const cmds = session.adopt(id);
        if (cmds.length) opts.run(cmds);
      },
      takeGambit: () => {
        if (inLobby) opts.enter();
        const c = session.takeGambit();
        if (c) opts.run([c]);
      },
      setAutopilot: (on) => session.setAutopilot(on),
      preview: (id) => {
        previewId = previewId === id ? null : id;
        advisorBox.querySelectorAll<HTMLButtonElement>('.adv-preview').forEach((button) => {
          button.setAttribute('aria-pressed', String(button.closest<HTMLElement>('.adv-opt')?.dataset.option === previewId));
        });
      },
    });
    opts.fit();
  }

  function setContext(c: HostContext) {
    session.lang = c.lang;
    if (llmLevelProvider) llmLevelProvider.lang = c.lang;
    const agent: AdvisorAgent | null = c.advisor?.agent ?? null;
    hostChannel?.setAgent(agent);
    session.setAgent(agent);
    llmLevelProvider?.setAgent(agent);
    // 宿主 context 一到就定军师可用性：没配（enabled:false）或老宿主（没有 advisor 字段）→ 不白等截止，秒切本地；排队中的请求随之放行 / 作废
    hostChannel?.setAvailable(c.advisor?.enabled === true);
  }
  function debug(enqueue: (...commands: Command[]) => void) {
    return {
      mode: advisorSel.mode, reason: advisorSel.reason,
      view: () => session.view(),
      adopt: (id: string) => { const c = session.adopt(id); enqueue(...c); return c.length; },
      takeGambit: () => { const c = session.takeGambit(); if (c) enqueue(c); return !!c; },
      setAutopilot: (on: boolean) => session.setAutopilot(on),
      snapshot: () => session.snapshotNow(),
      debrief: () => session.debrief(opts.read().state),
    };
  }
  return {
    session, llm: llmLevelProvider, setContext, schedule: scheduleCard, debug,
    agent: () => session.agent ?? hostChannel?.agent ?? null,
    clear() { previewId = null; },
    get cardView() { return cardView; },
    get previewId() { return previewId; },
  };
}

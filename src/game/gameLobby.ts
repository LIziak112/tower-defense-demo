import type { AdvisorAgent } from '../advisor';
import type { ContentPack } from '../runtime';
import { runPipeline, runPipelineAsync, type LevelStreamProgress, type Summary } from '../ai/pipeline';
import type { LlmContentProvider } from '../ai/llm';
import type { MockProvider } from '../ai/mock';
import { cleanTechTerms, escHtml, extractNaturalAdvisorSpeech } from './chatFormat';

interface LobbyOptions {
  root: HTMLElement; embedded: boolean; lang(): 'zh' | 'en'; agent(): AdvisorAgent | null;
  provider: MockProvider; llm: LlmContentProvider | null;
  onShow(): void; enter(): void; playCampaign(): void; start(pack: ContentPack): void; reportState(): void;
}
export function createLobby(opts: LobbyOptions) {
  const lobby = document.createElement('div');
  lobby.id = 'lobby';
  opts.root.append(lobby);
  const esc = escHtml;
  const safeAvatar = (u?: string) => !!u && (/^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/i.test(u) || /^https?:\/\//i.test(u) || u.startsWith('/'));
  let designing = false;   // 关卡设计军师（LLM）出活中：按钮置灰，防连点
  let lastSum: Summary | undefined;

  function lobbyIdentityHtml(sum?: Summary): string {
    const ag = opts.agent();
    const rawWho = sum?.provider ?? (opts.llm ? opts.llm.name : opts.provider.name);
    const who = cleanTechTerms(rawWho, opts.lang());
    const avHtml = ag?.name
      ? (safeAvatar(ag.avatar)
          ? `<img class="lobby-adv-av" src="${esc(ag.avatar!)}" alt="${esc(ag.name)}">`
          : `<span class="lobby-adv-av lobby-adv-glyph"${ag.color ? ` style="--adv-c:${esc(ag.color)}"` : ''}>${esc([...ag.name][0] ?? '军')}</span>`)
      : `<span class="lobby-adv-av lobby-adv-glyph">军</span>`;
    const personaAttr = ag?.persona ? ` title="${esc(ag.persona)}"` : '';
    const personaHtml = ag?.persona ? `<p class="lobby-persona" id="lobby-persona" hidden>${esc(ag.persona)}</p>` : '';
    return `<div id="lobby-head"${personaAttr}><h3>${avHtml}<span class="lobby-title-text">军师议事</span> <small id="lobby-who">${esc(who)}</small></h3>${personaHtml}</div>`;
  }

  function refreshLobbyIdentity() {
    const head = lobby.querySelector('#lobby-head');
    if (!head) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = lobbyIdentityHtml(lastSum);
    if (wrap.firstElementChild) head.replaceWith(wrap.firstElementChild);
  }

  function renderLobbyStream(p: LevelStreamProgress) {
    const out = lobby.querySelector('#summary');
    if (!out) return;
    let box = out.querySelector('.stream-box') as HTMLElement | null;
    if (!box) {
      out.innerHTML = `<div class="stream-box lobby-chat-bubble" id="lobby-stream"><div class="stream-head"><span class="adv-pulse-dot"></span><p class="stream-stage" id="stream-stage"></p></div><div class="stream-parsed chat-md-body" id="stream-parsed"></div></div>`;
      box = out.querySelector('.stream-box') as HTMLElement | null;
    }
    const stageEl = out.querySelector('#stream-stage');
    const parsedEl = out.querySelector('#stream-parsed');
    const ag = opts.agent();
    const actor = ag?.name ? `军师「${ag.name}」` : cleanTechTerms(p.provider || '军师', opts.lang());
    const stageText = cleanTechTerms(p.stage || '正在推演阵法与兵力部署…', opts.lang());
    if (stageEl) {
      stageEl.textContent = `${actor} · ${stageText}`;
    }
    if (parsedEl) {
      // 复用聊天式自然语言提取器：将增量内容渲染成通顺的军师自然语言战策段落，绝不展示原始 JSON
      parsedEl.innerHTML = extractNaturalAdvisorSpeech(p.text, stageText, opts.lang());
    }
  }

  function showLobby(sum?: Summary, text = '') {
    opts.onShow(); lobby.style.display = 'block';
    lastSum = sum;
    lobby.innerHTML = `<div class="card">${lobbyIdentityHtml(sum)}
    ${opts.embedded ? '' : '<p class="lobby-intro">守住长坂坡的五波进攻。也可以描述一场新战局，请军师出题。</p>'}
    <textarea id="desc" rows="2" placeholder="输入战局构想，例如：长坂坡雨夜，轻骑突袭">${esc(text)}</textarea>
    <div class="lobby-presets"><button type="button" class="preset-chip" data-preset="长坂坡雨夜，轻骑突袭">长坂坡雨夜</button><button type="button" class="preset-chip" data-preset="水路栈道伏击，人海战术">水路伏击</button><button type="button" class="preset-chip" data-preset="重甲铁骑攻城，高赏金">重甲攻城</button></div>
    <div class="row"><button id="td-direct-play" class="primary-btn" type="button">${opts.embedded ? '直接原位布防' : '开始长坂坡守城'}</button><button id="gen" class="ghost-btn"${designing ? ' disabled' : ''}>${designing ? '军师推演中…' : '让军师设计'}</button></div>
    <div id="summary"></div></div>`;

    lobby.querySelectorAll('.preset-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const preset = (chip as HTMLElement).dataset.preset || '';
        const area = lobby.querySelector('#desc') as HTMLTextAreaElement | null;
        if (area && preset) area.value = preset;
      });
    });

    lobby.querySelector('#td-direct-play')?.addEventListener('click', () => opts.embedded ? opts.enter() : opts.playCampaign());
    const out = lobby.querySelector('#summary')!;
    if (designing && !sum) {
      const ag = opts.agent();
      const actor = ag?.name ? `军师「${ag.name}」` : cleanTechTerms(opts.llm?.name ?? '军师', opts.lang());
      out.innerHTML = `<div class="stream-box lobby-chat-bubble" id="lobby-stream"><div class="stream-head"><span class="adv-pulse-dot"></span><p class="stream-stage" id="stream-stage">${esc(actor)} · 正在勘察地形并推演阵法…</p></div><div class="stream-parsed chat-md-body" id="stream-parsed"><p class="chat-md-p">正在结合当前地图地势编排兵种与防线…</p></div></div>`;
    } else if (sum) {
      const ag = opts.agent();
      const speaker = ag?.name ? `${ag.name}${ag.title ? `（${ag.title}）` : ''}` : cleanTechTerms(sum.provider, opts.lang());
      const cleanNote = sum.note ? cleanTechTerms(sum.note, opts.lang()) : '';
      const greedyRun = sum.dryrun.find((d) => d.bot === 'greedy');
      const simLine = greedyRun
        ? `自动布防预演：${{ won: '守城成功', lost: '基地失守', timeout: '未打完' }[greedyRun.result]} · 基地剩余 ${greedyRun.base_hp} · 漏敌 ${greedyRun.leaks}`
        : '';
      out.innerHTML = `<div class="lobby-chat-bubble result-bubble">
        <div class="chat-msg-head"><strong>${esc(speaker)}</strong><span>阵法成稿</span></div>
        <p class="echo">${esc(cleanTechTerms(sum.echo, opts.lang()))}</p>
        ${simLine ? `<p class="dry">${esc(simLine)}</p>` : ''}
        <div class="lobby-pack-grid">
          <div><span class="meta-k">守军器械</span><span class="meta-v">${esc(sum.towers.join(' · '))}</span></div>
          <div><span class="meta-k">敌军先锋</span><span class="meta-v">${esc(sum.enemies.join(' · '))}</span></div>
          <div><span class="meta-k">攻势编组</span><span class="meta-v">共 ${sum.waves.length} 波（${sum.waves.map((w, i) => `W${i + 1}:${w.total}骑`).join(' / ')}）</span></div>
        </div>
        ${cleanNote ? `<p class="warn">${esc(cleanNote)}</p>` : ''}
        ${sum.warnings.map((w) => `<p class="warn">⚠ ${esc(w.message)}</p>`).join('')}
        ${sum.errors.slice(0, 5).map((e) => `<p class="err">✗ ${esc(e.message)}（${esc(e.path)}）</p>`).join('')}
      </div>
      <div class="row action-row"><button id="go" class="primary-btn">开始布防</button><button id="again" class="ghost-btn">重新推演</button></div>`;
      out.querySelector('#go')!.addEventListener('click', () => opts.start(sum.pack));
      out.querySelector('#again')!.addEventListener('click', () => (lobby.querySelector('#desc') as HTMLTextAreaElement).focus());
    }
    lobby.querySelector('#gen')!.addEventListener('click', () => {
      const tx = (lobby.querySelector('#desc') as HTMLTextAreaElement).value.trim() || '长坂坡雨夜';
      void design(tx);
    });
    opts.reportState();
  }

  /** 关卡设计：有通道就走真 LLM（支持实时进展反馈；失败整条退本地模板并在卡上说明），没有就同步走 Mock。
   *  注意：先复位忙碌标志 designing 再调用 showLobby 重绘，结果渲染后按钮恢复可点、不再挂「军师推演中…」。 */
  async function design(tx: string) {
    if (designing) return;
    if (!opts.llm) { showLobby(runPipeline(opts.provider, tx), tx); return; }
    designing = true; showLobby(undefined, tx);
    let sum: Summary | undefined;
    try {
      sum = await runPipelineAsync(opts.llm, tx, 3, opts.provider, (p) => {
        if (designing) renderLobbyStream(p);
      });
    } finally {
      designing = false;
    }
    showLobby(sum, tx);
  }
  return { show: showLobby, design, refresh: refreshLobbyIdentity, hide() { lobby.style.display = 'none'; } };
}

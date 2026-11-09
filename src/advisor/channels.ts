// 三种通道：宿主代理（postMessage，嵌在 Hikos 里的正道）· HTTP 开发代理（独立打开 / 联调；只在非嵌入时允许）· 脚本通道（测试与故障注入）。
// 通道只负责送到与收回；配对 reqId、判迟到 / 重复 / 过期、兜底都在 session.ts。
import { isAdvisorReply, isAdvisorStreamEvent, type AdvisorAgent, type AdvisorChannel, type AdvisorReply, type AdvisorRequest, type AdvisorStreamEvent } from './types';

type ReplyCb = (reply: AdvisorReply) => void;
type StreamCb = (ev: AdvisorStreamEvent) => void;

/** 宿主代理：游戏 → 宿主 td:advisor:request；宿主 → 游戏 hikos:advisor:stream（SSE 增量）+ hikos:advisor:reply（最终回包） */
export class HostChannel implements AdvisorChannel {
  readonly kind = 'host' as const;
  private readonly fallbackName: string;
  agent: AdvisorAgent | null = null;
  /**
   * null = 还不知道宿主有没有军师（hikos:context 没到）：请求先排队，不发；
   * true = 宿主 context.advisor.enabled → 放行（排队的补发，已过截止的不发）；
   * false = 宿主说没配军师、或是不认识军师的老宿主（context 里没有 advisor 字段）→ post 时立刻回 NO_ADVISOR 让会话秒切本地，不白等截止。
   */
  available: boolean | null = null;
  private pending: { req: AdvisorRequest; at: number }[] = [];
  private cbs: ReplyCb[] = [];
  private streamCbs: StreamCb[] = [];
  constructor(
    private readonly send: (msg: Record<string, unknown>) => void,
    subscribe: (cb: (msg: Record<string, unknown>) => void) => void,
    name = '频道智能体军师',
    private readonly now: () => number = () => Date.now(),
    subscribeStream?: (cb: (msg: Record<string, unknown>) => void) => void,
  ) {
    this.fallbackName = name;
    subscribe((m) => {
      const r = { reqId: m.reqId, ok: m.ok, payload: m.payload, error: m.error, provider: m.provider, latencyMs: m.latencyMs, agent: m.agent };
      if (isAdvisorReply(r)) for (const cb of this.cbs) cb(r);
    });
    subscribeStream?.((m) => {
      const ev = {
        reqId: m.reqId,
        delta: typeof m.delta === 'string' ? m.delta : undefined,
        text: typeof m.text === 'string' ? m.text : undefined,
        chars: typeof m.chars === 'number' ? m.chars : undefined,
        stage: typeof m.stage === 'string' ? m.stage : undefined,
        provider: typeof m.provider === 'string' ? m.provider : undefined,
      };
      if (isAdvisorStreamEvent(ev)) for (const cb of this.streamCbs) cb(ev);
    });
  }
  get name(): string {
    if (this.agent?.name) return this.agent.title ? `${this.agent.name} · ${this.agent.title}` : this.agent.name;
    return this.fallbackName;
  }
  setAgent(agent: AdvisorAgent | null) {
    this.agent = agent;
  }
  private buildWire(req: AdvisorRequest): Record<string, unknown> {
    const wire: Record<string, unknown> = { type: 'td:advisor:request', ...req };
    if (this.agent && !wire.agent) wire.agent = this.agent;
    return wire;
  }
  post(req: AdvisorRequest) {
    if (this.available === null) { this.pending.push({ req, at: this.now() }); return; }
    if (!this.available) { this.reject(req); return; }
    this.send(this.buildWire(req));
  }
  /** 宿主的 hikos:context 到了：定下可用性，并处理排队中的请求 */
  setAvailable(on: boolean) {
    this.available = on;
    const q = this.pending; this.pending = [];
    for (const { req, at } of q) {
      if (!on) this.reject(req);
      else if (this.now() - at < req.deadlineMs) this.send(this.buildWire(req));   // 早已过截止的（会话那边已兜底）不再浪费一次模型调用
    }
  }
  private reject(req: AdvisorRequest) {
    queueMicrotask(() => { for (const cb of this.cbs) cb({ reqId: req.reqId, ok: false, error: { code: 'NO_ADVISOR', message: 'host has no advisor configured' } }); });
  }
  onReply(cb: ReplyCb) { this.cbs.push(cb); }
  onStream(cb: StreamCb) { this.streamCbs.push(cb); }
}

/** HTTP 开发代理（tools/advisor-proxy.cjs 或任何实现同一 JSON / SSE 契约的端点）：POST 请求体 = AdvisorRequest，响应体 = AdvisorReply 或 SSE 流 */
export class HttpChannel implements AdvisorChannel {
  readonly kind = 'http' as const;
  readonly name: string;
  agent: AdvisorAgent | null = null;
  private cbs: ReplyCb[] = [];
  private streamCbs: StreamCb[] = [];
  constructor(readonly url: string, private readonly fetchFn: typeof fetch = (...a) => fetch(...a)) { this.name = `HTTP 代理 ${new URL(url, 'http://x').host}`; }
  post(req: AdvisorRequest) {
    const t0 = Date.now();
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(), req.deadlineMs + 1000);   // 首包/空闲超时：流式每收到一块就续期
    const resetTimer = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), req.deadlineMs + 1000); };
    this.fetchFn(this.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' }, body: JSON.stringify(req), signal: ac.signal })
      .then(async (res) => {
        resetTimer();
        const ctype = (res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') || '' : '').toLowerCase();
        if (res.ok && ctype.includes('text/event-stream') && res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let accText = '';
          let doneReply: AdvisorReply | null = null;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            resetTimer();
            buf += dec.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of block.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const raw = trimmed.slice(5).trim();
                if (!raw || raw === '[DONE]') continue;
                try {
                  const ev = JSON.parse(raw) as Record<string, unknown>;
                  if (ev.type === 'delta' || ev.type === 'progress') {
                    const delta = typeof ev.delta === 'string' ? ev.delta : '';
                    accText = typeof ev.text === 'string' ? ev.text : accText + delta;
                    this.emitStream({
                      reqId: req.reqId,
                      delta,
                      text: accText,
                      chars: typeof ev.chars === 'number' ? ev.chars : accText.length,
                      stage: typeof ev.stage === 'string' ? ev.stage : undefined,
                      provider: typeof ev.provider === 'string' ? ev.provider : undefined,
                    });
                  } else if (ev.type === 'done' || 'ok' in ev) {
                    const candidate = { ...ev, reqId: req.reqId, latencyMs: typeof ev.latencyMs === 'number' ? ev.latencyMs : Date.now() - t0 };
                    if (isAdvisorReply(candidate)) doneReply = candidate;
                  }
                } catch { /* ignore malformed frame */ }
              }
            }
          }
          if (doneReply) return this.emit(doneReply);
          return this.emit({ reqId: req.reqId, ok: false, error: { code: 'BAD_SHAPE', message: 'SSE stream ended without done event' }, latencyMs: Date.now() - t0 });
        }
        const text = await res.text();
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { body = null; }
        if (!res.ok) return this.emit({ reqId: req.reqId, ok: false, error: { code: 'TRANSPORT', message: `HTTP ${res.status}` }, latencyMs: Date.now() - t0 });
        if (isAdvisorReply(body)) return this.emit({ ...body, reqId: req.reqId, latencyMs: body.latencyMs ?? Date.now() - t0 });
        // 代理只回了 payload 本体也认（宽进）
        this.emit({ reqId: req.reqId, ok: true, payload: body, latencyMs: Date.now() - t0 });
      })
      .catch((e: unknown) => this.emit({ reqId: req.reqId, ok: false, error: { code: ac.signal.aborted ? 'TIMEOUT' : 'TRANSPORT', message: e instanceof Error ? e.message : String(e) }, latencyMs: Date.now() - t0 }))
      .finally(() => clearTimeout(timer));
  }
  onReply(cb: ReplyCb) { this.cbs.push(cb); }
  onStream(cb: StreamCb) { this.streamCbs.push(cb); }
  setAgent(agent: AdvisorAgent | null) { this.agent = agent; }
  private emit(r: AdvisorReply) { for (const cb of this.cbs) cb(r); }
  private emitStream(ev: AdvisorStreamEvent) { for (const cb of this.streamCbs) cb(ev); }
}

/** 脚本通道：测试里按脚本回包（可延迟、可错、可重复、可改 reqId），也可直接 inject 任意回包与流式增量 */
export class ScriptedChannel implements AdvisorChannel {
  readonly kind = 'scripted' as const;
  readonly name = '脚本军师';
  agent: AdvisorAgent | null = null;
  readonly sent: AdvisorRequest[] = [];
  private cbs: ReplyCb[] = [];
  private streamCbs: StreamCb[] = [];
  /** 每条请求到来时被调用；返回要回的东西（可多条、可延迟），不回就返回 [] */
  script: (req: AdvisorRequest) => { reply: Omit<AdvisorReply, 'reqId'> & { reqId?: string }; delayMs?: number }[] = () => [];
  /** 为 true 时 post 直接抛错（模拟断网 / 代理不可用） */
  broken = false;
  constructor(private readonly schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms); }) {}
  setAgent(agent: AdvisorAgent | null) { this.agent = agent; }
  post(req: AdvisorRequest) {
    if (this.broken) throw new Error('channel down');
    this.sent.push(req);
    for (const item of this.script(req)) {
      const reply = { ...item.reply, reqId: item.reply.reqId ?? req.reqId } as AdvisorReply;
      if (item.delayMs && item.delayMs > 0) this.schedule(() => this.emit(reply), item.delayMs); else this.emit(reply);
    }
  }
  onReply(cb: ReplyCb) { this.cbs.push(cb); }
  onStream(cb: StreamCb) { this.streamCbs.push(cb); }
  inject(reply: AdvisorReply) { this.emit(reply); }
  injectStream(ev: AdvisorStreamEvent) { for (const cb of this.streamCbs) cb(ev); }
  private emit(r: AdvisorReply) { for (const cb of this.cbs) cb(r); }
}

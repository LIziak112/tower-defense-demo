// 三种通道：宿主代理（postMessage，嵌在 Hikos 里的正道）· HTTP 开发代理（独立打开 / 联调；只在非嵌入时允许）· 脚本通道（测试与故障注入）。
// 通道只负责送到与收回；配对 reqId、判迟到 / 重复 / 过期、兜底都在 session.ts。
import { isAdvisorReply, type AdvisorChannel, type AdvisorReply, type AdvisorRequest } from './types';

type ReplyCb = (reply: AdvisorReply) => void;

/** 宿主代理：游戏 → 宿主 td:advisor:request；宿主 → 游戏 hikos:advisor:reply（宿主拿自己的凭据去调模型，游戏不知道端点与密钥） */
export class HostChannel implements AdvisorChannel {
  readonly kind = 'host' as const;
  readonly name: string;
  /**
   * null = 还不知道宿主有没有军师（hikos:context 没到）：请求先排队，不发；
   * true = 宿主 context.advisor.enabled → 放行（排队的补发，已过截止的不发）；
   * false = 宿主说没配军师、或是不认识军师的老宿主（context 里没有 advisor 字段）→ post 时立刻回 NO_ADVISOR 让会话秒切本地，不白等截止。
   */
  available: boolean | null = null;
  private pending: { req: AdvisorRequest; at: number }[] = [];
  private cbs: ReplyCb[] = [];
  constructor(private readonly send: (msg: Record<string, unknown>) => void, subscribe: (cb: (msg: Record<string, unknown>) => void) => void, name = 'Hikos 宿主代理', private readonly now: () => number = () => Date.now()) {
    this.name = name;
    subscribe((m) => {
      const r = { reqId: m.reqId, ok: m.ok, payload: m.payload, error: m.error, provider: m.provider, latencyMs: m.latencyMs };
      if (isAdvisorReply(r)) for (const cb of this.cbs) cb(r);
    });
  }
  post(req: AdvisorRequest) {
    if (this.available === null) { this.pending.push({ req, at: this.now() }); return; }
    if (!this.available) { this.reject(req); return; }
    this.send({ type: 'td:advisor:request', ...req });
  }
  /** 宿主的 hikos:context 到了：定下可用性，并处理排队中的请求 */
  setAvailable(on: boolean) {
    this.available = on;
    const q = this.pending; this.pending = [];
    for (const { req, at } of q) {
      if (!on) this.reject(req);
      else if (this.now() - at < req.deadlineMs) this.send({ type: 'td:advisor:request', ...req });   // 早已过截止的（会话那边已兜底）不再浪费一次模型调用
    }
  }
  private reject(req: AdvisorRequest) {
    queueMicrotask(() => { for (const cb of this.cbs) cb({ reqId: req.reqId, ok: false, error: { code: 'NO_ADVISOR', message: 'host has no advisor configured' } }); });
  }
  onReply(cb: ReplyCb) { this.cbs.push(cb); }
}

/** HTTP 开发代理（tools/advisor-proxy.cjs 或任何实现同一 JSON 契约的端点）：POST 请求体 = AdvisorRequest，响应体 = AdvisorReply */
export class HttpChannel implements AdvisorChannel {
  readonly kind = 'http' as const;
  readonly name: string;
  private cbs: ReplyCb[] = [];
  constructor(readonly url: string, private readonly fetchFn: typeof fetch = (...a) => fetch(...a)) { this.name = `HTTP 代理 ${new URL(url, 'http://x').host}`; }
  post(req: AdvisorRequest) {
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), req.deadlineMs + 1000);   // 比会话的截止稍晚：会话先判 TIMEOUT 并兜底，这里只是别让连接挂着
    this.fetchFn(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal: ac.signal })
      .then(async (res) => {
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
  private emit(r: AdvisorReply) { for (const cb of this.cbs) cb(r); }
}

/** 脚本通道：测试里按脚本回包（可延迟、可错、可重复、可改 reqId），也可直接 inject 任意回包 */
export class ScriptedChannel implements AdvisorChannel {
  readonly kind = 'scripted' as const;
  readonly name = '脚本军师';
  readonly sent: AdvisorRequest[] = [];
  private cbs: ReplyCb[] = [];
  /** 每条请求到来时被调用；返回要回的东西（可多条、可延迟），不回就返回 [] */
  script: (req: AdvisorRequest) => { reply: Omit<AdvisorReply, 'reqId'> & { reqId?: string }; delayMs?: number }[] = () => [];
  /** 为 true 时 post 直接抛错（模拟断网 / 代理不可用） */
  broken = false;
  constructor(private readonly schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms); }) {}
  post(req: AdvisorRequest) {
    if (this.broken) throw new Error('channel down');
    this.sent.push(req);
    for (const item of this.script(req)) {
      const reply = { ...item.reply, reqId: item.reply.reqId ?? req.reqId } as AdvisorReply;
      if (item.delayMs && item.delayMs > 0) this.schedule(() => this.emit(reply), item.delayMs); else this.emit(reply);
    }
  }
  onReply(cb: ReplyCb) { this.cbs.push(cb); }
  inject(reply: AdvisorReply) { this.emit(reply); }
  private emit(r: AdvisorReply) { for (const cb of this.cbs) cb(r); }
}

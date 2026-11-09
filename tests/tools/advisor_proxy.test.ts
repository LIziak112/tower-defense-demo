import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

// 开发代理（tools/advisor-proxy.cjs）：游戏 ↔ OpenAI 兼容上游 的翻译层。这里用假 fetch / 假上游验证：凭据只进上游头、不进回包；
// 模型文本→JSON 的宽容解析；超时 / 非 2xx / 不成形三类错误码；请求形状与体积闸门；限流。
const require = createRequire(import.meta.url);
const proxy = require('../../tools/advisor-proxy.cjs') as {
  configFromEnv(env: Record<string, string | undefined>): Cfg;
  checkRequest(body: unknown): string | null;
  extractJson(text: unknown): unknown;
  handleAdvisorRequest(body: unknown, cfg: Cfg, fetchFn?: unknown, now?: () => number): Promise<Reply>;
  createServer(cfg: Cfg, fetchFn?: unknown): http.Server;
  makeLimiter(perMin: number, now?: () => number): () => boolean;
  MAX_BODY: number;
};
type Cfg = { upstream: string; key: string; model: string; authHeader: string; jsonMode: boolean; port: number; path: string; ratePerMin: number };
type Reply = { reqId: string; ok: boolean; payload?: unknown; error?: { code: string; message: string }; provider?: string; latencyMs?: number };

const ENV = { ADVISOR_UPSTREAM_URL: 'https://llm.example/v1/', ADVISOR_API_KEY: 'sk-test-SECRET', ADVISOR_MODEL: 'test-model' };
const cfg = () => proxy.configFromEnv(ENV);
const request = (over: Record<string, unknown> = {}) => ({ v: 1, reqId: 'r7', kind: 'next-wave', deadlineMs: 6000, stateVersion: 12, snapshot: { v: 1 }, llm: { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], max_tokens: 500, json: true }, ...over });
const okFetch = (content: string, status = 200) => {
  const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
  const fn = async (url: string, init: { headers: Record<string, string>; body: string }) => { calls.push({ url, init }); return { ok: status < 300, status, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) }; };
  return { fn, calls };
};

describe('配置', () => {
  it('缺任一必填项就启动失败；基址去尾斜杠；缺省 authorization + json on', () => {
    expect(() => proxy.configFromEnv({})).toThrow(/ADVISOR_UPSTREAM_URL/);
    expect(() => proxy.configFromEnv({ ADVISOR_UPSTREAM_URL: 'x', ADVISOR_MODEL: 'm' })).toThrow(/ADVISOR_API_KEY/);
    const c = cfg();
    expect(c).toMatchObject({ upstream: 'https://llm.example/v1', model: 'test-model', authHeader: 'authorization', jsonMode: true, port: 8787, path: '/advisor', ratePerMin: 30 });
  });
});

describe('请求闸门', () => {
  it('形状不对一律 BAD_REQUEST，不碰上游', async () => {
    expect(proxy.checkRequest(null)).toMatch(/对象/);
    expect(proxy.checkRequest(request({ v: 2 }))).toMatch(/v/);
    expect(proxy.checkRequest(request({ kind: 'cheat' }))).toMatch(/kind/);
    expect(proxy.checkRequest(request({ llm: { messages: [] } }))).toMatch(/messages/);
    expect(proxy.checkRequest(request({ llm: { messages: [{ role: 'user', content: 'x' }], max_tokens: 99999 } }))).toMatch(/max_tokens/);
    expect(proxy.checkRequest(request())).toBeNull();
    const f = okFetch('{}');
    const r = await proxy.handleAdvisorRequest(request({ kind: 'cheat' }), cfg(), f.fn);
    expect(r).toMatchObject({ reqId: 'r7', ok: false, error: { code: 'BAD_REQUEST' } });
    expect(f.calls).toHaveLength(0);
  });
});

describe('转发', () => {
  it('messages 原样转；凭据只在上游头里；带 json 模式；回包不含密钥', async () => {
    const f = okFetch('```json\n{"v":1,"basedOn":12,"options":[{"id":"a","title":"t","why":"w","moves":[]}]}\n```');
    const r = await proxy.handleAdvisorRequest(request(), cfg(), f.fn, () => 1000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://llm.example/v1/chat/completions');
    expect(f.calls[0].init.headers.authorization).toBe('Bearer sk-test-SECRET');
    const sent = JSON.parse(f.calls[0].init.body);
    expect(sent).toMatchObject({ model: 'test-model', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], max_tokens: 500, response_format: { type: 'json_object' } });
    expect(r.ok).toBe(true);
    expect(r.payload).toEqual({ v: 1, basedOn: 12, options: [{ id: 'a', title: 't', why: 'w', moves: [] }] });
    expect(r.provider).toBe('test-model');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
  it('自定义凭据头（内部网关）：原样放 key，不加 Bearer；json off 不带 response_format', async () => {
    const c = proxy.configFromEnv({ ...ENV, ADVISOR_AUTH_HEADER: 'X-Internal-Api-Key', ADVISOR_JSON_MODE: 'off' });
    const f = okFetch('{"v":1,"basedOn":1,"options":[]}');
    await proxy.handleAdvisorRequest(request(), c, f.fn);
    expect(f.calls[0].init.headers['x-internal-api-key']).toBe('sk-test-SECRET');
    expect(f.calls[0].init.headers.authorization).toBeUndefined();
    expect(JSON.parse(f.calls[0].init.body).response_format).toBeUndefined();
  });
  it('上游非 2xx → TRANSPORT；内容不是 JSON → BAD_SHAPE；超时 → TIMEOUT（比游戏截止早半秒）', async () => {
    expect((await proxy.handleAdvisorRequest(request(), cfg(), okFetch('x', 502).fn)).error?.code).toBe('TRANSPORT');
    expect((await proxy.handleAdvisorRequest(request(), cfg(), okFetch('这不是 JSON，军师在闲聊').fn)).error?.code).toBe('BAD_SHAPE');
    const hang = (_u: string, init: { signal: AbortSignal }) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const t0 = Date.now();
    const r = await proxy.handleAdvisorRequest(request({ deadlineMs: 1300 }), cfg(), hang);
    expect(r.error?.code).toBe('TIMEOUT');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(750);
    expect(Date.now() - t0).toBeLessThan(1300);
  });
  it('宽容解析：围栏、前后闲话、直接 JSON 都认；实在不是就 null', () => {
    expect(proxy.extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(proxy.extractJson('好的，建议如下：{"a":1} 请采纳')).toEqual({ a: 1 });
    expect(proxy.extractJson('```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(proxy.extractJson('没有 JSON')).toBeNull();
    expect(proxy.extractJson(null)).toBeNull();
  });
});

describe('HTTP 服务', () => {
  it('CORS 预检、路径/方法闸门、体积上限、限流、端到端回包', async () => {
    const c = { ...cfg(), ratePerMin: 2, path: '/advisor' };
    const f = okFetch('{"v":1,"basedOn":12,"options":[{"id":"a","title":"t","why":"w","moves":[]}]}');
    const server = proxy.createServer(c, f.fn);
    await new Promise<void>((res) => server.listen(0, res));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const pre = await fetch(`${base}/advisor`, { method: 'OPTIONS' });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe('*');
      expect((await fetch(`${base}/nope`, { method: 'POST', body: '{}' })).status).toBe(404);
      expect((await fetch(`${base}/advisor`)).status).toBe(405);
      const big = await fetch(`${base}/advisor`, { method: 'POST', body: 'x'.repeat(proxy.MAX_BODY + 10) });
      expect(big.status).toBe(413);
      const r1 = await (await fetch(`${base}/advisor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()) })).json() as Reply;
      expect(r1).toMatchObject({ reqId: 'r7', ok: true, provider: 'test-model' });
      const r2 = await (await fetch(`${base}/advisor`, { method: 'POST', body: JSON.stringify(request({ reqId: 'r8' })) })).json() as Reply;
      expect(r2.ok).toBe(true);
      const r3 = await (await fetch(`${base}/advisor`, { method: 'POST', body: JSON.stringify(request({ reqId: 'r9' })) })).json() as Reply;
      expect(r3).toMatchObject({ reqId: 'r9', ok: false, error: { code: 'RATE_LIMITED' } });
      expect(f.calls).toHaveLength(2);
    } finally { await new Promise<void>((res) => server.close(() => res())); }
  });
  it('限流按滑动一分钟窗口', () => {
    let t = 0;
    const allow = proxy.makeLimiter(2, () => t);
    expect([allow(), allow(), allow()]).toEqual([true, true, false]);
    t = 61_000;
    expect(allow()).toBe(true);
  });
});

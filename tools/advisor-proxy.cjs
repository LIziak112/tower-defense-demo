#!/usr/bin/env node
// 军师开发代理（任务 fb4d93bc）：游戏 ?advisor=http://localhost:8787/advisor 时的 HTTP 通道对端。
// 职责只有三件：① 校验游戏发来的 AdvisorRequest 形状与体积；② 把 llm.messages 原样转给 OpenAI 兼容的 /chat/completions，补上凭据与 JSON 模式；
// ③ 把模型回的文本解析成 JSON 塞进 AdvisorReply。提示词、快照、建议内容都由游戏负责，代理不懂也不改。
// 凭据只从运行代理的进程环境读（ADVISOR_API_KEY），不写日志、不回给游戏；游戏包（src/）永远拿不到端点和密钥。
//
//   ADVISOR_UPSTREAM_URL   OpenAI 兼容基址，例如 https://api.openai.com/v1 或 Hikos 中继 …/llm/<endpoint>/v1（必填）
//   ADVISOR_API_KEY        上游密钥（必填；也可用 ADVISOR_API_KEY_FILE 指向只含密钥的文件）
//   ADVISOR_MODEL          模型名（必填）
//   ADVISOR_AUTH_HEADER    凭据头，默认 authorization（值 Bearer <key>）；写别的头名则原样放 <key>（内部网关类）
//   ADVISOR_JSON_MODE      默认 on：带 response_format:{type:'json_object'}；上游不支持就设 off
//   ADVISOR_PORT           监听端口，默认 8787；ADVISOR_PATH 路径，默认 /advisor
//   ADVISOR_RATE_PER_MIN   每分钟最多转发的请求数，默认 30（超了回 ok:false RATE_LIMITED，游戏自然走本地模板）
'use strict';
const http = require('node:http');
const fs = require('node:fs');

const MAX_BODY = 64 * 1024;
const MIN_TIMEOUT = 800;

function readKey(env) {
  if (env.ADVISOR_API_KEY) return env.ADVISOR_API_KEY;
  if (env.ADVISOR_API_KEY_FILE) return fs.readFileSync(env.ADVISOR_API_KEY_FILE, 'utf8').trim();
  return '';
}

/** 从进程环境装配配置；缺项抛错（启动时就失败，不要带病服务） */
function configFromEnv(env = process.env) {
  const upstream = (env.ADVISOR_UPSTREAM_URL || '').replace(/\/+$/, '');
  const key = readKey(env);
  const model = env.ADVISOR_MODEL || '';
  const missing = [!upstream && 'ADVISOR_UPSTREAM_URL', !key && 'ADVISOR_API_KEY', !model && 'ADVISOR_MODEL'].filter(Boolean);
  if (missing.length) throw new Error(`缺少环境变量：${missing.join(', ')}`);
  return {
    upstream, key, model,
    authHeader: (env.ADVISOR_AUTH_HEADER || 'authorization').toLowerCase(),
    jsonMode: (env.ADVISOR_JSON_MODE || 'on') !== 'off',
    port: Number(env.ADVISOR_PORT || 8787),
    path: env.ADVISOR_PATH || '/advisor',
    ratePerMin: Number(env.ADVISOR_RATE_PER_MIN || 30),
  };
}

/** 游戏请求的最小形状校验：只看代理要用的字段 */
function checkRequest(body) {
  if (!body || typeof body !== 'object') return '请求体不是对象';
  if (body.v !== 1) return 'v 必须是 1';
  if (typeof body.reqId !== 'string' || !body.reqId) return '缺 reqId';
  if (!['next-wave', 'tactical', 'level'].includes(body.kind)) return `未知 kind：${body.kind}`;
  if (typeof body.deadlineMs !== 'number' || !(body.deadlineMs > 0)) return 'deadlineMs 非法';
  const llm = body.llm;
  if (!llm || !Array.isArray(llm.messages) || !llm.messages.length) return '缺 llm.messages';
  for (const m of llm.messages) if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') return 'llm.messages 元素形状错';
  if (llm.max_tokens != null && !(Number.isInteger(llm.max_tokens) && llm.max_tokens > 0 && llm.max_tokens <= 8192)) return 'max_tokens 非法';
  return null;
}

/** 模型回的文本 → JSON（容忍 ```json 围栏与前后闲话） */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* 继续 */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; } }
  return null;
}

function makeLimiter(perMin, now = Date.now) {
  const stamps = [];
  return () => {
    const t = now();
    while (stamps.length && t - stamps[0] > 60_000) stamps.shift();
    if (stamps.length >= perMin) return false;
    stamps.push(t);
    return true;
  };
}

/** 核心：AdvisorRequest → AdvisorReply。fetchFn 可注入（测试用）；永远 resolve，不抛 */
async function handleAdvisorRequest(body, cfg, fetchFn = globalThis.fetch, now = Date.now) {
  const t0 = now();
  const bad = checkRequest(body);
  if (bad) return { reqId: body && typeof body.reqId === 'string' ? body.reqId : '', ok: false, error: { code: 'BAD_REQUEST', message: bad } };
  const headers = { 'content-type': 'application/json' };
  headers[cfg.authHeader] = cfg.authHeader === 'authorization' ? `Bearer ${cfg.key}` : cfg.key;
  const payload = { model: cfg.model, messages: body.llm.messages, temperature: 0.4, max_tokens: body.llm.max_tokens || 600 };
  if (cfg.jsonMode && body.llm.json !== false) payload.response_format = { type: 'json_object' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(MIN_TIMEOUT, body.deadlineMs - 500));   // 比游戏截止早半秒回，留给往返
  try {
    const res = await fetchFn(`${cfg.upstream}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
    const text = await res.text();
    if (!res.ok) return { reqId: body.reqId, ok: false, error: { code: 'TRANSPORT', message: `upstream HTTP ${res.status}` }, provider: cfg.model, latencyMs: now() - t0 };
    let data; try { data = JSON.parse(text); } catch { data = null; }
    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
    const parsed = extractJson(content);
    if (parsed === null) return { reqId: body.reqId, ok: false, error: { code: 'BAD_SHAPE', message: 'upstream content is not JSON' }, provider: cfg.model, latencyMs: now() - t0 };
    return { reqId: body.reqId, ok: true, payload: parsed, provider: cfg.model, latencyMs: now() - t0 };
  } catch (e) {
    const code = ac.signal.aborted ? 'TIMEOUT' : 'TRANSPORT';
    return { reqId: body.reqId, ok: false, error: { code, message: e && e.message ? e.message : String(e) }, provider: cfg.model, latencyMs: now() - t0 };
  } finally { clearTimeout(timer); }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { req.resume(); return reject(new Error('body too large')); }   // 声明就超：不读，直接拒（剩余字节排空，连接还能回 413）
    let size = 0; const chunks = [];
    const onData = (c) => {
      size += c.length;
      if (size > limit) { req.removeListener('data', onData); req.resume(); reject(new Error('body too large')); return; }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer(cfg, fetchFn = globalThis.fetch) {
  const allow = makeLimiter(cfg.ratePerMin);
  return http.createServer(async (req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    const url = new URL(req.url || '/', 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (url.pathname !== cfg.path) { res.writeHead(404, cors); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }
    let text;
    try { text = await readBody(req, MAX_BODY); } catch (e) { res.writeHead(413, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ reqId: '', ok: false, error: { code: 'BAD_REQUEST', message: String(e.message || e) } })); }
    let body; try { body = JSON.parse(text); } catch { body = null; }
    const reqId = body && typeof body.reqId === 'string' ? body.reqId : '';
    let reply;
    if (!allow()) reply = { reqId, ok: false, error: { code: 'RATE_LIMITED', message: `more than ${cfg.ratePerMin} requests per minute` } };
    else reply = await handleAdvisorRequest(body, cfg, fetchFn);
    console.log(`[advisor-proxy] ${body && body.kind} ${reqId} → ${reply.ok ? 'ok' : reply.error.code} ${reply.latencyMs != null ? reply.latencyMs + 'ms' : ''}`);
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
}

if (require.main === module) {
  const cfg = configFromEnv();
  createServer(cfg).listen(cfg.port, () => console.log(`[advisor-proxy] http://localhost:${cfg.port}${cfg.path} → ${cfg.upstream} (${cfg.model}, json ${cfg.jsonMode ? 'on' : 'off'})；游戏加 ?advisor=http://localhost:${cfg.port}${cfg.path}`));
}

module.exports = { configFromEnv, checkRequest, extractJson, handleAdvisorRequest, createServer, makeLimiter, MAX_BODY };

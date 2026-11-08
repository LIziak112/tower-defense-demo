// 关卡设计走真 LLM（C1，「复仇一局」复用）：与战斗建议共用同一条通道与同一套代理契约，kind = 'level'。
// 本模块不读任何端点 / 密钥（D2 护栏）：请求经通道交给宿主代理 / 开发代理，由它们加凭据。
import assets from '../content/assets.json';
import A from '../content/packs/changban_rain_night.json';
import type { RawPack } from '../content/schema';
import { levelPrompt } from '../advisor/prompt';
import { LIMITS, type AdvisorChannel, type AdvisorReply, type AdvisorRequest } from '../advisor/types';
import type { GenerateInput } from './provider';

export interface LlmProviderOptions { lang?: 'zh' | 'en'; deadlineMs?: number; name?: string }

export class LlmContentProvider {
  readonly name: string;
  readonly isMock = false;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: RawPack) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly lang: 'zh' | 'en';
  private readonly deadlineMs: number;
  constructor(private readonly channel: AdvisorChannel, opts: LlmProviderOptions = {}) {
    this.lang = opts.lang ?? 'zh';
    this.deadlineMs = opts.deadlineMs ?? LIMITS.levelDeadlineMs;
    this.name = opts.name ?? `LLM 军师（${channel.name}）`;
    channel.onReply((r) => this.onReply(r));
  }
  /** 返回未经校验的 RawPack（校验在 pipeline 里，和 Mock 一样走三层校验 + 重试）；超时 / 错误 / 非 JSON 抛错 */
  generateContent(input: GenerateInput): Promise<RawPack> {
    const reqId = `L${++this.seq}`;
    const prompt = levelPrompt({
      text: input.text, example: A as RawPack, previous: input.previous, errors: input.errors,
      assetIds: assets.assets.map((a) => a.asset_id), paletteIds: assets.palettes.map((p) => p.palette_id), tilesetIds: assets.tilesets.map((t) => t.tileset_id),
    }, this.lang);
    const req: AdvisorRequest = { v: 1, reqId, kind: 'level', deadlineMs: this.deadlineMs, stateVersion: 0, llm: { ...prompt, json: true } };
    return new Promise<RawPack>((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(reqId)) reject(new Error('TIMEOUT')); }, this.deadlineMs);
      this.pending.set(reqId, { resolve, reject, timer });
      try { this.channel.post(req); } catch (e) { clearTimeout(timer); this.pending.delete(reqId); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }
  private onReply(r: AdvisorReply) {
    const p = this.pending.get(r.reqId);
    if (!p) return;
    this.pending.delete(r.reqId);
    clearTimeout(p.timer);
    if (!r.ok) return p.reject(new Error(r.error.code || 'TRANSPORT'));
    if (!r.payload || typeof r.payload !== 'object') return p.reject(new Error('BAD_SHAPE'));
    p.resolve(r.payload as RawPack);
  }
}

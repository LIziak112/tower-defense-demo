// 关卡设计走真 LLM（C1，「复仇一局」复用）：与战斗建议共用同一条通道与同一套代理契约，kind = 'level'。
// 支持 SSE 流式增量（onStream）并将超时策略设为首包 + 空闲超时（只要流式 chunk 持续到达就重置定时器，不再 20s 无反馈直接 TIMEOUT）。
// 本模块不读任何端点 / 密钥（D2 护栏）：请求经通道交给宿主代理 / 开发代理，由它们加凭据。
import assets from '../content/assets.json';
import { openingRaw } from '../content/opening';
import type { RawPack } from '../content/schema';
import { levelPrompt } from '../advisor/prompt';
import { LIMITS, type AdvisorAgent, type AdvisorChannel, type AdvisorReply, type AdvisorRequest, type AdvisorStreamEvent } from '../advisor/types';
import { sanitizeLlmPack } from '../content/sanitize';
import type { GenerateInput } from './provider';

export interface LlmProviderOptions {
  lang?: 'zh' | 'en';
  deadlineMs?: number;
  name?: string;
  agent?: AdvisorAgent | null;
  onStream?: (ev: AdvisorStreamEvent) => void;
}

interface PendingLevel {
  resolve: (v: RawPack) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  resetTimer: () => void;
  text: string;
  chars: number;
  onStream?: (ev: AdvisorStreamEvent) => void;
}

export class LlmContentProvider {
  private readonly customName?: string;
  readonly isMock = false;
  private seq = 0;
  private pending = new Map<string, PendingLevel>();
  lang: 'zh' | 'en';
  private readonly deadlineMs: number;
  agent: AdvisorAgent | null = null;
  onStream?: (ev: AdvisorStreamEvent) => void;

  constructor(private readonly channel: AdvisorChannel, opts: LlmProviderOptions = {}) {
    this.lang = opts.lang ?? 'zh';
    this.deadlineMs = opts.deadlineMs ?? LIMITS.levelDeadlineMs;
    this.customName = opts.name;
    this.agent = opts.agent ?? channel.agent ?? null;
    this.onStream = opts.onStream;
    channel.onReply((r) => this.onReply(r));
    channel.onStream?.((ev) => this.handleStream(ev));
  }

  get name(): string {
    const a = this.agent ?? this.channel.agent ?? null;
    if (a?.name) return a.title ? `${a.name} · ${a.title}` : a.name;
    return this.customName ?? `LLM 军师（${this.channel.name}）`;
  }

  setAgent(agent: AdvisorAgent | null) {
    this.agent = agent;
  }

  /** 返回未经校验的 RawPack（校验在 pipeline 里，和 Mock 一样走三层校验 + 重试）；超时按首包/空闲超时控制 */
  generateContent(input: GenerateInput & { onStream?: (ev: AdvisorStreamEvent) => void }): Promise<RawPack> {
    const reqId = `L${++this.seq}`;
    const activeAgent = this.agent ?? this.channel.agent ?? null;
    const prompt = levelPrompt({
      text: input.text, example: openingRaw(), previous: input.previous, errors: input.errors,
      assetIds: assets.assets.map((a) => a.asset_id), paletteIds: assets.palettes.map((p) => p.palette_id), tilesetIds: assets.tilesets.map((t) => t.tileset_id),
      agent: activeAgent,
    }, this.lang);
    const req: AdvisorRequest = {
      v: 1,
      reqId,
      kind: 'level',
      deadlineMs: this.deadlineMs,
      stateVersion: 0,
      stream: true,
      ...(activeAgent ? { agent: activeAgent } : {}),
      llm: { ...prompt, json: true },
    };
    return new Promise<RawPack>((resolve, reject) => {
      const entry: PendingLevel = {
        resolve,
        reject,
        timer: null,
        text: '',
        chars: 0,
        onStream: input.onStream,
        resetTimer: () => {
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            if (this.pending.delete(reqId)) reject(new Error('TIMEOUT'));
          }, this.deadlineMs);
        },
      };
      entry.resetTimer();
      this.pending.set(reqId, entry);
      try {
        this.channel.post(req);
      } catch (e) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pending.delete(reqId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private handleStream(ev: AdvisorStreamEvent) {
    const p = this.pending.get(ev.reqId);
    if (!p) return;
    // 收到 SSE 流式增量包 → 重置空闲超时计时器，不再因总耗时超 20s 而 TIMEOUT
    p.resetTimer();
    const delta = ev.delta ?? '';
    p.text = ev.text ?? (p.text + delta);
    p.chars = ev.chars ?? p.text.length;
    const merged: AdvisorStreamEvent = {
      reqId: ev.reqId,
      delta,
      text: p.text,
      chars: p.chars,
      stage: ev.stage,
      provider: ev.provider,
    };
    p.onStream?.(merged);
    this.onStream?.(merged);
  }

  private onReply(r: AdvisorReply) {
    const p = this.pending.get(r.reqId);
    if (!p) return;
    this.pending.delete(r.reqId);
    if (p.timer) clearTimeout(p.timer);
    if (!r.ok) return p.reject(new Error(r.error.code || 'TRANSPORT'));
    if (!r.payload || typeof r.payload !== 'object') return p.reject(new Error('BAD_SHAPE'));
    p.resolve(sanitizeLlmPack(r.payload));
  }
}

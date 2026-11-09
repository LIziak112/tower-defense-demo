// generate -> validate -> (retry ≤3 with errors) -> compile -> dry-run -> summary card data.
// On final failure: human-readable reasons + fallback to default pack (plan §7, Demo §5.1).
import { validatePack, type VError, type VWarning } from '../content/validate';
import { compilePack } from '../content/compile';
import { balanceWarnings, type DryRunResult } from '../content/dryrun';
import type { ContentPack } from '../runtime/types';
import type { RawPack } from '../content/schema';
import type { ContentProvider } from './provider';
import { parseKeywords } from './mock';
import A from '../content/packs/changban_rain_night.json';

export interface Summary {
  ok: boolean; fallback: boolean; provider: string; is_mock: boolean; attempts: number;
  theme: string; description: string; echo: string;
  towers: string[]; enemies: string[]; waves: { id: string; total: number }[];
  warnings: VWarning[]; errors: VError[]; dryrun: DryRunResult[];
  pack: ContentPack; raw: RawPack;
  /** 异步管线的备注（如「LLM 超时，改用本地模板军师」）；同步管线没有 */
  note?: string;
}

/** 关卡设计流式进度快照 */
export interface LevelStreamProgress {
  round: number;
  maxRounds: number;
  chars: number;
  text: string;
  stage: string;
  provider?: string;
}

/** 异步 provider（真 LLM 走通道）：与 ContentProvider 同形，只是 generateContent 可以返回 Promise 并支持流式回调 */
export interface AsyncContentProvider {
  readonly name: string;
  readonly isMock: boolean;
  generateContent(input: { text: string; previous?: RawPack; errors?: VError[]; onStream?: (ev: { reqId: string; delta?: string; text?: string; chars?: number; stage?: string; provider?: string }) => void }): RawPack | Promise<RawPack>;
}

/**
 * 与 runPipeline 同一条链（generate → validate → ≤3 轮带错重试 → compile → dry-run），只是等得起 Promise 并实时回传 SSE 流式进度。
 * provider 抛错（超时 / 断网 / 非 JSON）→ 整条换 fallbackProvider 重跑并在 note 里说明；没有 fallbackProvider 就抛出。
 */
export async function runPipelineAsync(
  provider: AsyncContentProvider,
  text: string,
  maxRounds = 3,
  fallbackProvider?: ContentProvider,
  onProgress?: (p: LevelStreamProgress) => void,
): Promise<Summary> {
  try {
    let attempts = 1;
    onProgress?.({ round: 1, maxRounds, chars: 0, text: '', stage: '军师正在推演第 1 轮战局方案…', provider: provider.name });
    let raw: unknown = await provider.generateContent({
      text,
      onStream: (ev) => onProgress?.({
        round: attempts,
        maxRounds,
        chars: ev.chars ?? (ev.text?.length ?? 0),
        text: ev.text ?? ev.delta ?? '',
        stage: ev.stage ?? `军师正在推演战局阵法（第 ${attempts}/${maxRounds} 轮）…`,
        provider: ev.provider ?? provider.name,
      }),
    });
    let errors: VError[] = [];
    for (attempts = 1; attempts <= maxRounds; attempts++) {
      onProgress?.({ round: attempts, maxRounds, chars: 0, text: '', stage: `正在校验与沙盘预演（第 ${attempts}/${maxRounds} 轮）…`, provider: provider.name });
      const v = validatePack(raw);
      if (v.ok) return build(provider, text, v.pack, attempts, false, []);
      errors = v.errors;
      if (attempts < maxRounds) {
        const nextRound = attempts + 1;
        onProgress?.({ round: nextRound, maxRounds, chars: 0, text: '', stage: `发现 ${errors.length} 处数值越界，军师正在第 ${nextRound}/${maxRounds} 轮调整…`, provider: provider.name });
        raw = await provider.generateContent({
          text,
          previous: raw as RawPack,
          errors,
          onStream: (ev) => onProgress?.({
            round: nextRound,
            maxRounds,
            chars: ev.chars ?? (ev.text?.length ?? 0),
            text: ev.text ?? ev.delta ?? '',
            stage: ev.stage ?? `军师正在调整关卡部署（第 ${nextRound}/${maxRounds} 轮）…`,
            provider: ev.provider ?? provider.name,
          }),
        });
      }
    }
    const fb = validatePack(A);
    if (!fb.ok) throw new Error('默认关卡自身未通过校验');
    return build(provider, text, fb.pack, maxRounds, true, errors);
  } catch (e) {
    if (!fallbackProvider) throw e;
    const code = e instanceof Error ? e.message : String(e);
    const sum = runPipeline(fallbackProvider, text, maxRounds);
    sum.note = `${provider.name} 没能出活（${code}），改用${fallbackProvider.name}。`;
    return sum;
  }
}

export function runPipeline(provider: ContentProvider, text: string, maxRounds = 3): Summary {
  let raw: unknown = provider.generateContent({ text });
  let errors: VError[] = []; let attempts = 0;
  for (attempts = 1; attempts <= maxRounds; attempts++) {
    const v = validatePack(raw);
    if (v.ok) return build(provider, text, v.pack, attempts, false, []);
    errors = v.errors;
    if (attempts < maxRounds) raw = provider.generateContent({ text, previous: raw as RawPack, errors });
  }
  const fb = validatePack(A);
  if (!fb.ok) throw new Error('默认关卡自身未通过校验');
  return build(provider, text, fb.pack, maxRounds, true, errors);
}

/** validate an externally supplied pack (e.g. pasted JSON); invalid -> fallback with reasons */
export function loadPackOrFallback(input: unknown, provider: ContentProvider): Summary {
  const v = validatePack(input);
  if (v.ok) return build(provider, '（导入的内容包）', v.pack, 1, false, []);
  const fb = validatePack(A);
  if (!fb.ok) throw new Error('默认关卡自身未通过校验');
  return build(provider, '（导入的内容包）', fb.pack, 1, true, v.errors);
}

function build(provider: { name: string; isMock: boolean }, text: string, raw: RawPack, attempts: number, fallback: boolean, errors: VError[]): Summary {
  const pack = compilePack(raw);
  const bw = balanceWarnings(pack);
  const m = parseKeywords(text);
  const tweaks = [m.count !== 1 && `敌人数量 ×${m.count}`, m.speed !== 1 && `敌人速度 ×${m.speed}`, m.hp !== 1 && `敌人血量 ×${m.hp}`, m.interval !== 1 && `出兵间隔 ×${m.interval}`].filter(Boolean);
  const echo = fallback
    ? `没能按你说的生成合法关卡，先用默认关卡「${raw.meta.theme}」。`
    : `我按你说的「${text}」设计了「${raw.meta.theme}」：${raw.meta.description}${tweaks.length ? `；并做了调整：${tweaks.join('、')}` : ''}。`;
  return {
    ok: !fallback, fallback, provider: provider.name, is_mock: provider.isMock, attempts,
    theme: raw.meta.theme, description: raw.meta.description, echo,
    towers: raw.towers.map((t) => `${t.display_name}（${t.components.Buildable.cost} 金）`),
    enemies: raw.enemies.map((e) => `${e.display_name}（血 ${e.components.Health.max}）`),
    waves: raw.waves.map((w) => ({ id: w.id, total: w.groups.reduce((a, g) => a + g.count, 0) })),
    warnings: bw.warnings, errors, dryrun: bw.runs, pack, raw,
  };
}

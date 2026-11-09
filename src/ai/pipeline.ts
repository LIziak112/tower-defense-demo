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

function build(provider: ContentProvider, text: string, raw: RawPack, attempts: number, fallback: boolean, errors: VError[]): Summary {
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

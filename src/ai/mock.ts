// Mock 军师（计划书 §5.3 / §7）：关键词 → 模板包 + 参数调制；重试时按错误 path 把越界值夹回区间。
import A from '../content/packs/changban_rain_night.json';
import B from '../content/packs/swamp_miasma.json';
import type { RawPack } from '../content/schema';
import type { VError } from '../content/validate';
import { GUARDRAILS as G } from '../content/guardrails';
import type { ContentProvider, GenerateInput } from './provider';

export interface Modulation { theme: 'A' | 'B'; count: number; speed: number; hp: number; interval: number; matched: string[] }

export function parseKeywords(text: string): Modulation {
  const m: Modulation = { theme: 'A', count: 1, speed: 1, hp: 1, interval: 1, matched: [] };
  const has = (ws: string[]) => ws.filter((w) => text.includes(w));
  const a = has(['雨', '夜', '长坂坡']), b = has(['沼泽', '毒']);
  if (b.length > a.length) { m.theme = 'B'; m.matched.push(...b); } else if (a.length) m.matched.push(...a);
  const k = (ws: string[], f: (m: Modulation) => void) => { const hit = has(ws); if (hit.length) { f(m); m.matched.push(...hit); } };
  k(['多', '人海'], (x) => (x.count = 1.3));
  k(['慢', '缓'], (x) => (x.speed = 0.8));
  k(['肉', '厚'], (x) => (x.hp = 1.3));
  k(['刺激', '猛'], (x) => (x.interval = 0.8));
  if (m.theme === 'B' && text.includes('慢') && !m.matched.includes('慢')) m.matched.push('慢');
  return m;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function modulate(base: RawPack, m: Modulation, text: string): RawPack {
  const p = clone(base);
  p.meta.generated_from = text;
  for (const e of p.enemies) {
    e.components.Health.max = Math.ceil(e.components.Health.max * m.hp);
    e.components.Movement.speed_milli_per_tick = Math.ceil(e.components.Movement.speed_milli_per_tick * m.speed);
  }
  for (const w of p.waves) for (const g of w.groups) {
    g.count = Math.ceil(g.count * m.count);
    g.interval_ticks = Math.max(1, Math.ceil(g.interval_ticks * m.interval));
  }
  return p;
}

/** clamp a value at a JSON pointer back into its `allowed` range (used on retry). */
export function clampByErrors(pack: RawPack, errors: VError[]): RawPack {
  const p = clone(pack) as any;
  for (const e of errors) {
    const al = e.allowed as { min?: number; max?: number } | undefined;
    if (e.code !== 'VALUE_OUT_OF_RANGE' || !al || al.min === undefined) continue;
    const parts = e.path.split('/').slice(1);
    if (parts[0] === 'waves' && parts[2] === 'groups') {
      // per-wave total: scale counts down/up proportionally
      const w = p.waves[Number(parts[1])]; const total = w.groups.reduce((a: number, g: any) => a + g.count, 0);
      const target = Math.min(al.max!, Math.max(al.min, total));
      let left = target;
      w.groups.forEach((g: any, i: number) => { const c = i === w.groups.length - 1 ? left : Math.max(1, Math.floor((g.count * target) / total)); g.count = Math.max(1, c); left -= g.count; });
      continue;
    }
    let o = p; for (let i = 0; i < parts.length - 1; i++) o = o?.[parts[i]];
    const last = parts[parts.length - 1];
    if (o && typeof o[last] === 'number') o[last] = Math.min(al.max!, Math.max(al.min, o[last]));
  }
  return p;
}

export class MockProvider implements ContentProvider {
  readonly name = '本地模板军师（Mock，未接 LLM）';
  readonly isMock = true;
  generateContent(input: GenerateInput): RawPack {
    if (input.previous && input.errors?.length) return clampByErrors(input.previous, input.errors);
    const m = parseKeywords(input.text);
    return modulate((m.theme === 'B' ? B : A) as RawPack, m, input.text);
  }
}
export { G as GUARDRAILS_FOR_PROMPT };

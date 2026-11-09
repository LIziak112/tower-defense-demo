import { describe, it, expect } from 'vitest';
import { validatePack } from '../../src/content/validate';
import { compilePack } from '../../src/content/compile';
import { dryRun } from '../../src/content/dryrun';
import { MockProvider } from '../../src/ai/mock';
import { runPipeline, loadPackOrFallback } from '../../src/ai/pipeline';
import { createBattle, step, checksum } from '../../src/runtime/index';
import A from '../../src/content/packs/changban_rain_night.json';
import B from '../../src/content/packs/swamp_miasma.json';

const clone = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('D2 三层校验', () => {
  it('两套默认包均通过', () => {
    expect(validatePack(A).ok).toBe(true);
    expect(validatePack(B).ok).toBe(true);
  });

  const cases: [string, (p: any) => void, string][] = [
    ['塔 damage', (p) => (p.towers[0].components.Attack.damage = 101), '/towers/0/components/Attack/damage'],
    ['塔 interval', (p) => (p.towers[1].components.Attack.interval_ticks = 4), '/towers/1/components/Attack/interval_ticks'],
    ['塔 range', (p) => (p.towers[2].components.Attack.range_milli = 5001), '/towers/2/components/Attack/range_milli'],
    ['塔 cost', (p) => (p.towers[0].components.Buildable.cost = 19), '/towers/0/components/Buildable/cost'],
    ['敌 hp', (p) => (p.enemies[0].components.Health.max = 99999), '/enemies/0/components/Health/max'],
    ['敌 speed', (p) => (p.enemies[1].components.Movement.speed_milli_per_tick = 151), '/enemies/1/components/Movement/speed_milli_per_tick'],
    ['敌 gold', (p) => (p.enemies[2].components.Reward.gold = 0), '/enemies/2/components/Reward/gold'],
    ['每波总数', (p) => (p.waves[1].groups[0].count = 41), '/waves/1/groups'],
    ['波次数', (p) => (p.waves = p.waves.slice(0, 2)), '/waves'],
    ['路径折点', (p) => { p.map.path = [[0, 1], [4, 1], [4, 3]]; }, '/map/path'],
  ];
  for (const [name, mut, path] of cases) {
    it(`护栏越界被拒：${name} → ${path}`, () => {
      const p = clone(A); mut(p);
      const v = validatePack(p);
      expect(v.ok).toBe(false);
      const e = v.errors.find((x) => x.code === 'VALUE_OUT_OF_RANGE' && x.path === path);
      expect(e, JSON.stringify(v.errors)).toBeTruthy();
      expect(e!.allowed).toHaveProperty('min');
      expect(e!.message).toMatch(/之间/);
    });
  }

  it('语义错误：斜线路径 / 可建格在路径上 / 未知敌人 / 未知素材 / schema 缺字段', () => {
    const p1 = clone(A); p1.map.path[3] = [8, 4];
    expect(validatePack(p1).errors.some((e) => e.code === 'PATH_NOT_CONNECTED' && e.path === '/map/path/3')).toBe(true);
    const p2 = clone(A); p2.map.buildable_cells[0] = [0, 1];
    expect(validatePack(p2).errors.some((e) => e.code === 'BUILDABLE_ON_PATH' && e.path === '/map/buildable_cells/0')).toBe(true);
    const p3 = clone(A); p3.waves[0].groups[0].enemy_id = 'ghost';
    expect(validatePack(p3).errors.some((e) => e.code === 'UNKNOWN_REF' && e.path === '/waves/0/groups/0/enemy_id')).toBe(true);
    const p4 = clone(A); p4.towers[0].components.Presentation.asset_id = 'nope';
    expect(validatePack(p4).errors.some((e) => e.code === 'UNKNOWN_ASSET')).toBe(true);
    const p5 = clone(A); delete p5.towers[0].components.Attack;
    expect(validatePack(p5).errors.some((e) => e.code === 'SCHEMA_INVALID' && e.path.startsWith('/towers/0/components/Attack'))).toBe(true);
    const p6 = clone(A); p6.map.path = [[0, 1], [4, 1], [4, 3], [2, 3], [2, 1], [1, 1]];
    expect(validatePack(p6).errors.some((e) => e.code === 'PATH_SELF_INTERSECT')).toBe(true);
  });
});

describe('D2 数据驱动 / Mock 军师 / dry-run', () => {
  it('换 JSON 即换关卡，不改代码', () => {
    const a = compilePack((validatePack(A) as any).pack), b = compilePack((validatePack(B) as any).pack);
    expect(a.map.path).not.toEqual(b.map.path);
    let sa = createBattle(a, 1), sb = createBattle(b, 1);
    for (let i = 0; i < 300; i++) { sa = step(sa, i === 0 ? [{ type: 'start_wave' }] : []).state; sb = step(sb, i === 0 ? [{ type: 'start_wave' }] : []).state; }
    expect(checksum(sa)).not.toBe(checksum(sb));
  });

  it('5 句不同描述得到可辨差异的关卡，均合法', () => {
    const mp = new MockProvider();
    const texts = ['长坂坡雨夜', '沼泽里来点毒', '人海战术，多来点', '敌人肉一点厚一点', '来点刺激的，猛一些'];
    const sums = texts.map((t) => runPipeline(mp, t));
    for (const s of sums) { expect(s.ok).toBe(true); expect(s.fallback).toBe(false); expect(s.raw.meta.generated_from).toBeDefined(); }
    const sig = new Set(sums.map((s) => JSON.stringify([s.theme, s.raw.enemies.map((e) => e.components), s.raw.waves])));
    expect(sig.size).toBe(5);
    expect(sums[1].theme).toBe('沼泽·毒雾');
    expect(sums[2].echo).toMatch(/数量/);
  });

  it('越界后 Mock 按 path 夹回区间', () => {
    const mp = new MockProvider();
    const bad = clone(A); bad.enemies[0].components.Health.max = 99999; bad.waves[0].groups[0].count = 60;
    const v = validatePack(bad); expect(v.ok).toBe(false);
    const fixed = mp.generateContent({ text: 'x', previous: bad, errors: v.errors });
    expect(validatePack(fixed).ok).toBe(true);
    expect(fixed.enemies[0].components.Health.max).toBe(2000);
  });

  it('非法包显示人话原因并回退默认关卡', () => {
    const bad = clone(A); bad.map.path[3] = [8, 4];
    const s = loadPackOrFallback(bad, new MockProvider());
    expect(s.fallback).toBe(true);
    expect(s.theme).toBe('长坂坡·雨夜');
    expect(s.errors[0].message).toMatch(/不在同一行或同一列/);
    expect(s.echo).toMatch(/默认关卡/);
  });

  it('dry-run 可复现，且默认包「不放塔必输 / 贪心能赢」', () => {
    for (const P of [A, B]) {
      const pk = compilePack((validatePack(P) as any).pack);
      expect(dryRun(pk, 'greedy', 3)).toEqual(dryRun(pk, 'greedy', 3));
      expect(dryRun(pk, 'no_towers').result).toBe('lost');
      expect(dryRun(pk, 'greedy').result).toBe('won');
    }
  });

  it('摘要卡标明 Mock、发布包不读 LLM 密钥', async () => {
    const s = runPipeline(new MockProvider(), '雨夜');
    expect(s.is_mock).toBe(true);
    expect(s.provider).toMatch(/Mock/);
    const fs = await import('node:fs');
    const all = ['src/ai', 'src/content', 'src/game', 'src/runtime'].flatMap((d) => fs.existsSync(d) ? fs.readdirSync(d).map((f) => `${d}/${f}`) : []).filter((f) => f.endsWith('.ts'));
    for (const f of all) expect(fs.readFileSync(f, 'utf8')).not.toMatch(/VITE_LLM|API_KEY|import\.meta\.env/);
  });
});

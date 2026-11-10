// Minimal headless dry-run (Demo §5.4): "no towers" and "greedy" bots. Deterministic, no rendering.
import { createBattle, step, milliOf, pathSamples } from '../runtime/index';
import type { BattleState, Command, ContentPack } from '../runtime/types';
import type { VWarning } from './validate';

export interface DryRunResult { bot: 'no_towers' | 'poor_placement' | 'greedy'; result: 'won' | 'lost' | 'timeout'; base_hp: number; leaks: number; kills: number; towers: number; ticks: number; first_wave_leaks: number }

function bestCells(pack: ContentPack, range: number): { x: number; y: number }[] {
  // score = number of path sample points within range of the cell centre
  // 每 1 格一个采样点、不含终点（与旧的逐格展开同一组点）；自由几何下沿真实折线采样
  const pts: [number, number][] = pathSamples(pack.map.path).slice(0, -1).map((p) => [p.x, p.y]);
  // 多分支：分支路线上的采样点同样计分（没有分支的内容包结果不变）
  for (const bp of pack.map.branch_paths ?? []) for (const p of pathSamples(bp).slice(0, -1)) pts.push([p.x, p.y]);
  return pack.map.buildable_cells
    .map((c) => ({ c, s: pts.filter(([px, py]) => (px - milliOf(c.x)) ** 2 + (py - milliOf(c.y)) ** 2 <= range * range).length }))
    .sort((a, b) => b.s - a.s || a.c.y - b.c.y || a.c.x - b.c.x).map((v) => v.c);
}

export function dryRun(pack: ContentPack, bot: 'no_towers' | 'poor_placement' | 'greedy', seed = 1, maxTicks = 60000): DryRunResult {
  let s: BattleState = createBattle(pack, seed);
  // greedy picks the tower with best dps per gold
  const tower = [...pack.towers].sort((a, b) => (b.damage / b.interval_ticks / b.cost) - (a.damage / a.interval_ticks / a.cost))[0];
  const worstTower = [...pack.towers].sort((a, b) => (a.damage / a.interval_ticks / a.cost) - (b.damage / b.interval_ticks / b.cost))[0] ?? tower;
  const cells = bestCells(pack, tower.range);
  const poorCells = [...cells].reverse();
  let firstWaveLeaks = -1;
  while (s.tick < maxTicks && s.phase !== 'won' && s.phase !== 'lost') {
    const cmds: Command[] = [];
    if (s.phase === 'build') {
      if (s.wave_index === 1 && firstWaveLeaks < 0) firstWaveLeaks = s.leaks;
      if (bot === 'greedy') {
        let gold = s.gold, idx = s.towers.length;
        while (gold >= tower.cost && idx < cells.length) { cmds.push({ type: 'build', tower_id: tower.id, x: cells[idx].x, y: cells[idx].y }); gold -= tower.cost; idx++; }
      } else if (bot === 'poor_placement') {
        // 不合理布防：只在远离路径的边缘角落放 1 座低性价比塔，不继续补防
        if (s.wave_index === 0 && s.gold >= worstTower.cost && poorCells.length > 0) {
          cmds.push({ type: 'build', tower_id: worstTower.id, x: poorCells[0].x, y: poorCells[0].y });
        }
      }
      cmds.push({ type: 'start_wave' });
    }
    s = step(s, cmds).state;
  }
  if (firstWaveLeaks < 0) firstWaveLeaks = s.leaks;
  return { bot, result: s.phase === 'won' || s.phase !== 'lost' ? (s.phase === 'won' ? 'won' : 'timeout') : 'lost', base_hp: s.base_hp, leaks: s.leaks, kills: s.kills, towers: s.towers.length, ticks: s.tick, first_wave_leaks: firstWaveLeaks };
}

/** W1/W2 heuristics (Demo §4.5) + dry-run warnings. Warnings never reject. */
export function balanceWarnings(pack: ContentPack): { warnings: VWarning[]; runs: DryRunResult[] } {
  const warnings: VWarning[] = [];
  const runs = [dryRun(pack, 'no_towers'), dryRun(pack, 'greedy')];
  const [none, greedy] = runs;
  if (greedy.first_wave_leaks > 0 && greedy.first_wave_leaks * 2 >= pack.waves[0].groups.reduce((a, g) => a + g.count, 0))
    warnings.push({ code: 'W1_FIRST_WAVE_HARD', message: `首波可能打不过：贪心放塔预演第 1 波漏了 ${greedy.first_wave_leaks} 只` });
  const income = pack.waves.reduce((a, w) => a + w.groups.reduce((b, g) => b + g.count * (pack.enemies.find((e) => e.id === g.enemy_id)?.reward ?? 0), 0), 0);
  const minCost = Math.min(...pack.towers.map((t) => t.cost));
  if (income < minCost) warnings.push({ code: 'W2_ECONOMY', message: `整局 CP 奖励 ${income} 还买不起一座最便宜的塔（${minCost} CP）` });
  if (income > minCost * 40) warnings.push({ code: 'W2_ECONOMY', message: `整局 CP 奖励 ${income} 远超塔价，CP 会溢出` });
  if (none.result === 'won') warnings.push({ code: 'DRYRUN_TOO_EASY', message: '预演：一座塔不放也能赢，关卡可能太简单' });
  if (greedy.result !== 'won') warnings.push({ code: 'DRYRUN_TOO_HARD', message: `预演：贪心放塔也${greedy.result === 'lost' ? '输了' : '没打完'}（基地剩 ${greedy.base_hp}），关卡可能太难` });
  return { warnings, runs };
}

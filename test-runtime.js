const assert = require('assert');
const { Runtime, dryRun, makePack, validatePack, validateAdjust } = require('./runtime.js');

function clear(pack, seed = 7) {
  const game = new Runtime(pack, seed);
  game.addUnit('blade', 0, 2); game.addUnit('spear', 1, 2);
  game.addUnit('bow', 2, 2); game.addUnit('bow', 3, 2);
  game.startWave();
  for (let tick = 0; tick < 9000 && !['win', 'lose'].includes(game.phase); tick++) {
    game.step();
    if (game.phase === 'build') game.startWave();
  }
  return game;
}

const pack = makePack('长坂坡雨夜');
assert(validatePack(pack).ok, '默认内容包必须可加载');
assert.deepEqual(pack.map.terrain[0].tags, ['HIGH_GROUND'], '地形必须属于内容包而不是展示层常量');
assert.equal(pack.modifiers[0].value, 12000, 'Modifier 必须属于内容包并可序列化');
assert(!validatePack({}).ok, '缺字段内容包必须被拒绝');
const missingTerrain = makePack('古道'); delete missingTerrain.map.terrain;
assert(!validatePack(missingTerrain).ok, '缺少地形声明的内容包必须被拒绝');
assert.throws(() => new Runtime(missingTerrain), /Invalid content pack/, 'Runtime 不得绕过内容包校验');
const unsafeRule = makePack('雨夜'); unsafeRule.rules[1].then[0].count = 99;
assert(!validatePack(unsafeRule).ok, '超出预算的链式效果必须被拒绝');
assert(!validateAdjust({ command: 'adjust_next_wave', params: { count_mul_bps: 1 } }).ok, '越界军令必须被拒绝');
const a = clear(pack), b = clear(pack);
assert.equal(a.phase, 'win', '推荐布防必须能通关');
assert.equal(a.checksum(), b.checksum(), '相同种子和指令必须确定');
assert.deepEqual(dryRun(pack), dryRun(pack), 'dry-run 必须不依赖展示层且可复现');
assert.equal(dryRun(pack).phase, 'win', '默认内容包的 dry-run 必须可通关');
const wet = new Runtime(makePack('雨夜沼泽'));
wet.addUnit('bow', 2); wet.addUnit('spear', 1); wet.startWave();
let froze = false, chained = false;
for (let tick = 0; tick < 800; tick++) { wet.step(); const snap = wet.snapshot(); froze ||= snap.enemies.some(e => e.frozen); chained ||= snap.shots.some(s => s.kind === 'lightning'); }
assert(froze && chained, '雨天冻结与导电链伤必须由内容包规则触发');
const terrain = new Runtime(makePack('古道'));
terrain.addUnit('bow', 2);
assert.equal(terrain.stats(terrain.towers[0]).range, 8400, '高地 Modifier 必须在 Runtime 中提升射程');
const isolated = new Runtime(makePack('古道')); isolated.addUnit('bow', 2);
const displayState = isolated.snapshot(); displayState.gold = -1; displayState.towers[0].level = 99;
assert.equal(isolated.gold, 100, '展示快照不得反向修改 Runtime 金币');
assert.equal(isolated.towers[0].level, 1, '展示快照不得反向修改 Runtime 单位');
console.log('PASS runtime: deterministic win, validation guards, no presentation required');

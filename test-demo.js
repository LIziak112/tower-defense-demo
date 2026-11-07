const fs = require('fs');
const vm = require('vm');

const elements = new Map();
const context = new Proxy({}, { get: (target, key) => target[key] || (target[key] = () => {}) });
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    id, textContent: '', innerHTML: '', disabled: false, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 768, height: 576 }),
    addEventListener() {}, focus() {}
  });
  return elements.get(id);
}

global.document = { getElementById: element, querySelectorAll: () => [] };
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = () => {};
global.performance = { now: () => 0 };

const test = `
start();
autoBuild();
game.bench.push({ id: game.id++, type: 'blade', kind: 'unit', level: 1 });
if (!game.placeBench(game.bench.at(-1).id, 0) || game.towers.find(t => t.slot === 0).level !== 2) throw new Error('同字合成失败');
game.bench.push({ id: game.id++, type: 'char_zhao', kind: 'letter', level: 1 });
game.placeBench(game.bench.at(-1).id, 4);
game.bench.push({ id: game.id++, type: 'char_yun', kind: 'letter', level: 1 });
game.placeBench(game.bench.at(-1).id, 5);
if (!game.towers.some(t => t.type === 'zhaoyun')) throw new Error('相邻拼名成将失败');
game.startWave();
let sawShot = false;
let sawDeath = false;
for (let i = 0; i < 8000 && game.phase !== 'win' && game.phase !== 'lose'; i++) {
  game.step();
  sawShot ||= game.shots.length > 0;
  sawDeath ||= game.impacts.some(effect => effect.kind === 'death');
  if (game.phase === 'build') game.startWave();
}
render();
updateUI();
if (game.phase !== 'win') throw new Error('推荐布防未能完整通关');
if (!sawShot || !sawDeath) throw new Error('射击或命中表现事件没有产生');
if (!byId('result').innerHTML.includes('破阵')) throw new Error('胜利结算未显示');
console.log('PASS', byId('check').textContent, '基地生命', game.base);
`;

vm.runInThisContext(fs.readFileSync('runtime.js', 'utf8'));
vm.runInThisContext(fs.readFileSync('app.js', 'utf8') + test);

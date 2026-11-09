// D1 presenter: fixed 30 tick/s accumulator loop; rendering only reads state, all rules in runtime.
import { createBattle, step, checksum, TICKS_PER_SECOND, CELL } from '../runtime/index';
import type { BattleState, Command, GameEvent } from '../runtime/index';
import { DEFAULT_PACK, PATH_CELLS } from '../content/default';

const params = new URLSearchParams(location.search);
const SEED = Number(params.get('seed') ?? 20261107) >>> 0;
const DEBUG = params.has('debug');
const TICK_MS = 1000 / TICKS_PER_SECOND;
const PX = 56; // px per cell
const pack = DEFAULT_PACK;

let state: BattleState = createBattle(pack, SEED);
let queue: Command[] = [];
let selected = pack.towers[0].id;
let speed = 1;
let paused = false;
let toast = '';
let toastUntil = 0;
const shots: { fx: number; fy: number; tx: number; ty: number; until: number }[] = [];
const recorded: { tick: number; cmds: Command[] }[] = [];

const root = document.getElementById('game-container')!;
root.innerHTML = '';
const canvas = document.createElement('canvas');
canvas.width = pack.map.width * PX;
canvas.height = pack.map.height * PX;
canvas.id = 'board';
const hud = document.createElement('div');
hud.id = 'hud';
const dbg = document.createElement('pre');
dbg.id = 'debug';
dbg.style.display = DEBUG ? 'block' : 'none';
root.append(hud, canvas, dbg);
const ctx = canvas.getContext('2d')!;

function renderHud() {
  const s = state;
  const phaseText = { build: '布防中', wave: '交战中', won: '胜利', lost: '失败' }[s.phase];
  hud.innerHTML = '';
  const info = document.createElement('span');
  info.className = 'stats';
  info.textContent = `基地 ${s.base_hp}/${pack.map.base_hp} 金币 ${s.gold} 波次 ${s.wave_index}/${pack.waves.length} ${phaseText}`;
  hud.append(info);
  for (const t of pack.towers) {
    const b = document.createElement('button');
    b.textContent = `${t.display_name} ${t.cost}`;
    b.dataset.tower = t.id;
    if (t.id === selected) b.className = 'sel';
    b.disabled = s.gold < t.cost || s.phase === 'won' || s.phase === 'lost';
    b.onclick = () => { selected = t.id; renderHud(); };
    hud.append(b);
  }
  const w = document.createElement('button');
  w.id = 'start-wave';
  w.textContent = s.phase === 'won' || s.phase === 'lost' ? '重新开始' : '出兵';
  w.disabled = s.phase === 'wave';
  w.onclick = () => {
    if (s.phase === 'won' || s.phase === 'lost') { state = createBattle(pack, SEED); recorded.length = 0; shots.length = 0; renderHud(); }
    else queue.push({ type: 'start_wave' });
  };
  hud.append(w);
  if (toast && performance.now() < toastUntil) {
    const m = document.createElement('span'); m.className = 'toast'; m.textContent = toast; hud.append(m);
  }
}

canvas.addEventListener('click', (ev) => {
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - r.left) / r.width) * pack.map.width);
  const y = Math.floor(((ev.clientY - r.top) / r.height) * pack.map.height);
  queue.push({ type: 'build', tower_id: selected, x, y });
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'F1' || e.key === '`') { e.preventDefault(); dbg.style.display = dbg.style.display === 'none' ? 'block' : 'none'; }
  if (dbg.style.display === 'none') return;
  if (e.key === 'p') paused = !paused;
  if (e.key === '1' || e.key === '2' || e.key === '4') speed = Number(e.key);
  if (e.key === 'g') queue.push({ type: 'debug_add_gold', amount: 100 });
  if (e.key === 'n') queue.push({ type: 'debug_next_wave' });
});

function onEvents(evs: GameEvent[]) {
  const now = performance.now();
  for (const e of evs) {
    if (e.type === 'build_rejected' || e.type === 'wave_rejected') { toast = e.message; toastUntil = now + 1800; }
    if (e.type === 'attack') shots.push({ fx: e.fx, fy: e.fy, tx: e.tx, ty: e.ty, until: now + 90 });
  }
}

function tickOnce() {
  const cmds = queue; queue = [];
  if (cmds.length) recorded.push({ tick: state.tick, cmds });
  const r = step(state, cmds);
  state = r.state;
  onEvents(r.events);
  if (r.events.length || cmds.length) renderHud();
}

const toPx = (m: number) => (m / CELL) * PX;
function draw() {
  const s = state;
  ctx.fillStyle = '#1b2430'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < pack.map.height; y++) for (let x = 0; x < pack.map.width; x++) {
    ctx.fillStyle = PATH_CELLS.has(`${x},${y}`) ? '#5a4a36' : (x + y) % 2 ? '#26323f' : '#2b3846';
    ctx.fillRect(x * PX, y * PX, PX, PX);
  }
  const end = pack.map.path[pack.map.path.length - 1];
  ctx.fillStyle = '#d8b45a'; ctx.fillRect(end.x * PX + 8, end.y * PX + 8, PX - 16, PX - 16);
  for (const t of s.towers) {
    const def = pack.towers.find((d) => d.id === t.def)!;
    ctx.fillStyle = def.color; ctx.globalAlpha = t.life === 'pending' ? 0.5 : 1;
    ctx.fillRect(t.cx * PX + 10, t.cy * PX + 10, PX - 20, PX - 20); ctx.globalAlpha = 1;
    ctx.fillStyle = '#111'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(def.display_name[0], t.cx * PX + PX / 2, t.cy * PX + PX / 2 + 5);
  }
  for (const e of s.enemies) {
    const def = pack.enemies.find((d) => d.id === e.def)!;
    const x = toPx(e.x), y = toPx(e.y);
    ctx.fillStyle = def.color; ctx.beginPath(); ctx.arc(x, y, PX * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000'; ctx.fillRect(x - 16, y - 22, 32, 4);
    ctx.fillStyle = '#7CFC7C'; ctx.fillRect(x - 16, y - 22, 32 * Math.max(0, e.hp) / def.hp, 4);
  }
  const now = performance.now();
  ctx.strokeStyle = '#ffe9a0'; ctx.lineWidth = 2;
  for (let i = shots.length - 1; i >= 0; i--) {
    const sh = shots[i];
    if (now > sh.until) { shots.splice(i, 1); continue; }
    ctx.beginPath(); ctx.moveTo(toPx(sh.fx), toPx(sh.fy)); ctx.lineTo(toPx(sh.tx), toPx(sh.ty)); ctx.stroke();
  }
  if (s.phase === 'won' || s.phase === 'lost') {
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(s.phase === 'won' ? '守住了！' : '基地失守', canvas.width / 2, canvas.height / 2);
  }
  if (dbg.style.display !== 'none') {
    dbg.textContent = `DEBUG  seed=${s.seed} tick=${s.tick} checksum=${checksum(s)}\n` +
      `speed=${speed}x paused=${paused} enemies=${s.enemies.length} towers=${s.towers.length} kills=${s.kills} leaks=${s.leaks}\n` +
      `keys: p 暂停 · 1/2/4 倍速 · g +100金 · n 下一波 · F1/\` 开关\n` +
      `cmds=${JSON.stringify(recorded.slice(-3))}`;
  }
}

let acc = 0; let last = performance.now();
function frame(now: number) {
  acc += Math.min(250, now - last) * (paused ? 0 : speed); last = now;
  let n = 0;
  while (acc >= TICK_MS && n < 16) { tickOnce(); acc -= TICK_MS; n++; }
  draw();
  requestAnimationFrame(frame);
}
renderHud();
requestAnimationFrame(frame);
(window as unknown as { __td: unknown }).__td = { get state() { return state; }, checksum: () => checksum(state), recorded };

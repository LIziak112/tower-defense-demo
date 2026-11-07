const fs = require('fs');
let code = fs.readFileSync('src/game/main.ts', 'utf-8');

// 注入 Palette 引用
const importPalette = "import { PALETTES, type Palette } from './palettes';\n";
code = code.replace(/import { MockProvider }/, importPalette + "import { MockProvider }");

// 添加 theme 切换
const paramTheme = "\nlet currentTheme = params.get('theme') || 'default';\nlet theme = PALETTES[currentTheme] || PALETTES.default;\n";
code = code.replace(/const provider = new MockProvider\(\);/, "const provider = new MockProvider();" + paramTheme);

// 粒子系统
const particleSys = `
interface Particle { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; color: string; }
const particles: Particle[] = [];
`;
code = code.replace(/const shots:/, particleSys + "const shots:");

// 在 onEvents 监听死亡并生成粒子
const eventAdd = `
    if (e.type === 'entity_died') {
      for (let i = 0; i < 15; i++) {
        particles.push({
          x: toPx(e.x), y: toPx(e.y),
          vx: (Math.random() - 0.5) * 100, vy: (Math.random() - 0.5) * 100,
          life: 0.5 + Math.random() * 0.5, maxLife: 1.0, color: '#f55'
        });
      }
    }
`;
code = code.replace(/if \(e\.type === 'attack'\) shots\.push\(\{ fx: e\.fx, fy: e\.fy, tx: e\.tx, ty: e\.ty, until: now \+ 90 \}\);/, 
  "if (e.type === 'attack') shots.push({ fx: e.fx, fy: e.fy, tx: e.tx, ty: e.ty, until: now + 90 });" + eventAdd);

// 在 tick 中更新粒子
const tickAdd = `
  const dt = 1 / TICKS_PER_SECOND;
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].x += particles[i].vx * dt;
    particles[i].y += particles[i].vy * dt;
    particles[i].life -= dt;
    if (particles[i].life <= 0) particles.splice(i, 1);
  }
`;
code = code.replace(/onEvents\(r\.events\);/, "onEvents(r.events);" + tickAdd);

// 替换 draw 函数
const drawRegex = /function draw\(\) \{[\s\S]*?if \(dbg\.style\.display !== 'none'\)/;
const newDraw = `function draw() {
  const s = state;
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  for (let y = 0; y < pack.map.height; y++) {
    for (let x = 0; x < pack.map.width; x++) {
      const isPath = PATH_CELLS.has(\`\${x},\${y}\`);
      ctx.fillStyle = isPath ? (((x + y) % 2) ? theme.path : theme.pathAlt) : (((x + y) % 2) ? theme.grid1 : theme.grid2);
      ctx.fillRect(x * PX, y * PX, PX, PX);
    }
  }
  
  const end = pack.map.path[pack.map.path.length - 1];
  ctx.fillStyle = theme.base;
  ctx.fillRect(end.x * PX + 8, end.y * PX + 8, PX - 16, PX - 16);
  
  for (const t of s.towers) {
    const def = pack.towers.find((d) => d.id === t.def)!;
    ctx.fillStyle = def.color || '#fff'; ctx.globalAlpha = t.life === 'pending' ? 0.5 : 1;
    // 带有阴影的基座
    ctx.beginPath();
    ctx.roundRect(t.cx * PX + 10, t.cy * PX + 10, PX - 20, PX - 20, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    // 绘制简易枪管
    ctx.fillStyle = theme.bg;
    ctx.beginPath(); ctx.arc(t.cx * PX + PX/2, t.cy * PX + PX/2, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = theme.text; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(def.display_name[0], t.cx * PX + PX / 2, t.cy * PX + PX / 2 + 3);
  }
  
  for (const e of s.enemies) {
    const def = pack.enemies.find((d) => d.id === e.def)!;
    const x = toPx(e.x), y = toPx(e.y);
    ctx.fillStyle = def.color || '#f00';
    ctx.beginPath();
    ctx.moveTo(x, y - PX * 0.25); ctx.lineTo(x + PX * 0.2, y + PX * 0.2); ctx.lineTo(x - PX * 0.2, y + PX * 0.2);
    ctx.fill();
    
    // 血条
    ctx.fillStyle = '#000'; ctx.fillRect(x - 12, y - 22, 24, 4);
    ctx.fillStyle = '#7CFC7C'; ctx.fillRect(x - 12, y - 22, 24 * Math.max(0, e.hp) / def.hp, 4);
  }
  
  // 粒子
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  const now = performance.now();
  ctx.strokeStyle = theme.shot; ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = shots.length - 1; i >= 0; i--) {
    const sh = shots[i];
    if (now > sh.until) { shots.splice(i, 1); continue; }
    ctx.globalAlpha = Math.max(0, (sh.until - now) / 90);
    ctx.beginPath(); ctx.moveTo(toPx(sh.fx), toPx(sh.fy)); ctx.lineTo(toPx(sh.tx), toPx(sh.ty)); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if (s.phase === 'won' || s.phase === 'lost') {
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = theme.text; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(s.phase === 'won' ? '守住了！' : '基地失守', canvas.width / 2, canvas.height / 2);
  }
  if (dbg.style.display !== 'none')`;

code = code.replace(drawRegex, newDraw);

// 在 renderHud 中加入主题切换按钮
const hudRegex = /hud\.append\(w\);/;
const themeBtn = `
  hud.append(w);
  const tb = document.createElement('select');
  tb.id = 'theme-select';
  for (const k of Object.keys(PALETTES)) {
    const opt = document.createElement('option'); opt.value = k; opt.textContent = '主题:'+k;
    if (k === currentTheme) opt.selected = true;
    tb.appendChild(opt);
  }
  tb.onchange = (e) => {
    currentTheme = (e.target as HTMLSelectElement).value;
    theme = PALETTES[currentTheme];
    const url = new URL(location.href); url.searchParams.set('theme', currentTheme); history.replaceState(null, '', url);
  };
  hud.append(tb);
`;
code = code.replace(hudRegex, themeBtn);

fs.writeFileSync('src/game/main.ts', code);
console.log('main.ts updated.');

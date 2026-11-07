import fs from 'fs';
let code = fs.readFileSync('src/game/main.ts', 'utf-8');

code = code.replace(/worker\.postMessage[^;]+;/g, '');

const correctTouch = `
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((t.clientX - r.left) / r.width) * pack.map.width);
  const y = Math.floor(((t.clientY - r.top) / r.height) * pack.map.height);
  queue.push({ type: 'build', tower_id: selected, x, y });
`;

code = code.replace(/canvas\.addEventListener\('touchend', \(e\) => \{[\s\S]*?\}\);/, 
  `canvas.addEventListener('touchend', (e) => {\n  const t = e.changedTouches[0];\n${correctTouch}\n});`);

fs.writeFileSync('src/game/main.ts', code);

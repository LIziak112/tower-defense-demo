import fs from 'fs';
let code = fs.readFileSync('src/game/main.ts', 'utf-8');

// 添加触摸事件支持
const touchCode = `
canvas.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  worker.postMessage({ type: 'cursor_move', x: (t.clientX - rect.left), y: (t.clientY - rect.top) });
}, {passive: false});

canvas.addEventListener('touchend', (e) => {
  const t = e.changedTouches[0];
  const rect = canvas.getBoundingClientRect();
  worker.postMessage({ type: 'cursor_click', x: (t.clientX - rect.left), y: (t.clientY - rect.top) });
});
`;
if (!code.includes('touchstart')) {
  code = code.replace(/canvas\.addEventListener\('click'[^}]+}\);/, match => match + "\n" + touchCode);
}

// 性能：目前我们在 draw 里面每个 tick 都在重新算 fillRect，这已经足够应付简单的格点了，
// 若要有缓存可以后续加上，这里先不做深度修改。

// 波间交互
// 我们需要在波次结束(wave_cleared)或刚开始游戏时显示“下一波”按钮，而不只是在右下角一个普通的 start 按钮。
// 但是其实原来 HTML 里已经有 #start-wave 按钮，并在 main.ts 里处理了。
const waveCleared = `
    if (e.type === 'wave_cleared') {
      const btn = document.getElementById('start-wave');
      if (btn) btn.style.display = 'block';
    }
`;
if (!code.includes("e.type === 'wave_cleared'")) {
    code = code.replace(/if \(e\.type === 'entity_died'\) \{/, waveCleared + "if (e.type === 'entity_died') {");
}

fs.writeFileSync('src/game/main.ts', code);
console.log('D4 logic added.');

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { cpus, release } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _electron as electron } from '@playwright/test';

const root = resolve('test-results');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'release-'));
const profileOnly = process.argv.includes('--profile-only');
const skipInput = profileOnly || process.argv.includes('--skip-input');
const clustered = process.argv.includes('--clustered');
const sampleMs = Number(process.env.TD_SAMPLE_MS ?? 15000);
assert(Number.isFinite(sampleMs) && sampleMs >= 5000 && sampleMs <= 120000);
const execute = promisify(execFile);
const probe = join(directory, 'screenProbe.exe');
if (!skipInput) await execute(join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), [
  '/nologo', '/r:System.Web.Extensions.dll', `/out:${probe}`, resolve('tests/desktop/screenProbe.cs'),
], { windowsHide: true });
const app = await electron.launch({ args: ['desktop/main.cjs', '--td-benchmark', `--user-data-dir=${directory}`] });

try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(() => {
    const gate = { tower: null };
    window.__releaseInputGate = gate;
    for (const name of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointermove', 'click', 'touchstart', 'touchend', 'wheel']) {
      window.addEventListener(name, (event) => {
        const point = gate.tower;
        if (event.key === 'F2' || (point && event.key === 'Escape')) return;
        if (point && event.target?.id === 'board' &&
            Math.abs(event.clientX - point.x) < 8 && Math.abs(event.clientY - point.y) < 8) return;
        event.stopImmediatePropagation();
        event.preventDefault();
      }, { capture: true, passive: false });
    }
  });
  await page.waitForFunction(() => window.__td?.state.enemies.length === 150);
  if (!clustered) await page.evaluate(() => {
    const state = window.__td.state;
    for (let i = 0; i < state.enemies.length; i++) {
      state.enemies[i].progress = Math.round(state.path_len * 0.8 * (i + 1) / state.enemies.length);
    }
  });
  const before = await page.evaluate(() => ({
    enemies: window.__td.state.enemies.length, towers: window.__td.state.towers.length,
    projectiles: window.__td.state.projectiles.length,
  }));
  assert.equal(before.towers, 50);
  await page.keyboard.press('F2');
  if (!profileOnly) await page.waitForFunction(() => window.__td.audioMode === 'worklet', undefined, { timeout: 10000 });
  await delay(2500);
  const environment = await app.evaluate(({ BrowserWindow, app, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const display = screen.getDisplayMatching(win.getBounds());
    return { electron: process.versions.electron, chromium: process.versions.chrome, window: win.getContentBounds(),
      display: { size: display.size, scale: display.scaleFactor, frequency: display.displayFrequency },
      gpu: app.getGPUFeatureStatus(), focused: win.isFocused() };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: 128, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true,
  });
  await delay(sampleMs);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  await cdp.detach();
  const heap = await summarizeHeap(profile);
  console.log('Top renderer allocations', JSON.stringify(heap.slice(0, 18)));
  await writeFile(join(directory, 'renderer.heapprofile'), JSON.stringify(profile));
  let performance, input, inputError;
  if (!profileOnly) {
    await page.evaluate(() => window.__td.metrics.reset());
    await delay(sampleMs);
    performance = await page.evaluate(() => window.__td.metrics.read());
    assert.equal(performance.maxAttacks, 50);
    if (!skipInput) {
      try { input = await measureInput(app, page); }
      catch (error) { inputError = String(error); }
    }
  }
  const after = await page.evaluate(() => ({
    enemies: window.__td.state.enemies.length, towers: window.__td.state.towers.length,
    audio: window.__td.audioMode, projectiles: window.__td.state.projectiles.length,
    progressSpan: Math.max(...window.__td.state.enemies.map((enemy) => enemy.progress)) -
      Math.min(...window.__td.state.enemies.map((enemy) => enemy.progress)),
  }));
  const result = {
    environment: { ...environment, os: release(), cpu: cpus()[0].model }, sampleMs, clustered, before, after,
    heap, sampledBytes: heap.reduce((sum, item) => sum + item.bytes, 0), performance, input, inputError, errors,
  };
  await writeFile(join(directory, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, ...result, heap: undefined, input: input?.summary }, null, 2));
  assert.equal(after.enemies, 150);
  assert.equal(after.towers, 50);
  assert.deepEqual(errors, []);
  if (!profileOnly) {
    assert(performance.frameWorkMs.p95 < 8, 'Frame work p95 must be <8 ms');
    assert(performance.frameMs.p95 <= 1000 / 60, 'Frame interval p95 must be <=16.67 ms');
    if (!skipInput) {
      assert.equal(inputError, undefined);
      assert(input.summary.select.p95 < 16 && input.summary.cancel.p95 < 16, 'Visible input p95 must be <16 ms');
    }
  }
} finally {
  await app.close();
}

async function measureInput(app, page) {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setAlwaysOnTop(true);
    win.show();
    win.focus();
  });
  const points = await page.evaluate(() => {
    window.__td.enableLatencyProbe();
    const { towers, pack } = window.__td.state;
    const canvas = document.getElementById('board');
    const rect = canvas.getBoundingClientRect();
    const selected = towers.reduce((best, t) => Math.hypot(t.cx - 6, t.cy - 4) < Math.hypot(best.cx - 6, best.cy - 4) ? t : best);
    const tower = { x: rect.left + rect.width * (selected.cx + 0.5) / pack.map.width,
      y: rect.top + rect.height * (selected.cy + 0.5) / pack.map.height };
    window.__releaseInputGate.tower = tower;
    return {
      marker: { x: 16, y: 16 },
      tower,
    };
  });
  const coords = await app.evaluate(({ BrowserWindow, screen }, points) => {
    const win = BrowserWindow.getAllWindows()[0];
    const bounds = win.getContentBounds();
    const handle = win.getNativeWindowHandle();
    const physical = ({ x, y }) => screen.dipToScreenPoint({ x: Math.round(bounds.x + x), y: Math.round(bounds.y + y) });
    return { handle: (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(),
      marker: physical(points.marker), tower: physical(points.tower) };
  }, points);
  await delay(200);
  const { stdout } = await execute(probe, [
    coords.handle, String(coords.marker.x), String(coords.marker.y), String(coords.tower.x), String(coords.tower.y), '40',
  ], { windowsHide: true, timeout: 25000 });
  const samples = JSON.parse(stdout);
  const distribution = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p) => sorted[Math.ceil(sorted.length * p) - 1];
    return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
  };
  return {
    samples, summary: {
      select: distribution(samples.Select.map((value) => value.VisibleMs)),
      cancel: distribution(samples.Cancel.map((value) => value.VisibleMs)),
      pollInterval: distribution([...samples.Select, ...samples.Cancel].map((value) => value.PollIntervalMs)),
    },
  };
}

async function summarizeHeap(profile) {
  const entries = [];
  const maps = new Map();
  async function visit(node, parent) {
    const frame = node.callFrame;
    if (node.selfSize) {
      let name = frame.functionName || '(anonymous)';
      if (frame.url.startsWith('td://game/assets/')) {
        const file = basename(new URL(frame.url).pathname);
        if (!maps.has(file)) {
          try { maps.set(file, new SourceMap(JSON.parse(await readFile(join('dist', 'assets', `${file}.map`), 'utf8')))); }
          catch { maps.set(file, null); }
        }
        const entry = maps.get(file)?.findEntry(frame.lineNumber, frame.columnNumber);
        if (entry?.originalSource) name = `${basename(entry.originalSource)}:${entry.originalLine + 1} ${entry.name ?? name}`;
      }
      entries.push({ name, bytes: node.selfSize, parent });
    }
    for (const child of node.children) await visit(child, frame.functionName || parent);
  }
  await visit(profile.head, '');
  return entries.sort((a, b) => b.bytes - a.bytes);
}

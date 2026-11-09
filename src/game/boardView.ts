import { CELL, buildFailure, checksum, type BattleState, type Command, type ContentPack } from '../runtime';
import { towerStats } from '../runtime/upgrade';
import { slotCell } from '../advisor/snapshot';
import type { AdvisorView } from '../advisor';
import { drawAdvisorOverlay } from './advisorOverlay';
import { drawBuildPreview, drawGroundUnits, drawTerrain, type BuildPreview } from './battlefield';
import { createSpatialProjector, type SpatialProjector, type HostSpatialMap } from './spatialMap';
import { drawSpatialBattlefield } from './spatialView';
import type { BattleFx } from './battleFx';
import type { createTacticalOverlay } from './tacticalOverlay';
import type { createTooltips } from './tooltips';
import { installBoardInput, type HoverCell } from './boardInput';
import type { SpatialDrawOptions } from './spatialDrawing';
import { createBoardCamera } from './boardCamera';
import { createBoardStatus, nearBreach } from './boardStatus';
import { follow } from './motion';
import { createBattleGuides } from './battleGuides';
import { STR } from './gameHud';
import type { Palette } from './palettes';
interface BoardOptions {
  canvas: HTMLCanvasElement; hud: HTMLElement; dbg: HTMLElement; advisorBox: HTMLElement;
  fx: BattleFx; tips: ReturnType<typeof createTooltips>; overlay: ReturnType<typeof createTacticalOverlay>;
  embedded: boolean; trial: boolean; isInsitu(): boolean; motion(): boolean; hostMap(): HostSpatialMap | null; resolution(): string;
  recorded: { tick: number; cmds: readonly Command[]; immediate?: boolean }[];
  read(): {
    state: BattleState; inspectedTower: number | null; selected: string; inLobby: boolean; hostHidden: boolean;
    speed: number; paused: boolean; confirmingUntil: number; invalidUntil: number; theme: Palette;
    lang: 'zh' | 'en'; cardView: AdvisorView; previewId: string | null;
  };
  select(x: number, y: number): void;
  chooseTower(id: string): void; cancel(): void; slow(): void;
  camera(event: { type: 'td:camera'; kind: 'pan' | 'rotate' | 'zoom'; dx?: number; dy?: number }): void;
}
export const PX = 56;
export function createBoard(opts: BoardOptions) {
  const { canvas, hud, dbg, advisorBox, fx, tips, overlay, motion, isInsitu, trial } = opts;
  const ctx = canvas.getContext('2d')!;
  const local = createBoardCamera(), status = createBoardStatus(), guides = createBattleGuides(hud);
  let currentProjector: SpatialProjector | null = null;
  let hoverCell: HoverCell | null = null;
  let previousPack: ContentPack | undefined;
  const overlayProject = (x: number, y: number) => {
    if (currentProjector) return currentProjector.milliToScreen(x, y);
    const { map } = opts.read().state.pack;
    return {
      x: (x / CELL * PX * local.scale + local.x) * canvas.width / (map.width * PX),
      y: (y / CELL * PX * local.scale + local.y) * canvas.height / (map.height * PX),
    };
  };
  function syncProjector() {
    overlay.invalidateLayout();
    const pack = opts.read().state.pack;
    if (pack !== previousPack) {
      previousPack = pack;
      local.reset(pack.map.width * PX, pack.map.height * PX);
    }
    if (isInsitu()) {
      const vw = Math.max(320, document.documentElement.clientWidth || window.innerWidth || 960);
      const vh = Math.max(240, document.documentElement.clientHeight || window.innerHeight || 640);
      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw;
        canvas.height = vh;
      }
      currentProjector = createSpatialProjector(pack, vw, vh, opts.hostMap());
    } else {
      const resolution = opts.resolution();
      const density = trial ? 2 : 1;
      const [w, h] = resolution === 'auto' ? [pack.map.width * PX * density, pack.map.height * PX * density] : resolution.split('x').map(Number);
      const ratio = pack.map.width / pack.map.height;
      const gw = Math.floor(Math.min(w, h * ratio)), gh = Math.floor(gw / ratio);
      if (canvas.width !== gw || canvas.height !== gh) {
        canvas.width = gw; canvas.height = gh;
      }
      currentProjector = null;
    }
  }
  let fitRaf = 0;
  function fit() {
    overlay.invalidateLayout();
    if (isInsitu()) {
      cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(() => {
        syncProjector();
        canvas.style.width = '100%';
        canvas.style.height = '100%';
      });
      return;
    }
    if (!opts.embedded) return;
    cancelAnimationFrame(fitRaf);
    fitRaf = requestAnimationFrame(() => {
      const availW = Math.max(200, document.documentElement.clientWidth - 20);
      const availH = Math.max(200, document.documentElement.clientHeight - hud.offsetHeight - advisorBox.offsetHeight - 38);
      const scale = Math.min(availW / canvas.width, availH / canvas.height, 2);
      canvas.style.width = `${Math.floor(canvas.width * scale)}px`;
      canvas.style.height = `${Math.floor(canvas.height * scale)}px`;
    });
  }
  window.addEventListener('resize', fit);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(document.documentElement);
  const input = installBoardInput({
    canvas, hud, tips, isInsitu, local, cellPx: PX,
    projector: () => { if (!currentProjector) syncProjector(); return currentProjector!; },
    state: () => opts.read().state, lang: () => opts.read().lang,
    hover: (cell) => {
      if (cell?.cx !== hoverCell?.cx || cell?.cy !== hoverCell?.cy) hoverCell = cell;
    },
    selected: () => opts.read().selected, chooseTower: opts.chooseTower, cancel: opts.cancel,
    select: opts.select, camera: opts.camera,
  });
  const toPx = (m: number) => (m / CELL) * PX;
  function project(x: number, y: number, out = { x: 0, y: 0 }) {
    if (currentProjector) return currentProjector.milliToScreen(x, y, out);
    out.x = toPx(x); out.y = toPx(y);
    return out;
  }
  let latencyProbe: CanvasRenderingContext2D | undefined;
  let probeSelected: boolean | undefined;
  const preview: BuildPreview = { x: 0, y: 0, range: 0, valid: false };
  const spatial: SpatialDrawOptions = {
    cardView: opts.read().cardView, previewId: null, fx, range: null, invalid: 0, now: 0, lang: 'zh', heldText: '', fellText: '',
  };
  let hoverGold = -1, hoverCount = -1, hoverSelection = '', hoverPack: ContentPack | undefined;
  let checkedCell: HoverCell | null = null, hoverValid = false;
  let towerPack: ContentPack | undefined, towerIid = -1, towerLevel = -1, towerBranch: string | undefined, towerRange = 0;
  const dataset = canvas.dataset;
  let lastDraw = 0, ghostVisible = false, lastGhostTower = '', drawnX = 0, drawnY = 0, drawnScale = 1;
  function draw(now: number, tickFraction: number) {
    const { state: s, inspectedTower, inLobby, hostHidden, selected, paused, speed, confirmingUntil, invalidUntil, cardView, previewId, theme, lang } = opts.read();
    const { pack } = s, strings = STR[lang];
    if (isInsitu() && !currentProjector) syncProjector();
    const animate = motion(), dt = lastDraw ? Math.min(0.05, (now - lastDraw) / 1000) : 0;
    lastDraw = now;
    if (!currentProjector) {
      local.advance(now, animate);
      if (drawnX !== local.x || drawnY !== local.y || drawnScale !== local.scale) {
        overlay.invalidateLayout();
        input.refreshPlacement();
      }
      drawnX = local.x; drawnY = local.y; drawnScale = local.scale;
    }
    const danger = nearBreach(s);
    if (danger && speed > 1) opts.slow();
    let inspected;
    if (inspectedTower !== null) for (let i = 0; i < s.towers.length; i++) {
      if (s.towers[i].iid === inspectedTower) { inspected = s.towers[i]; break; }
    }
    const active = !inLobby && !hostHidden && (s.phase === 'build' || s.phase === 'wave');
    const cell = hoverCell;
    const placing = active && !inspected && !!selected;
    if (placing && cell && (checkedCell !== cell || hoverGold !== s.gold || hoverCount !== s.towers.length ||
      hoverSelection !== selected || hoverPack !== pack)) {
      checkedCell = cell; hoverGold = s.gold; hoverCount = s.towers.length; hoverSelection = selected; hoverPack = pack;
      hoverValid = !buildFailure(s, selected, cell.cx, cell.cy);
    }
    const buildMode = placing ? (!cell ? 'selected' : hoverValid ? 'valid' : 'invalid') :
      active && !inspected && now < confirmingUntil ? 'confirmed' : 'idle';
    if (dataset.buildState !== buildMode) dataset.buildState = buildMode;
    overlay.update(canvas, inspected, overlayProject, !active, paused);
    fx.clock(now);
    fx.field.trackBeams(s.projectiles);
    ctx.save();
    const cellPx = currentProjector?.cellPx ?? PX;
    const aspect = currentProjector ? Math.sin(currentProjector.pitch) : 1;
    const lift = currentProjector ? Math.max(6, cellPx * 0.16) : 3;
    let range = null;
    if (placing && cell) {
      for (let i = 0; i < pack.towers.length; i++) {
        const def = pack.towers[i];
        if (def.id !== selected) continue;
        const slide = animate && ghostVisible && lastGhostTower === selected;
        preview.ghostX = slide ? follow(preview.ghostX ?? cell.cx, cell.cx, dt) : cell.cx;
        preview.ghostY = slide ? follow(preview.ghostY ?? cell.cy, cell.cy, dt) : cell.cy;
        preview.x = cell.cx; preview.y = cell.cy;
        preview.range = def.range; preview.valid = hoverValid; preview.tower = def.id;
        range = preview;
        break;
      }
    } else if (inspected) {
      if (towerPack !== pack || towerIid !== inspected.iid || towerLevel !== (inspected.level ?? 1) || towerBranch !== inspected.branch) {
        towerPack = pack; towerIid = inspected.iid; towerLevel = inspected.level ?? 1; towerBranch = inspected.branch;
        const def = pack.towers.find((item) => item.id === inspected.def)!;
        towerRange = towerStats(def, towerLevel, towerBranch).range;
      }
      preview.x = inspected.cx; preview.y = inspected.cy; preview.range = towerRange; preview.valid = true; preview.tower = undefined;
      range = preview;
    }
    ghostVisible = !!range && placing;
    lastGhostTower = selected;
    const invalid = now < invalidUntil && motion() ? Math.sin(now * 0.15) * 4 : 0;
    if (currentProjector) {
      spatial.cardView = cardView; spatial.previewId = previewId; spatial.range = range; spatial.lang = lang;
      spatial.now = motion() ? now : 0; spatial.invalid = invalid;
      spatial.heldText = strings.held; spatial.fellText = strings.fell;
      drawSpatialBattlefield(ctx, s, pack, theme, currentProjector, spatial);
    } else {
      ctx.scale(canvas.width / (pack.map.width * PX), canvas.height / (pack.map.height * PX));
      ctx.translate(local.x, local.y);
      ctx.scale(local.scale, local.scale);
      drawTerrain(ctx, pack, theme, PX, trial);
      fx.field.marks(ctx, project); fx.field.grid(ctx, pack, PX);
      if (range) drawBuildPreview(ctx, project, range, PX, 1, invalid);
      drawGroundUnits(ctx, s, toPx, fx, now / 1000, animate, !paused && s.phase === 'wave', trial, tickFraction);
      if (active && !trial) drawAdvisorOverlay(ctx, cardView, s, PX, theme.accent ?? '#ffd36a', previewId);
    }
    guides(ctx, pack, project, cellPx, aspect, animate ? now : 0, overlay.routePreview, inspected ? range : null);
    fx.draw(ctx, s, project, cellPx, theme.shot, tickFraction, aspect, lift); fx.field.casings(ctx, project);
    ctx.restore();
    status(ctx, now, paused, danger, animate);
    ctx.save();
    if (!trial && !currentProjector && (s.phase === 'won' || s.phase === 'lost')) {
      const { width: w, height: h } = canvas;
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = theme.paper ?? theme.text; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(s.phase === 'won' ? strings.held : strings.fell, w / 2, h / 2);
    }
    ctx.restore();
    if (latencyProbe && probeSelected !== !!inspected) {
      probeSelected = !!inspected;
      latencyProbe.fillStyle = probeSelected ? '#19e68a' : '#c317e5';
      latencyProbe.fillRect(0, 0, 16, 16);
    }
    if (dbg.style.display !== 'none') {
      dbg.textContent = `DEBUG  seed=${s.seed} tick=${s.tick} checksum=${checksum(s)}\n` +
        `speed=${opts.read().speed}x paused=${paused} hidden=${hostHidden} enemies=${s.enemies.length} towers=${s.towers.length} kills=${s.kills} leaks=${s.leaks}\n` +
        `keys: Space pause · 1/2/3 speed · g +100 · F1 debug\n` +
        `cmds=${JSON.stringify(opts.recorded.slice(-3))}`;
    }
  }
  return {
    draw, sync: syncProjector, fit, cancelPlacement: input.cancelGesture,
    enableLatencyProbe() {
      if (latencyProbe) return;
      const patch = document.createElement('canvas');
      patch.width = patch.height = 16;
      patch.style.cssText = 'position:fixed;top:8px;left:8px;z-index:1000;pointer-events:none';
      document.body.append(patch);
      latencyProbe = patch.getContext('2d')!;
    },
    clear() {
      const { map } = opts.read().state.pack;
      local.reset(map.width * PX, map.height * PX);
      ghostVisible = false; input.cancelGesture(); syncProjector();
    },
    hide() { overlay.update(canvas, undefined, project, true, false); },
    inspect() {
      if (!isInsitu()) return null;
      if (!currentProjector) syncProjector();
      const p = currentProjector!, pack = opts.read().state.pack;
      return {
        insitu: true, canvasBg: 'transparent', stage: { w: canvas.width, h: canvas.height },
        azimuth: p.azimuth, pitch: p.pitch, zoom: p.zoom, origin: p.origin, cellPx: p.cellPx, hostMap: p.hostMap,
        waypoints: pack.map.path.map((c) => p.cellToScreen(c.x + 0.5, c.y + 0.5)),
        tacticalSlots: p.tacticalSlots.slice(0, 16),
        slotScreen: (slot: number) => { const c = slotCell(pack, slot); return c ? p.cellToScreen(c.x + 0.5, c.y + 0.5) : null; },
        cellScreen: (x: number, y: number) => p.cellToScreen(x + 0.5, y + 0.5),
      };
    },
  };
}

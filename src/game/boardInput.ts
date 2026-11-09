import { buildFailure, type BattleState } from '../runtime';
import type { SpatialProjector } from './spatialMap';
import type { createBoardCamera } from './boardCamera';
import { towerDetails, type createTooltips } from './tooltips';

export type HoverCell = { cx: number; cy: number };

export function snapBuildCell(state: BattleState, selected: string, x: number, y: number): HoverCell {
  const cx = Math.floor(x), cy = Math.floor(y);
  const raw = { cx, cy };
  if (!selected || x < 0 || y < 0 || x >= state.pack.map.width || y >= state.pack.map.height) return raw;
  const failure = buildFailure(state, selected, cx, cy);
  if (failure !== 'NOT_BUILDABLE') return raw;
  let limit = (1.35 / 2) ** 2, best = raw;
  for (const cell of state.pack.map.buildable_cells) {
    const distance = (cell.x + 0.5 - x) ** 2 + (cell.y + 0.5 - y) ** 2;
    if (distance > limit || (best !== raw && distance === limit) || buildFailure(state, selected, cell.x, cell.y)) continue;
    limit = distance;
    best = { cx: cell.x, cy: cell.y };
  }
  return best;
}

export function installBoardInput(opts: {
  canvas: HTMLCanvasElement; hud: HTMLElement; tips: ReturnType<typeof createTooltips>;
  isInsitu(): boolean; projector(): SpatialProjector; local: ReturnType<typeof createBoardCamera>; cellPx: number;
  state(): BattleState; lang(): 'zh' | 'en'; selected(): string; chooseTower(id: string): void;
  cancel(): void; hover(cell: HoverCell | null): void; select(x: number, y: number): void;
  camera(event: { type: 'td:camera'; kind: 'pan' | 'rotate' | 'zoom'; dx?: number; dy?: number }): void;
}) {
  const { canvas, hud, tips, isInsitu, local, cellPx } = opts;
  let card: { id: number; tower: string; x: number; y: number; moved: boolean } | null = null;
  let drag: { id: number; x: number; y: number; at: number; moved: boolean; middle: boolean } | null = null;
  let pointer: { x: number; y: number } | null = null;
  let suppressClick = false;

  function resolve(clientX: number, clientY: number) {
    const state = opts.state(), { map } = state.pack;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height || clientX < r.left || clientX >= r.right || clientY < r.top || clientY >= r.bottom) return null;
    const u = (clientX - r.left) / r.width, v = (clientY - r.top) / r.height;
    if (isInsitu()) {
      const hit = opts.projector().screenToCell(u * canvas.width, v * canvas.height);
      if (opts.selected()) return snapBuildCell(state, opts.selected(), hit.gx, hit.gy);
      return { cx: hit.cx, cy: hit.cy };
    }
    return snapBuildCell(state, opts.selected(),
      (u * map.width * cellPx - local.x) / (local.scale * cellPx),
      (v * map.height * cellPx - local.y) / (local.scale * cellPx));
  }

  function updateCell(x: number, y: number) {
    const cell = resolve(x, y);
    const { pack } = opts.state();
    opts.hover(cell && cell.cx >= 0 && cell.cx < pack.map.width && cell.cy >= 0 && cell.cy < pack.map.height ? cell : null);
    return cell;
  }

  function hover(x: number, y: number) {
    pointer = { x, y };
    const cell = updateCell(x, y);
    const { towers, pack } = opts.state();
    const tower = !opts.selected() && cell && towers.find((item) => item.cx === cell.cx && item.cy === cell.cy);
    const def = tower && pack.towers.find((item) => item.id === tower.def);
    if (tower && def && !card) tips.show(`tower-${tower.iid}`, towerDetails(def, tower.level, tower.branch, opts.lang() === 'zh'), x, y);
    else tips.hide();
  }

  function cancelGesture() {
    suppressClick = suppressClick || !!card || !!drag;
    if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
    card = drag = null;
    pointer = null;
    local.release(0, false);
    opts.hover(null);
    tips.hide();
  }

  window.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.button !== 1) return;
    suppressClick = false;
    const button = ev.target instanceof Element ? ev.target.closest<HTMLButtonElement>('button[data-tower]') : null;
    if (ev.button === 0 && ev.pointerType === 'mouse' && button && hud.contains(button) && !button.disabled && button.dataset.tower) {
      card = { id: ev.pointerId, tower: button.dataset.tower, x: ev.clientX, y: ev.clientY, moved: false };
    }
    if (ev.target !== canvas || !(ev.button === 1 || (isInsitu() && ev.button === 0 && ev.pointerType === 'mouse'))) return;
    if (ev.button === 1) {
      ev.preventDefault();
      canvas.setPointerCapture(ev.pointerId);
      local.release(0, false);
      opts.hover(null);
      tips.hide();
    }
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, at: ev.timeStamp, moved: false, middle: ev.button === 1 };
  }, true);

  window.addEventListener('pointermove', (ev) => {
    if (card?.id === ev.pointerId) {
      if (!card.moved && Math.hypot(ev.clientX - card.x, ev.clientY - card.y) >= 6) {
        card.moved = true;
        opts.chooseTower(card.tower);
      }
      if (card.moved) hover(ev.clientX, ev.clientY);
      return;
    }
    if (drag?.id === ev.pointerId) {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (drag.middle || drag.moved || Math.hypot(dx, dy) > 8) {
        drag.moved = true;
        if (isInsitu()) opts.camera({ type: 'td:camera', kind: drag.middle || ev.shiftKey ? 'pan' : 'rotate', dx, dy });
        else {
          const rect = canvas.getBoundingClientRect(), { map } = opts.state().pack;
          local.pan(dx * map.width * cellPx / rect.width, dy * map.height * cellPx / rect.height, ev.timeStamp - drag.at);
        }
        drag.x = ev.clientX; drag.y = ev.clientY; drag.at = ev.timeStamp;
        return;
      }
    }
    if (ev.target === canvas) hover(ev.clientX, ev.clientY);
  });

  window.addEventListener('pointerup', (ev) => {
    if (card?.id === ev.pointerId && ev.button === 0) {
      const moved = card.moved;
      card = null;
      if (!moved) return;
      suppressClick = true;
      const cell = resolve(ev.clientX, ev.clientY);
      if (cell && !buildFailure(opts.state(), opts.selected(), cell.cx, cell.cy)) opts.select(cell.cx, cell.cy);
      hover(ev.clientX, ev.clientY);
    }
    if (drag?.id !== ev.pointerId || ev.button !== (drag.middle ? 1 : 0)) return;
    if (drag.middle && !isInsitu()) local.release(ev.timeStamp, drag.moved && ev.timeStamp - drag.at < 75);
    suppressClick = drag.moved;
    drag = null;
  });
  function interruptGesture() {
    if (card?.moved) opts.cancel();
    else cancelGesture();
  }
  window.addEventListener('pointercancel', (ev) => { if (ev.pointerId === card?.id || ev.pointerId === drag?.id) interruptGesture(); });
  window.addEventListener('blur', interruptGesture);
  window.addEventListener('contextmenu', (ev) => {
    if (!card && ev.target !== canvas && !(ev.target instanceof Node && hud.contains(ev.target))) return;
    ev.preventDefault();
    cancelGesture();
    opts.cancel();
  });
  window.addEventListener('click', (ev) => {
    if (!suppressClick || !ev.detail) return;
    suppressClick = false;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
  canvas.addEventListener('pointerleave', () => { if (!card?.moved) { pointer = null; opts.hover(null); tips.hide(); } });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (isInsitu()) { opts.camera({ type: 'td:camera', kind: 'zoom', dy: ev.deltaY }); return; }
    const r = canvas.getBoundingClientRect(), { map } = opts.state().pack;
    const scale = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? r.height : 1;
    local.wheel((ev.clientX - r.left) * map.width * cellPx / r.width,
      (ev.clientY - r.top) * map.height * cellPx / r.height, ev.deltaY * scale);
    hover(ev.clientX, ev.clientY);
  }, { passive: false });
  canvas.addEventListener('click', (ev) => {
    const cell = resolve(ev.clientX, ev.clientY);
    if (cell) opts.select(cell.cx, cell.cy);
  });
  canvas.addEventListener('touchend', (ev) => {
    const point = ev.changedTouches[0];
    if (!point) return;
    ev.preventDefault();
    const cell = resolve(point.clientX, point.clientY);
    if (cell) opts.select(cell.cx, cell.cy);
  }, { passive: false });
  return {
    cancelGesture,
    refreshPlacement() { if (pointer && opts.selected()) updateCell(pointer.x, pointer.y); },
  };
}

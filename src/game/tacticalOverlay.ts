import { CELL, GAMBITS, TARGET_MODES, TICKS_PER_SECOND, earlyWaveReward, type BattleState, type TargetMode, type TowerInst } from '../runtime';
import type { createTooltips } from './tooltips';

export const targetingLabels = {
  first_on_path: ['最前', 'First'], last_on_path: ['最后', 'Last'],
  highest_hp: ['最高血量', 'Highest HP'], nearest: ['最近', 'Nearest'],
} as const;

export function waveDescription(state: BattleState, zh: boolean) {
  const wave = state.pack.waves[state.wave_index];
  if (!wave) return '';
  const counts = new Map<string, number>();
  const gambit = state.gambit?.wave === state.wave_index ? GAMBITS[state.gambit.id] : null;
  for (const group of wave.groups) {
    const count = Math.ceil(group.count * (gambit?.count_mul ?? 1));
    counts.set(group.enemy_id, (counts.get(group.enemy_id) ?? 0) + count);
  }
  const lines = [...counts].map(([id, count]) => {
    const enemy = state.pack.enemies.find((item) => item.id === id)!;
    const armor = enemy.armor_type ?? (zh ? '无甲' : 'Unarmored');
    const immunity = enemy.immunities?.includes('ARMOR_SHRED') ? (zh ? '破甲免疫' : 'Armor shred immune') : (zh ? '无免疫' : 'No immunities');
    return `${enemy.display_name} ×${count} · ${armor} · ${immunity}`;
  });
  const reward = earlyWaveReward(state);
  if (reward.gold || reward.cooldown_ticks) lines.push(zh ?
    `提前开波 +${reward.gold} 金 · 缩短 ${(reward.cooldown_ticks / TICKS_PER_SECOND).toFixed(1)} 秒建造冷却` :
    `Start early: +${reward.gold} gold · ${(reward.cooldown_ticks / TICKS_PER_SECOND).toFixed(1)}s construction cooldown credit`);
  return lines.join('\n');
}

export function createTacticalOverlay(
  tips: ReturnType<typeof createTooltips>,
  read: () => BattleState, zh: () => boolean,
  start: () => void, aim: (iid: number, mode: TargetMode) => void,
) {
  const marker = document.createElement('button');
  marker.id = 'td-wave-marker'; marker.className = 'td-wave-marker td-panel';
  marker.hidden = true; marker.onclick = start;
  const icon = document.createElement('span'); icon.textContent = '☠'; icon.setAttribute('aria-hidden', 'true');
  const time = document.createElement('small');
  marker.append(icon, time);
  tips.bind(marker, () => waveDescription(read(), zh()));
  let hovering = false, focused = false;
  marker.addEventListener('pointerenter', () => { hovering = true; });
  marker.addEventListener('pointerleave', () => { hovering = false; });
  marker.addEventListener('focus', () => { focused = true; });
  marker.addEventListener('blur', () => { focused = false; });
  const ring = document.createElement('div');
  ring.className = 'td-target-ring td-panel'; ring.hidden = true; ring.setAttribute('role', 'group');
  const buttons = TARGET_MODES.map((mode) => {
    const button = document.createElement('button');
    button.dataset.targeting = mode;
    button.onclick = () => { if (towerId !== null) aim(towerId, mode); };
    ring.append(button);
    return button;
  });
  document.body.append(marker, ring);
  let towerId: number | null = null, lastSecond = -1, lastLang: boolean | undefined, lastMode: string | undefined;
  let dirtyLayout = true, lastRemaining = -1, lastPaused: boolean | undefined;
  const invalidateLayout = () => { dirtyLayout = true; };
  window.addEventListener('scroll', invalidateLayout, { capture: true, passive: true });
  function anchor(el: HTMLElement, x: number, y: number, edge: number) {
    el.style.left = `${Math.max(edge, Math.min(innerWidth - edge, x))}px`;
    el.style.top = `${Math.max(edge, Math.min(innerHeight - edge, y))}px`;
  }
  return {
    get routePreview() { return !marker.hidden && (hovering || focused); },
    invalidateLayout,
    update(canvas: HTMLCanvasElement, tower: TowerInst | undefined, project: (x: number, y: number) => { x: number; y: number }, hidden: boolean, paused: boolean) {
      const state = read();
      const hideMarker = hidden || state.phase !== 'build' || !state.pack.waves[state.wave_index];
      const hideRing = hidden || !tower || state.phase === 'won' || state.phase === 'lost';
      if (marker.hidden !== hideMarker) { marker.hidden = hideMarker; dirtyLayout = true; }
      if (ring.hidden !== hideRing) { ring.hidden = hideRing; dirtyLayout = true; }
      if (marker.hidden && ring.hidden) return;
      const rect = dirtyLayout || (!hideRing && towerId !== tower?.iid) ? canvas.getBoundingClientRect() : null;
      if (!marker.hidden) {
        if (rect) {
          const cell = state.pack.map.path[0];
          const pos = project((cell.x + 0.5) * CELL, (cell.y + 0.5) * CELL);
          anchor(marker, rect.left + pos.x * rect.width / canvas.width, rect.top + pos.y * rect.height / canvas.height, 21);
        }
        const remaining = Math.max(0, state.prep_until - state.tick);
        const seconds = Math.ceil(remaining / TICKS_PER_SECOND);
        if (seconds !== lastSecond || lastLang !== zh()) {
          time.textContent = state.pack.wave_rules ? `${seconds}s` : '';
          marker.setAttribute('aria-label', zh() ? `开始下一波，剩余 ${seconds} 秒` : `Start next wave, ${seconds} seconds left`);
          tips.refresh(marker, () => waveDescription(state, zh()));
          lastSecond = seconds;
        }
        if (paused !== lastPaused) { marker.setAttribute('aria-disabled', String(paused)); lastPaused = paused; }
        if (rect || lastRemaining !== remaining) {
          marker.style.setProperty('--wave-progress', `${state.pack.wave_rules ? 100 * remaining / state.pack.wave_rules.prep_ticks : 100}%`);
          lastRemaining = remaining;
        }
      }
      if (!ring.hidden && tower) {
        if (rect) {
          const pos = project(tower.x, tower.y);
          anchor(ring, rect.left + pos.x * rect.width / canvas.width, rect.top + pos.y * rect.height / canvas.height, 58);
        }
        let mode = tower.targeting;
        if (!mode) for (let i = 0; i < state.pack.towers.length; i++) {
          const def = state.pack.towers[i];
          if (def.id === tower.def) { mode = def.targeting; break; }
        }
        mode ??= 'first_on_path';
        if (towerId !== tower.iid || lastMode !== mode || lastLang !== zh()) {
          towerId = tower.iid;
          lastMode = mode;
          ring.setAttribute('aria-label', zh() ? '索敌策略' : 'Targeting priority');
          TARGET_MODES.forEach((value, i) => {
            buttons[i].textContent = targetingLabels[value][zh() ? 0 : 1];
            buttons[i].setAttribute('aria-pressed', String(mode === value));
          });
        }
      }
      lastLang = zh();
      dirtyLayout = false;
    },
  };
}

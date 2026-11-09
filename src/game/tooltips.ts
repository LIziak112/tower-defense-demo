import { TICKS_PER_SECOND, type TowerDef } from '../runtime';
import { towerStats } from '../runtime/upgrade';

export function towerDetails(def: TowerDef, level: number | undefined, branch: string | undefined, zh: boolean) {
  const stats = towerStats(def, level, branch);
  const shot = stats.projectile;
  const hits = shot?.type === 'BEAM' ? Math.ceil(shot.ticks / shot.interval_ticks) : 1;
  const crit = 1 + (stats.crit_percent ?? 0) / 100 * ((stats.crit_multiplier ?? 1) - 1);
  const dps = (stats.damage * hits * crit * TICKS_PER_SECOND / stats.interval_ticks).toFixed(1);
  const counters = Object.entries(def.damage_vs_armor ?? {}).filter(([, multiplier]) => multiplier > 1)
    .map(([armor]) => armor).join(' · ') || (zh ? '通用' : 'General');
  return `${def.display_name} · ${dps} DPS\n${zh ? '克制' : 'Counters'} · ${counters}`;
}

export function createTooltips() {
  const popup = document.createElement('div');
  popup.className = 'td-tooltip td-panel';
  popup.id = 'td-tooltip'; popup.setAttribute('role', 'tooltip'); popup.hidden = true;
  document.body.append(popup);
  let target: string | HTMLElement | null = null;
  let pendingText = '';
  let timer = 0, x = 0, y = 0;
  function position() {
    const rect = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(x + 12, innerWidth - rect.width - 8))}px`;
    popup.style.top = `${Math.max(8, y + 16 + rect.height < innerHeight ? y + 16 : y - rect.height - 10)}px`;
  }
  function hide() {
    if (target instanceof HTMLElement) target.removeAttribute('aria-describedby');
    target = null; clearTimeout(timer); popup.hidden = true;
  }
  function show(id: string | HTMLElement, text: string, clientX: number, clientY: number) {
    x = clientX; y = clientY;
    pendingText = text;
    if (target === id) {
      if (!popup.hidden && popup.textContent !== text) { popup.textContent = text; position(); }
      return;
    }
    hide(); target = id;
    timer = window.setTimeout(() => {
      if (id instanceof HTMLElement && !id.isConnected) { hide(); return; }
      popup.textContent = pendingText; popup.hidden = false; position();
      if (id instanceof HTMLElement) id.setAttribute('aria-describedby', popup.id);
    }, 120);
  }
  function bind(element: HTMLElement, describe: () => string) {
    const point = () => { const rect = element.getBoundingClientRect(); show(element, describe(), rect.left, rect.bottom); };
    element.addEventListener('pointerenter', point);
    element.addEventListener('focus', point);
    const leave = () => { if (target === element) hide(); };
    element.addEventListener('pointerleave', leave);
    element.addEventListener('blur', leave);
  }
  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide(); });
  return {
    show, hide, bind,
    refresh(element: HTMLElement, describe: () => string) {
      if (target === element && !popup.hidden) show(element, describe(), x, y);
    },
  };
}

import { ACTIONS, type Settings } from './profile';

export function installShortcuts(opts: {
  dbg: HTMLElement; keys: Settings['keys']; debugEnabled: boolean; settingsOpen(): boolean;
  cancel(): void; togglePause(): void; startWave(): void; speed(value: number): void; debugGold(): void;
}) {
  const { dbg } = opts;
  window.addEventListener('keydown', (e) => {
    if (opts.settingsOpen() || e.repeat || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey ||
        (e.target instanceof HTMLElement && (e.target.matches('input, textarea, select') || e.target.isContentEditable))) return;
    if (e.key === 'Escape') { opts.cancel(); return; }
    if (e.key === 'F1' || e.key === '`') {
      e.preventDefault(); dbg.style.display = dbg.style.display === 'none' ? 'block' : 'none'; return;
    }
    const action = ACTIONS.find((key) => opts.keys[key] === e.code);
    if (action) {
      e.preventDefault();
      if (action === 'pause') opts.togglePause();
      else if (action === 'wave') opts.startWave();
      else { opts.speed(Number(action.slice(-1))); }
      return;
    }
    if (!opts.debugEnabled || dbg.style.display === 'none') return;
    if (e.key === 'p') opts.togglePause();
    if (e.key === 'g') opts.debugGold();
  });

}

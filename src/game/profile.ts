import { z } from 'zod';
import type { BattleBus } from './eventBus';
import type { BattleState } from '../runtime';

export const RESOLUTIONS = ['auto', '1280x720', '1600x900', '1920x1080'] as const;
export const ACTIONS = ['pause', 'speed1', 'speed2', 'speed3', 'wave'] as const;
export type Action = typeof ACTIONS[number];
const defaults = { pause: 'Space', speed1: 'Digit1', speed2: 'Digit2', speed3: 'Digit3', wave: 'KeyN' };
const volume = z.number().min(0).max(1);
const profileSchema = z.object({
  version: z.literal(1),
  settings: z.object({
    resolution: z.enum(RESOLUTIONS),
    windowMode: z.enum(['windowed', 'borderless']).default('windowed'),
    music: volume, effects: volume, interface: volume.default(0.65),
    keys: z.object({ pause: z.string(), speed1: z.string(), speed2: z.string(), speed3: z.string(), wave: z.string() }),
  }),
  progress: z.object({
    kills: z.number().int().nonnegative(),
    stars: z.record(z.string(), z.number().int().min(1).max(3)),
    codex: z.array(z.string()),
  }),
});
export type Profile = z.infer<typeof profileSchema>;
export type Settings = Profile['settings'];
declare global {
  interface Window {
    tdDesktop?: {
      readProfile(): string | null;
      writeProfile(content: string): boolean;
      display(mode: Settings['windowMode'], resolution: Settings['resolution']): Promise<boolean>;
    };
  }
}

// A desktop host can map this relative path to its Steam Auto-Cloud save directory.
export const PROFILE_FILE = 'saves/tower-defense-profile-v1.json';
export interface ProfileStorage { read(file: string): string | null; write(file: string, content: string): void }
const browserStorage: ProfileStorage = {
  read: (file) => localStorage.getItem(file),
  write: (file, content) => localStorage.setItem(file, content),
};

export function createProfile(storage: ProfileStorage = window.tdDesktop ? {
  read: () => window.tdDesktop!.readProfile(),
  write: (_file, content) => {
    if (!window.tdDesktop!.writeProfile(content)) throw new Error('Desktop profile write failed');
  },
} : browserStorage) {
  let data: Profile = {
    version: 1,
    settings: { resolution: 'auto', windowMode: 'windowed', music: 0.25, effects: 0.8, interface: 0.65, keys: { ...defaults } },
    progress: { kills: 0, stars: {}, codex: [] },
  };
  try {
    const result = profileSchema.safeParse(JSON.parse(storage.read(PROFILE_FILE) ?? 'null'));
    if (result.success) data = result.data;
  } catch { /* storage can be disabled by the host */ }
  let dirty = false;
  const save = () => {
    if (!dirty) return;
    try { storage.write(PROFILE_FILE, JSON.stringify(data)); dirty = false; } catch { /* keep the session profile */ }
  };
  return { data, change() { dirty = true; }, save };
}

export function trackProgress(bus: BattleBus, profile: ReturnType<typeof createProfile>, read: () => BattleState, enabled: () => boolean) {
  bus.on('enemy_spawned', (event) => {
    if (!enabled() || profile.data.progress.codex.includes(event.enemy_id)) return;
    profile.data.progress.codex.push(event.enemy_id);
    profile.change();
  });
  bus.on('entity_died', () => {
    if (!enabled()) return;
    profile.data.progress.kills++;
    profile.change();
  });
  bus.on('battle_ended', (event) => {
    if (!enabled() || event.result !== 'won') return;
    const { pack, base_hp } = read();
    const ratio = base_hp / pack.map.base_hp;
    const stars = ratio === 1 ? 3 : ratio >= 0.5 ? 2 : 1;
    const id = JSON.stringify([pack.meta.theme, pack.map.path, pack.waves]);
    profile.data.progress.stars[id] = Math.max(profile.data.progress.stars[id] ?? 0, stars);
    profile.change();
    profile.save();
  });
  window.addEventListener('pagehide', profile.save);
  const flush = window.setInterval(profile.save, 1000);
  if (import.meta.hot) import.meta.hot.dispose(() => { clearInterval(flush); profile.save(); });
}

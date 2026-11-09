import scenario from './packs/changban_rain_night.json?raw';
import { validatePack } from './validate';
import { compilePack } from './compile';
import type { ContentPack } from '../runtime/types';

function parseScenario(value: string | undefined) {
  let data: unknown;
  try { if (value !== undefined) data = JSON.parse(value); } catch { /* schema reports the invalid root */ }
  return validatePack(data);
}
const initial = parseScenario(scenario);
if (!initial.ok) throw new Error(`Invalid opening campaign: ${initial.errors.map((error) => error.path).join(', ')}`);
let raw = initial.pack;
let pack = compilePack(raw);
const listeners: ((pack: ContentPack) => void)[] = [];

export const openingRaw = () => raw;
export const openingCampaign = () => pack;
export function onOpeningReload(listener: (pack: ContentPack) => void) {
  if (import.meta.hot) listeners.push(listener);
}

if (import.meta.hot) import.meta.hot.accept('./packs/changban_rain_night.json?raw', (updated) => {
  const result = parseScenario(updated?.default);
  if (!result.ok) {
    console.warn('Opening campaign reload rejected', result.errors);
    return;
  }
  raw = result.pack;
  pack = compilePack(raw);
  for (const listener of listeners) listener(pack);
});

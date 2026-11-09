import type { GameEvent } from '../runtime';

export const Sound = {
  arrow: 0, cannon: 1, flame: 2, arcane: 3, beam: 4, impact: 5, armor: 6, coin: 7,
  error: 8, build: 9, wave: 10,
} as const;
export type SoundId = typeof Sound[keyof typeof Sound];
export const effectSoundCount = Sound.error;
const duration = [0.040, 0.32, 0.13, 0.16, 0.22, 0.10, 0.14, 0.15, 0.15, 0.22, 0.28];
const tau = 2 * Math.PI;
const tone = (cycles: number) => Math.sin(tau * cycles);
const saw = (cycles: number) => 2 * (cycles - Math.floor(cycles)) - 1;
const sweep = (start: number, end: number, time: number, progress: number) =>
  tone(time * (start + (end - start) * progress / 2));

export function shotSound(event: Extract<GameEvent, { type: 'attack' }>): SoundId {
  switch (event.projectile) {
    case 'ARC': return event.arcHeight >= 600 ? Sound.cannon : Sound.arrow;
    case 'HOMING': return Sound.arcane;
    case 'BEAM': return Sound.beam;
    default: return Sound.flame;
  }
}

export function impactSound(event: Extract<GameEvent, { type: 'damage_applied' }>): SoundId {
  return event.armorBlocked > 0 ? Sound.armor : Sound.impact;
}

export function synthesizeSound(id: SoundId, sampleRate: number, random = Math.random) {
  const length = duration[id];
  const data = new Float32Array(Math.ceil(length * sampleRate));
  const noise = () => random() * 2 - 1;
  const angle = tau * 1500 / sampleRate;
  const alpha = Math.sin(angle) / 1.7;
  const a1 = -2 * Math.cos(angle) / (1 + alpha);
  const a2 = (1 - alpha) / (1 + alpha);
  const b0 = alpha / (1 + alpha);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const pink = new Float64Array(6);
  let pinkSum = 0;
  const pinkStride = Math.max(1, Math.round(sampleRate / 12000));
  const rise = id === Sound.arrow || id === Sound.impact || id === Sound.armor ? 0.002 : 0.005;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const u = i / (data.length - 1);
    const envelope = Math.min(1, t / rise) * (1 - u) ** 2;
    let signal: number;
    switch (id) {
      case Sound.arrow: {
        const x = noise();
        const y = b0 * (x - x2) - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        signal = 0.38 * y;
        break;
      }
      case Sound.cannon:
        for (let octave = 0; octave < pink.length; octave++) {
          if (i % (pinkStride << octave)) continue;
          pinkSum -= pink[octave];
          pink[octave] = noise();
          pinkSum += pink[octave];
        }
        signal = 0.25 * sweep(180, 40, t, u) + 0.045 * pinkSum;
        break;
      case Sound.flame:
        x1 += (noise() - x1) * 0.18;
        signal = 0.32 * x1 + 0.045 * sweep(165, 105, t, u);
        break;
      case Sound.arcane:
        signal = 0.14 * sweep(340, 1040, t, u) + 0.075 * sweep(725, 1730, t, u);
        break;
      case Sound.beam: {
        const phase = t * (192 + u * 110);
        const dual = saw(phase) + saw(phase * 1.037);
        x1 += (dual - x1) * 0.17;
        signal = 0.135 * x1;
        break;
      }
      case Sound.impact:
        signal = 0.23 * tone(t * 110);
        break;
      case Sound.armor:
        signal = 0.18 * tone(t * 110) + Math.exp(-t * 25) * (0.17 * tone(t * 2600) + 0.07 * tone(t * 3173));
        break;
      case Sound.coin:
        signal = 0.13 * sweep(780, 1350, t, u) + 0.055 * tone(t * 1480);
        break;
      case Sound.error:
        signal = 0.14 * sweep(195, 94, t, u) + 0.05 * tone(t * 153);
        break;
      case Sound.build:
        signal = 0.16 * tone(t * 440) + 0.12 * tone(t * 660);
        break;
      case Sound.wave:
        signal = 0.12 * tone(t * 165) + 0.09 * tone(t * 247);
        break;
    }
    data[i] = signal * envelope;
  }
  return data;
}

export const soundCount = duration.length;

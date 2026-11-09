import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { effectSoundCount, Sound, synthesizeSound } from '../../src/game/audioSynth';

function frequencyAmplitude(sample: Float32Array, frequency: number, rate: number) {
  let real = 0, imaginary = 0;
  for (let i = 0; i < sample.length; i++) {
    const angle = i * frequency * 2 * Math.PI / rate;
    real += sample[i] * Math.cos(angle);
    imaginary += sample[i] * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / sample.length;
}

it('synthesizes a build chord, body thud and separate metal transient', () => {
  const rate = 48000;
  const build = synthesizeSound(Sound.build, rate);
  const body = synthesizeSound(Sound.impact, rate);
  const armor = synthesizeSound(Sound.armor, rate);
  expect(frequencyAmplitude(build, 440, rate)).toBeGreaterThan(0.04);
  expect(frequencyAmplitude(build, 660, rate)).toBeGreaterThan(0.03);
  expect(frequencyAmplitude(body, 110, rate)).toBeGreaterThan(0.06);
  expect(frequencyAmplitude(body, 2600, rate)).toBeLessThan(0.001);
  expect(frequencyAmplitude(armor, 2600, rate)).toBeGreaterThan(0.015);
  expect(synthesizeSound(Sound.arrow, rate)).toHaveLength(rate * 0.04);
});

it('mixes scheduled voices at their offset and drops a fourth identical voice in 50 ms', () => {
  interface Mixer {
    port: { onmessage: (message: { data: number }) => void };
    process(inputs: unknown[], outputs: Float32Array[][]): boolean;
  }
  let Processor!: new (options: { processorOptions: { samples: Float32Array[]; effectSoundCount: number } }) => Mixer;
  const worklet = {
    sampleRate: 1000,
    currentFrame: 0,
    AudioWorkletProcessor: class { port = {}; },
    registerProcessor(_name: string, constructor: typeof Processor) { Processor = constructor; },
  };
  runInNewContext(readFileSync(new URL('../../public/audio-mixer.js', import.meta.url), 'utf8'), worklet);
  const samples = Array.from({ length: Sound.wave + 1 }, () => new Float32Array(64).fill(1));
  const mixer = new Processor({ processorOptions: { samples, effectSoundCount } });
  const send = (sound: number, delay: number) => mixer.port.onmessage({ data: sound | ((delay - 5) << 4) | (255 << 15) });
  for (const start of [11, 5, 9, 12]) send(Sound.arrow, start);
  send(Sound.build, 8);
  const effects = new Float32Array(16), ui = new Float32Array(16);
  mixer.process([], [[effects], [ui]]);
  expect(Array.from(effects.slice(0, 5))).toEqual([0, 0, 0, 0, 0]);
  expect(effects[5]).toBeCloseTo(1.08);
  expect(effects[12]).toBeCloseTo(3.24);
  expect(ui[7]).toBe(0);
  expect(ui[8]).toBeCloseTo(1.08);
  worklet.currentFrame = 50;
  send(Sound.arrow, 5);
  effects.fill(0);
  mixer.process([], [[effects], [ui]]);
  expect(effects[5]).toBeCloseTo(4.32);
});

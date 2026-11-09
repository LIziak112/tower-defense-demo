import type { BattleBus } from './eventBus';
import type { Settings } from './profile';
import { xorshift32 } from '../runtime/rng';
import { effectSoundCount, impactSound, shotSound, Sound, soundCount, synthesizeSound, type SoundId } from './audioSynth';

export function createBattleAudio(bus: BattleBus, settings: Settings) {
  let ctx: AudioContext | undefined;
  let music: GainNode, effects: GainNode, interfaceTrack: GainNode;
  const samples: AudioBuffer[] = [];
  const recent = new Int32Array(soundCount * 3).fill(-50);
  let variation = (Math.random() * 0x100000000) >>> 0;
  let mixer: AudioWorkletNode | undefined;
  let mode: 'locked' | 'loading' | 'worklet' | 'fallback' = 'locked';
  let audioMs = 0, audioClockMs = 0;
  let running = false;
  let effectsEnabled = false, interfaceEnabled = false;
  let fallbackVoices = 0;
  const apply = () => {
    if (!ctx) return;
    music.gain.value = settings.music;
    effects.gain.value = settings.effects;
    interfaceTrack.gain.value = settings.interface;
    effectsEnabled = settings.effects > 0;
    interfaceEnabled = settings.interface > 0;
  };
  function play(id: SoundId) {
    const isEffect = id < effectSoundCount;
    if (!ctx || !running || !(isEffect ? effectsEnabled : interfaceEnabled) || (!mixer && fallbackVoices >= 96)) return;
    const base = id * 3;
    let oldest = base;
    if (recent[base + 1] < recent[oldest]) oldest = base + 1;
    if (recent[base + 2] < recent[oldest]) oldest = base + 2;
    if (audioMs + 12 - recent[oldest] < 50) return;
    variation = xorshift32(variation);
    const jitter = variation & 7;
    const pitch = (variation >>> 8) & 255, volume = (variation >>> 16) & 255;
    const start = audioMs + 5 + jitter;
    if (start - recent[oldest] < 50) return;
    recent[oldest] = start;
    if (mixer) {
      // Sound ID, delay step, pitch byte, and gain byte fit in one small integer.
      mixer.port.postMessage(id | (jitter << 4) | (pitch << 7) | (volume << 15));
      return;
    }
    const source = ctx.createBufferSource(), gain = ctx.createGain();
    source.buffer = samples[id];
    source.playbackRate.value = 0.94 + pitch * (0.12 / 255);
    gain.gain.value = 0.92 + volume * (0.16 / 255);
    source.connect(gain).connect(isEffect ? effects : interfaceTrack);
    fallbackVoices++;
    source.onended = () => { fallbackVoices--; source.disconnect(); gain.disconnect(); };
    source.start((audioClockMs + 5 + jitter) / 1000);
  }
  function unlock() {
    if (ctx) { if (ctx.state === 'suspended') void ctx.resume().catch(() => {}); return; }
    if (typeof AudioContext === 'undefined') return;
    ctx = new AudioContext();
    music = ctx.createGain(); effects = ctx.createGain(); interfaceTrack = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.ratio.value = 6;
    limiter.connect(ctx.destination);
    music.connect(limiter); effects.connect(limiter); interfaceTrack.connect(limiter);
    apply();
    for (let id = 0; id < soundCount; id++) {
      const data = synthesizeSound(id as SoundId, ctx.sampleRate);
      const sample = ctx.createBuffer(1, data.length, ctx.sampleRate);
      sample.getChannelData(0).set(data);
      samples.push(sample);
    }
    const bed = ctx.createBuffer(1, ctx.sampleRate * 8, ctx.sampleRate);
    const data = bed.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / ctx.sampleRate;
      data[i] = (Math.sin(t * Math.PI * 110) + 0.65 * Math.sin(t * Math.PI * 165)) * Math.sin(Math.PI * t / 8) ** 2 * 0.045;
    }
    const source = ctx.createBufferSource();
    source.buffer = bed; source.loop = true; source.connect(music); source.start();
    const context = ctx;
    mode = 'loading';
    if (context.audioWorklet) {
      void context.audioWorklet.addModule(new URL('audio-mixer.js', location.href)).then(() => {
        mixer = new AudioWorkletNode(context, 'td-battle-mixer', {
          numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [1, 1],
          processorOptions: { samples: samples.map((sample) => sample.getChannelData(0)), effectSoundCount },
        });
        mixer.connect(effects, 0);
        mixer.connect(interfaceTrack, 1);
        mode = 'worklet';
      }).catch(() => { mode = 'fallback'; });
    } else mode = 'fallback';
    void ctx.resume().catch(() => {});
  }
  bus.on('attack', (event) => play(shotSound(event)));
  bus.on('damage_applied', (event) => play(impactSound(event)));
  bus.on('entity_died', () => play(Sound.coin));
  bus.on('build_rejected', () => play(Sound.error));
  bus.on('upgrade_rejected', () => play(Sound.error));
  bus.on('build_ok', () => play(Sound.build));
  bus.on('upgrade_ok', () => play(Sound.build));
  bus.on('wave_started', () => play(Sound.wave));
  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, true);
  return { apply, get mode() { return mode; },
    beginEvents() {
      running = ctx?.state === 'running';
      if (ctx && running) {
        audioClockMs = Math.floor(ctx.currentTime * 1000);
        const next = audioClockMs & 0x3fffffff;
        if (next < audioMs) recent.fill(-50);
        audioMs = next;
      }
    },
    visible: (visible: boolean) => {
    if (ctx) void (visible ? ctx.resume() : ctx.suspend()).catch(() => {});
  } };
}

class BattleMixer extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.samples = processorOptions.samples;
    this.effectSoundCount = processorOptions.effectSoundCount;
    this.voice = new Int8Array(96).fill(-1);
    this.start = new Float64Array(96);
    this.position = new Float64Array(96);
    this.rate = new Float64Array(96);
    this.gain = new Float64Array(96);
    this.last = new Float64Array(this.samples.length * 3).fill(-Infinity);
    this.port.onmessage = ({ data }) => {
      const sound = data & 15;
      const delay = 5 + ((data >>> 4) & 7);
      const start = currentFrame + Math.round(sampleRate * delay / 1000);
      const base = sound * 3;
      let slot = base;
      if (this.last[base + 1] < this.last[slot]) slot = base + 1;
      if (this.last[base + 2] < this.last[slot]) slot = base + 2;
      if (start - this.last[slot] < Math.ceil(sampleRate * 0.05)) return;
      for (let i = 0; i < this.voice.length; i++) {
        if (this.voice[i] !== -1) continue;
        this.last[slot] = start;
        this.voice[i] = sound;
        this.start[i] = start;
        this.position[i] = 0;
        this.rate[i] = 0.94 + ((data >>> 7) & 255) * (0.12 / 255);
        this.gain[i] = 0.92 + ((data >>> 15) & 255) * (0.16 / 255);
        break;
      }
    };
  }

  process(_inputs, outputs) {
    for (let i = 0; i < this.voice.length; i++) {
      const sound = this.voice[i];
      if (sound < 0) continue;
      const out = outputs[sound < this.effectSoundCount ? 0 : 1][0];
      if (!out) continue;
      const sample = this.samples[sound];
      const rate = this.rate[i], gain = this.gain[i];
      let pos = this.position[i];
      const offset = Math.max(0, this.start[i] - currentFrame);
      for (let j = offset; j < out.length && pos < sample.length; j++, pos += rate) {
        const index = Math.floor(pos);
        const a = sample[index], b = sample[index + 1] ?? 0;
        out[j] += (a + (b - a) * (pos - index)) * gain;
      }
      this.position[i] = pos;
      if (pos >= sample.length) this.voice[i] = -1;
    }
    return true;
  }
}

registerProcessor('td-battle-mixer', BattleMixer);

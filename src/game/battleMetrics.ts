export function createBattleMetrics() {
  const frames = new Float64Array(32768), ticks = new Float64Array(32768), work = new Float64Array(32768);
  let frameCount = 0, tickCount = 0, workCount = 0, previousFrame = 0;
  let maxAttacks = 0;
  function distribution(values: Float64Array, count: number) {
    const samples = values.slice(0, Math.min(count, values.length)).sort();
    const mean = samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 0;
    const percentile = (q: number) => samples[Math.ceil(samples.length * q) - 1] ?? 0;
    const long = samples.reduce((count, value) => count + Number(value > 1000 / 60), 0);
    return { count: samples.length, mean, p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99), max: percentile(1), over16_67: long };
  }
  return {
    frame(now: number) {
      if (previousFrame) frames[frameCount++ % frames.length] = now - previousFrame;
      previousFrame = now;
    },
    tick(duration: number, attacks: number) {
      ticks[tickCount++ % ticks.length] = duration;
      maxAttacks = Math.max(maxAttacks, attacks);
    },
    work(duration: number) { work[workCount++ % work.length] = duration; },
    reset() { frameCount = tickCount = workCount = previousFrame = maxAttacks = 0; },
    read() {
      return { frameMs: distribution(frames, frameCount), tickMs: distribution(ticks, tickCount), frameWorkMs: distribution(work, workCount), maxAttacks };
    },
  };
}

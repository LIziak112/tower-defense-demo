export const unit = (value: number) => Math.max(0, Math.min(1, value));
export const easeOut = (t: number) => 1 - (1 - unit(t)) ** 3;

export function follow(current: number, target: number, seconds: number, rate = 25) {
  return Math.abs(current - target) < 0.001 ? target : current + (target - current) * -Math.expm1(-rate * seconds);
}

/** Analytic underdamped spring with an initial displacement and zero velocity. */
export function springOffset(seconds: number, frequency: number, damping: number) {
  const oscillation = Math.sqrt(frequency * frequency - damping * damping);
  const angle = seconds * oscillation;
  return Math.exp(-damping * seconds) * (Math.cos(angle) + damping / oscillation * Math.sin(angle));
}

export function createTween(duration: number) {
  let from = 0, to = 0, start = 0, value = 0;
  return (next: number, now: number, animate: boolean) => {
    if (!animate) { from = to = value = next; return value; }
    if (next !== to) { from = value; to = next; start = now; }
    value = from + (to - from) * easeOut((now - start) / duration);
    return value;
  };
}

// xorshift32; state lives in BattleState so it is snapshot-able.
export function xorshift32(s: number): number {
  let x = s | 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return x >>> 0 || 0x9e3779b9;
}
export function seedState(seed: number): number {
  return (seed >>> 0) || 0x9e3779b9;
}
/** returns [value in [0,n), nextState] */
export function nextInt(state: number, n: number): [number, number] {
  const s = xorshift32(state);
  return [s % n, s];
}

import { follow } from './motion';

export function createBoardCamera() {
  let width = 0, height = 0, target = 1, pivotX = 0, pivotY = 0;
  let last = 0, coast = 0, vx = 0, vy = 0;
  const camera = {
    x: 0, y: 0, scale: 1,
    reset(w: number, h: number) {
      width = w; height = h;
      camera.x = camera.y = last = coast = vx = vy = 0;
      camera.scale = target = 1;
    },
    wheel(x: number, y: number, delta: number) {
      pivotX = x; pivotY = y;
      target = Math.max(1, Math.min(2.6, target * Math.exp(-delta * 0.0015)));
      coast = 0;
    },
    pan(dx: number, dy: number, elapsed: number) {
      target = camera.scale;
      camera.x += dx; camera.y += dy;
      vx = Math.max(-2, Math.min(2, dx / Math.max(8, elapsed)));
      vy = Math.max(-2, Math.min(2, dy / Math.max(8, elapsed)));
      coast = 0;
      bound();
    },
    release(now: number, recent: boolean) { coast = recent ? now + 250 : 0; },
    advance(now: number, animate: boolean) {
      const dt = last ? Math.min(32, Math.max(0, now - last)) : 0;
      last = now;
      const before = camera.scale;
      camera.scale = animate ? follow(before, target, dt / 1000, 19) : target;
      if (camera.scale !== before) {
        const ratio = camera.scale / before;
        camera.x = pivotX - (pivotX - camera.x) * ratio;
        camera.y = pivotY - (pivotY - camera.y) * ratio;
      }
      if (animate && coast > now) {
        const friction = ((coast - now) / 250) ** 2;
        camera.x += vx * dt * friction; camera.y += vy * dt * friction;
      }
      bound();
    },
  };
  function bound() {
    camera.x = Math.max(width * (1 - camera.scale), Math.min(0, camera.x));
    camera.y = Math.max(height * (1 - camera.scale), Math.min(0, camera.y));
  }
  return camera;
}

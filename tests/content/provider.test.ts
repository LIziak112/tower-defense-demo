import { describe, it, expect } from 'vitest';
import { MockProvider } from '../../src/content/provider';

describe('MockProvider', () => {
  it('loads valid config and serves it', () => {
    const provider = new MockProvider();
    provider.register({
      id: "level_test",
      name: "Test",
      description: "...",
      map: { width: 10, height: 10, path: [{x:0,y:0},{x:9,y:9}] },
      towers: [{ id: "t1", name: "T1", cost: 50, damage: 5, range: 3, cooldown: 10 }],
      waves: [{ count: 5, interval: 60, enemyHp: 10, enemySpeed: 1 }]
    });

    const cfg = provider.get('level_test');
    expect(cfg.name).toBe('Test');
  });

  it('throws on invalid config', () => {
    const provider = new MockProvider();
    expect(() => {
      provider.register({ id: "invalid", map: { width: 1 } });
    }).toThrow(/Content loading failed/);
  });
});

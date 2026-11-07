import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/content/schema';

describe('Config Schema Validation', () => {
  const validConfig = {
    id: "level1",
    name: "Level 1",
    description: "The first level",
    map: {
      width: 10,
      height: 10,
      path: [{x: 0, y: 5}, {x: 9, y: 5}]
    },
    towers: [
      { id: "basic", name: "Basic Tower", cost: 100, damage: 10, range: 3, cooldown: 30 }
    ],
    waves: [
      { count: 10, interval: 60, enemyHp: 50, enemySpeed: 1 }
    ]
  };

  it('accepts valid config', () => {
    const result = validateConfig(validConfig);
    expect(result.success).toBe(true);
  });

  it('rejects out of bound map size', () => {
    const invalid = { ...validConfig, map: { ...validConfig.map, width: 4 } };
    const result = validateConfig(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain('map.width: Too small');
    }
  });
  
  it('rejects cheap tower', () => {
    const invalid = { ...validConfig, towers: [{ ...validConfig.towers[0], cost: 5 }] };
    const result = validateConfig(invalid);
    expect(result.success).toBe(false);
  });
});

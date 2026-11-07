import { GameConfig } from './schema';
import { ContentLoader } from './loader';

export class MockProvider {
  private configs: Record<string, GameConfig> = {};

  register(config: unknown) {
    const valid = ContentLoader.loadMock(config);
    this.configs[valid.id] = valid;
  }

  get(id: string): GameConfig {
    if (!this.configs[id]) throw new Error(`Level ${id} not found`);
    return this.configs[id];
  }
}

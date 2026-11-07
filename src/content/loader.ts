import { GameConfig, validateConfig } from './schema';

export class ContentLoader {
  static loadMock(levelData: unknown): GameConfig {
    const result = validateConfig(levelData);
    if (!result.success) {
      throw new Error(`Content loading failed:\n${result.errors.join('\n')}`);
    }
    return result.data;
  }
}

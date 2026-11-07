// AI provider interface. Default = MockProvider (offline, deterministic, zero cost).
// LlmProvider is NOT included in D2; no API key / base URL is read anywhere in the bundle.
import type { RawPack } from '../content/schema';
import type { VError } from '../content/validate';
export interface GenerateInput { text: string; previous?: RawPack; errors?: VError[] }
export interface ContentProvider {
  readonly name: string;
  readonly isMock: boolean;
  generateContent(input: GenerateInput): RawPack;
}

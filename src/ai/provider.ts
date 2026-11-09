// AI provider interface. Default = MockProvider (offline, deterministic, zero cost).
// 同步接口给 Mock；真模型走 src/ai/llm.ts 的 LlmContentProvider（异步，经军师通道 kind:'level'，由 runPipelineAsync 编排并在失败时退回 Mock）。
// 不变量仍然成立：bundle 里任何地方都不读 API key / base URL；凭据只在通道对端（宿主代理 / 开发代理）。
import type { RawPack } from '../content/schema';
import type { VError } from '../content/validate';
export interface GenerateInput { text: string; previous?: RawPack; errors?: VError[] }
export interface ContentProvider {
  readonly name: string;
  readonly isMock: boolean;
  generateContent(input: GenerateInput): RawPack;
}

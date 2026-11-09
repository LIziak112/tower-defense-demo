// 军师适配层入口（任务 fb4d93bc）。读法：types（契约与校验）→ snapshot（极简快照）→ local（兜底模板）→ prompt（LLM 提示）→ channels（通道）→ session（编排）。
export * from './types';
export { buildSnapshot, snapshotSlots, allSlots, reachTable, slotCell, cellSlot } from './snapshot';
export { adviseLocal, simulateWave, LOCAL_ADVISOR_NAME } from './local';
export { advicePrompt, levelPrompt, type LlmPrompt, type LevelPromptInput } from './prompt';
export { HostChannel, HttpChannel, ScriptedChannel } from './channels';
export { AdvisorSession, type AdvisorView, type Presented, type Outcome, type BetRecord, type LogEntry, type SessionOptions, type Source, type Lang } from './session';
export { selectChannel, type Selection, type AdvisorMode } from './select';

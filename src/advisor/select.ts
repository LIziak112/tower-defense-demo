// provider 切换：?advisor=local | host | <http(s)://… 或 /相对路径>；缺省：嵌在 Hikos 里走宿主代理，独立打开走本地模板。
// HTTP 开发代理只在非嵌入时允许（嵌入时凭据与路由归宿主，游戏不直连任何端点）。src/ 不读构建环境（D2 护栏）：开关只来自 URL 与宿主消息。
import { HostChannel, HttpChannel } from './channels';
import type { AdvisorChannel } from './types';

export type AdvisorMode = 'local' | 'host' | 'http';
export interface SelectInput {
  search: string;
  embedded: boolean;
  makeHost: () => HostChannel;
  fetchFn?: typeof fetch;
}
export interface Selection { channel: AdvisorChannel | null; mode: AdvisorMode; reason: string }

const isHttpTarget = (v: string) => /^https?:\/\//i.test(v) || v.startsWith('/');

export function selectChannel(i: SelectInput): Selection {
  const want = (new URLSearchParams(i.search).get('advisor') ?? '').trim();
  if (want === 'local') return { channel: null, mode: 'local', reason: '?advisor=local' };
  if (want === 'host') return i.embedded ? { channel: i.makeHost(), mode: 'host', reason: '?advisor=host' } : { channel: null, mode: 'local', reason: '?advisor=host 但不在 iframe 里，退本地' };
  if (want && isHttpTarget(want)) {
    if (i.embedded) return { channel: i.makeHost(), mode: 'host', reason: '嵌入时不允许游戏直连 HTTP 代理，改走宿主' };
    return { channel: new HttpChannel(want, i.fetchFn), mode: 'http', reason: `?advisor=${want}` };
  }
  if (i.embedded) return { channel: i.makeHost(), mode: 'host', reason: '嵌入缺省：宿主代理' };
  return { channel: null, mode: 'local', reason: '独立缺省：本地模板' };
}

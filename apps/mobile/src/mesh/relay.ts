// 回连代报（spec §4.3）：sync 成功路径后调用（`.catch(() => {})`，不阻塞 UI）。
// 两路逻辑（本机所发补发 + gossip 代报）在 core-ts/mesh/gossip-flow.ts，这里只是页面侧入口。
import { flushRelayFlow, type RelayFlushStats } from '@base/core-ts';
import type { Adapters } from '@base/core-ts';
import type { LocalRepo } from '@base/core-ts/repo';

export type { RelayFlushStats };

/** 兼容 SyncOptions 直传（多出的 workDir 字段无碍）。 */
export function flushRelay(input: {
  adapters: Adapters;
  repo: LocalRepo;
  nodeBaseUrl: string;
}): Promise<RelayFlushStats> {
  return flushRelayFlow(input);
}

// gossip 收发引擎（Task 6）：plus.io 落盘细节收口在此，纯逻辑在 core-ts/mesh/gossip-flow（Node 可测）。
// 页面 handler 与交换定时器只调这里，禁止再内联 verify/落盘逻辑（消除 Task 5 的双处漂移）。
import {
  exchangeGossipFlow,
  ingestGossipFlow,
  outgoingGossipFlow,
  type GossipExchangeStats,
  type GossipIngestResult,
  type GossipMessage,
  type Adapters,
} from '@base/core-ts';
import type { LocalRepo } from '@base/core-ts/repo';

/** 单条收件：验签 → payload 落盘（已存在跳过）→ 先到先得入库 → 驱逐保缓存上限。 */
export function ingestGossip(input: {
  adapters: Adapters;
  repo: LocalRepo;
  workDir: string;
  msg: unknown;
  now: number;
}): Promise<GossipIngestResult> {
  return ingestGossipFlow({
    repo: input.repo,
    fs: input.adapters.fs,
    workDir: input.workDir,
    msg: input.msg,
    now: input.now,
  });
}

/** 本机所发的可外传消息（comment_out 未发送行；定案 6：收件缓存转发二期）。 */
export function outgoingGossip(input: { repo: LocalRepo; myPubHex: string }): Promise<GossipMessage[]> {
  return outgoingGossipFlow(input);
}

/** 双向一轮：推本机所发 + 拉对端所发逐条入库。对端不可达抛错，调用方按轮兜底。 */
export function exchangeGossip(input: {
  adapters: Adapters;
  repo: LocalRepo;
  myPubHex: string;
  baseUrl: string;
  token: string;
  since: string;
  workDir: string;
}): Promise<GossipExchangeStats> {
  return exchangeGossipFlow({
    repo: input.repo,
    fs: input.adapters.fs,
    http: input.adapters.http,
    workDir: input.workDir,
    myPubHex: input.myPubHex,
    baseUrl: input.baseUrl,
    token: input.token,
    since: input.since,
  });
}

export type { GossipExchangeStats, GossipIngestResult };

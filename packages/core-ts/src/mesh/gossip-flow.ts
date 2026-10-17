// gossip 收发与回连代报的纯逻辑（#82 spec §4，Task 6）。
// 只依赖注入的 LocalRepo / FsAdapter / HttpAdapter，不 import 'uni'/'plus'，
// Node 下用 core/fakes.ts 完整测试；mobile 端 mesh/gossip-engine.ts、mesh/relay.ts 只做薄封装。
//
// 定案 6：收件缓存转发不实现（转发面二期）——
//   outgoing 只转本机所发（comment_out 未发送行，received 事件不含在内）；
//   服务端 GET /mesh/v1/gossip 也只服务本机所发（gossip_events 不存 actor_pubkey，转发即丢）。
import { deriveIdentityId, utf8, type Json } from '@base/protocol-ts';

import { ensureRegistered, flushPending } from '../comment';
import { ensureLocalIdentity, signRequestHeaders, type Identity } from '../identity';
import type { Adapters, FsAdapter, HttpAdapter } from '../platform/adapter';
import type { GossipRow, LocalRepo } from '../repo';
import { decodeUtf8 } from '../sync';
import type { CommentOutRow } from '../types';
import {
  GOSSIP_CACHE_MAX_AGE_MS,
  GOSSIP_CACHE_MAX_ROWS,
  verifyGossipMessage,
  type GossipMessage,
} from './gossip';
import { MeshClient } from './client';

/** 标准 base64（+/= 字母表）：接收端用 atob 解码，base64url 的 -_ 会被 atob 拒收。
 *  手写不用 btoa：老 WebView 无稳定 btoa（wire.ts 同因），Node 亦无 btoa。 */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 63];
  }
  return out;
}

/** comment_out 行 → gossip 消息：event 三元组 + sig 取 wire 字段（逐字节保真），payload_b64=base64(text)。
 *  白名单外类型不转（payload_b64 是评论正文语义；节点代报也只收 comment.v1）。 */
export function commentOutToGossipMessage(row: CommentOutRow, myPubHex: string): GossipMessage | null {
  let w: { event_id?: unknown; type?: unknown; created_at?: unknown; body?: unknown; sig?: unknown };
  try {
    w = JSON.parse(row.wire) as typeof w;
  } catch {
    return null;
  }
  if (
    w.type !== 'comment.v1' ||
    typeof w.event_id !== 'string' ||
    typeof w.type !== 'string' ||
    typeof w.created_at !== 'number' ||
    typeof w.sig !== 'string' ||
    typeof w.body !== 'object' ||
    w.body === null
  ) {
    return null;
  }
  return {
    event: { event_id: w.event_id, type: w.type, created_at: w.created_at, body: w.body as Json, sig: w.sig },
    actor_pubkey: myPubHex,
    payload_b64: toBase64(utf8(row.text)),
  };
}

/**
 * 本机所发的可外传消息：comment_out 中 state='pending' 的行。
 * failed 行是节点明确拒绝过的（重发无意义），不外传——外传只会把拒绝结论扩散给对端。
 */
export async function outgoingGossipFlow(input: { repo: LocalRepo; myPubHex: string }): Promise<GossipMessage[]> {
  const rows = await input.repo.listCommentOut();
  const messages: GossipMessage[] = [];
  for (const row of rows) {
    if (row.state !== 'pending') continue;
    const m = commentOutToGossipMessage(row, input.myPubHex);
    if (m !== null) messages.push(m);
  }
  return messages;
}

export type GossipIngestResult = 'stored' | 'duplicate' | 'rejected';

/**
 * 单条 gossip 收件：验签 → payload 落盘（`<workDir>/gossip/<payload_cid>`，已存在跳过）
 * → 先到先得入库（带原签名 body 全文）→ 驱逐保缓存上限。任一步失败静默拒收，不断连。
 */
export async function ingestGossipFlow(input: {
  repo: LocalRepo;
  fs: FsAdapter;
  workDir: string;
  msg: unknown;
  now: number;
}): Promise<GossipIngestResult> {
  const v = verifyGossipMessage(input.msg);
  if (v === null) return 'rejected';
  const payloadPath = `${input.workDir}/gossip/${v.payloadCid}`;
  try {
    if (!(await input.fs.exists(payloadPath))) {
      await input.fs.writeFile(payloadPath, utf8(v.payloadText));
    }
  } catch {
    return 'rejected'; // 落盘失败按拒收（Task 5 同口径），下次交换对端整条重推
  }
  const body = (v.msg.event.body ?? {}) as Record<string, unknown>;
  const ok = await input.repo.insertGossipEvent({
    eventId: v.msg.event.event_id,
    type: v.msg.event.type,
    targetId: typeof body.target_id === 'string' ? body.target_id : '',
    actor: deriveIdentityId(v.msg.actor_pubkey),
    createdAt: v.msg.event.created_at,
    receivedAt: input.now,
    payloadCid: v.payloadCid,
    payloadPath,
    sig: v.msg.event.sig,
    relayed: 0,
    bodyJson: JSON.stringify(v.msg.event.body ?? {}),
  });
  if (!ok) return 'duplicate';
  await input.repo.evictGossip(GOSSIP_CACHE_MAX_ROWS, GOSSIP_CACHE_MAX_AGE_MS, input.now);
  return 'stored';
}

export interface GossipExchangeStats {
  /** 本轮推给对端的消息数 */
  sent: number;
  stored: number;
  duplicate: number;
  rejected: number;
  /** 收件游标（一期服务端不分页，原样返回；调用方下一轮带回） */
  cursor: string;
}

/**
 * 双向一轮（spec §3.3「双向」）：先推本机所发，再拉对端所发逐条入库。
 * 推送失败（对端不可达）直接抛错，由调用方按轮兜底（30s 后重试）。
 */
export async function exchangeGossipFlow(input: {
  repo: LocalRepo;
  fs: FsAdapter;
  http: HttpAdapter;
  workDir: string;
  myPubHex: string;
  baseUrl: string;
  token: string;
  since: string;
  now?: number;
}): Promise<GossipExchangeStats> {
  const now = input.now ?? Date.now();
  const client = new MeshClient(input.http);
  const out = await outgoingGossipFlow({ repo: input.repo, myPubHex: input.myPubHex });
  if (out.length > 0) await client.postGossip(input.baseUrl, input.token, out);
  const messages = await client.fetchGossip(input.baseUrl, input.token, input.since);
  const stats: GossipExchangeStats = { sent: out.length, stored: 0, duplicate: 0, rejected: 0, cursor: input.since };
  for (const m of messages) {
    const r = await ingestGossipFlow({ repo: input.repo, fs: input.fs, workDir: input.workDir, msg: m, now });
    if (r === 'stored') stats.stored += 1;
    else if (r === 'duplicate') stats.duplicate += 1;
    else stats.rejected += 1;
  }
  return stats;
}

export interface RelayFlushStats {
  /** 路 1：本机所发经既有补发队列直达节点的条数 */
  ownSent: number;
  /** 路 2：代报（gossip 收到的他人事件）成功的条数 */
  relaySent: number;
  /** 路 2：节点明确拒绝（4xx/5xx）的条数；行保持 relayed=0，下次回连再试 */
  failed: number;
}

/** 代报单条：body 优先取入库时的原签名 body 全文（reply_to 只在这里有）；旧行兜底从 payload 文件重建。
 *  返回节点响应码；传输失败抛错由调用方中止本轮（网络刚断时后续必然同错，体例同 flushPending）。 */
async function postRelayEvent(input: {
  adapters: Adapters;
  nodeBaseUrl: string;
  ident: Identity;
}, row: GossipRow): Promise<number> {
  let body: Record<string, Json>;
  if (row.bodyJson) {
    try {
      body = JSON.parse(row.bodyJson) as Record<string, Json>;
    } catch {
      return 400;
    }
  } else {
    // 旧版本入库行没有 body_json：从 payload 文件重建 {target_id, text}（reply 评论重建不全，节点验签必拒）
    try {
      const text = decodeUtf8(await input.adapters.fs.readFile(row.payloadPath));
      body = { target_id: row.targetId, text };
    } catch {
      return 400;
    }
  }
  const bytes = utf8(JSON.stringify({ event_id: row.eventId, type: row.type, created_at: row.createdAt, body, sig: row.sig }));
  const res = await input.adapters.http.post(`${input.nodeBaseUrl}/v1/event`, bytes, {
    'Content-Type': 'application/json',
    ...signRequestHeaders(input.ident, { method: 'POST', path: '/v1/event', body: bytes }),
    'X-Base-Relay-For': row.actor,
    'X-Base-Relay-Device': input.ident.id,
  });
  return res.status;
}

/**
 * 回连两路（spec §4.3）：
 *   路 1 本机所发——复用 comment.ts 既有补发入口（wire 逐字节重放 + 登记 + 限速语义全现成）；
 *   路 2 代报——listGossipSince 扫 relayed=0 行 → POST /v1/event（原事件 JSON + Relay 头 + 本机身份签名头）。
 * 节点侧 requireAuth 要求代报设备已登记，先 ensureRegistered 一次。**不抛错**，结果只经返回值体现。
 */
export async function flushRelayFlow(input: {
  adapters: Adapters;
  repo: LocalRepo;
  nodeBaseUrl: string;
}): Promise<RelayFlushStats> {
  const stats: RelayFlushStats = { ownSent: 0, relaySent: 0, failed: 0 };
  if (input.nodeBaseUrl === '') return stats;

  stats.ownSent = (await flushPending({ adapters: input.adapters, repo: input.repo, nodeBaseUrl: input.nodeBaseUrl })).sent;

  let ident;
  try {
    ident = await ensureLocalIdentity(input.adapters.storage);
    await ensureRegistered({ adapters: input.adapters, repo: input.repo, nodeBaseUrl: input.nodeBaseUrl });
  } catch {
    return stats; // 登记不了（网络/节点异常）：代报整轮跳过，下次回连再试
  }

  let cursorReceived = 0;
  let cursorEvent = '';
  for (;;) {
    const rows = await input.repo.listGossipSince(cursorReceived, cursorEvent, 200);
    if (rows.length === 0) break;
    for (const row of rows) {
      cursorReceived = row.receivedAt;
      cursorEvent = row.eventId;
      if (row.relayed !== 0) continue;
      try {
        if ((await postRelayEvent({ adapters: input.adapters, nodeBaseUrl: input.nodeBaseUrl, ident }, row)) === 200) {
          await input.repo.markGossipRelayed(row.eventId);
          stats.relaySent += 1;
        } else {
          stats.failed += 1;
        }
      } catch {
        break; // 传输失败：本轮中止（后续必然同错），行保持 relayed=0 下次回连再试
      }
    }
    if (rows.length < 200) break;
  }
  return stats;
}

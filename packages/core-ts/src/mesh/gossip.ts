// gossip 消息（spec §4.2 写死）：event 原样 + actor_pubkey + payload_b64。
// 一期只接受 comment.v1，其余类型静默丢弃；任一步失败返回 null（静默丢，不断连）。
import { blobId, canonicalize, utf8, verify, type Json } from '@base/protocol-ts';

import { decodeUtf8 } from '../sync';

export const GOSSIP_TYPES: ReadonlySet<string> = new Set(['comment.v1']);
export const GOSSIP_CACHE_MAX_ROWS = 500;
export const GOSSIP_CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface GossipMessage {
  event: { event_id: string; type: string; created_at: number; body: Json; sig: string };
  actor_pubkey: string;
  payload_b64: string;
}

export interface GossipVerified {
  msg: GossipMessage;
  payloadCid: string;
  payloadText: string;
}

/** 验 sig（canonical({event_id,type,created_at,body})，总纲 §7.3 逐字）+ 类型白名单；非法返回 null（静默丢）。 */
export function verifyGossipMessage(msg: unknown): GossipVerified | null {
  if (msg === null || typeof msg !== 'object') return null;
  const m = msg as Partial<GossipMessage>;
  const ev = m.event;
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.event_id !== 'string' || !/^[0-9a-f]{16}$/.test(ev.event_id)) return null;
  if (!GOSSIP_TYPES.has(ev.type)) return null;
  const createdAt = ev.created_at;
  if (typeof createdAt !== 'number' || !Number.isInteger(createdAt) || createdAt <= 0) return null;
  if (typeof ev.sig !== 'string' || ev.sig.length !== 128) return null;
  if (typeof m.actor_pubkey !== 'string' || m.actor_pubkey.length !== 64) return null;
  if (typeof m.payload_b64 !== 'string') return null;
  let bytes: Uint8Array;
  let payloadText: string;
  try {
    bytes = Uint8Array.from(atob(m.payload_b64), (c) => c.charCodeAt(0));
    // payloadText 用手写 UTF-8 解码：老 WebView 无 TextDecoder（真机已实测），体例同 core/sync.ts
    payloadText = decodeUtf8(bytes);
    const cid = blobId(bytes);
    const ok = verify(
      m.actor_pubkey,
      utf8(canonicalize({ event_id: ev.event_id, type: ev.type, created_at: createdAt, body: ev.body as Json })),
      ev.sig,
    );
    if (!ok) return null;
    return { msg: m as GossipMessage, payloadCid: cid, payloadText };
  } catch {
    return null;
  }
}

import { describe, expect, it } from 'vitest';
import { blobId, canonicalize, keyPairFromSeed, sign, utf8, type Json } from '@base/protocol-ts';

import {
  GOSSIP_CACHE_MAX_AGE_MS,
  GOSSIP_CACHE_MAX_ROWS,
  GOSSIP_TYPES,
  verifyGossipMessage,
  type GossipMessage,
} from './gossip';

const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUB = keyPairFromSeed(SEED).pubHex;
const OTHER_PUB = keyPairFromSeed('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb').pubHex;

const BODY: Json = { target_id: 'article/a', text: '评论正文' };

/** 签名字节 = canonical({event_id,type,created_at,body})，与 verifyGossipMessage 的验签口径逐字一致。 */
function signEvent(ev: { event_id: string; type: string; created_at: number; body: Json }): string {
  return sign(SEED, utf8(canonicalize({ event_id: ev.event_id, type: ev.type, created_at: ev.created_at, body: ev.body })));
}

function makeMsg(): GossipMessage {
  return {
    event: {
      event_id: 'a1b2c3d4e5f60718',
      type: 'comment.v1',
      created_at: 1760640000,
      body: BODY,
      sig: '',
    },
    actor_pubkey: PUB,
    payload_b64: Buffer.from(utf8('评论正文')).toString('base64'),
  };
}

describe('verifyGossipMessage', () => {
  it('真签名通过且 payloadCid = blobId(payload 明文)', () => {
    const m = makeMsg();
    m.event.sig = signEvent(m.event);
    const v = verifyGossipMessage(m);
    expect(v).not.toBeNull();
    expect(v?.payloadText).toBe('评论正文');
    expect(v?.payloadCid).toBe(blobId(utf8('评论正文')));
    expect(v?.msg.event.sig).toBe(m.event.sig);
  });

  it('篡改 body 一字节 → null（静默丢）', () => {
    const m = makeMsg();
    m.event.sig = signEvent(m.event);
    m.event.body = { target_id: 'article/a', text: '评论正攵' };
    expect(verifyGossipMessage(m)).toBeNull();
  });

  it('白名单外 like.v1 → null（一期只收 comment.v1）', () => {
    const m = makeMsg();
    m.event.sig = signEvent(m.event);
    m.event.type = 'like.v1';
    expect(verifyGossipMessage(m)).toBeNull();
  });

  it('actor_pubkey 换人 → null', () => {
    const m = makeMsg();
    m.event.sig = signEvent(m.event);
    m.actor_pubkey = OTHER_PUB;
    expect(verifyGossipMessage(m)).toBeNull();
  });

  it('白名单与缓存常量锁定（spec §4.2：500 条 / 7 天）', () => {
    expect([...GOSSIP_TYPES]).toEqual(['comment.v1']);
    expect(GOSSIP_CACHE_MAX_ROWS).toBe(500);
    expect(GOSSIP_CACHE_MAX_AGE_MS).toBe(7 * 24 * 3600 * 1000);
  });
});

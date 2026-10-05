import { describe, expect, it } from 'vitest';

import { bytesToHex, canonicalize, hexToBytes, openWithNonce, sign, utf8, type Json } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, MemoryStorage } from './fakes';
import type { Adapters } from './platform/adapter';
import { flushPending } from './comment';
import { deviceKek, ensureLocalIdentity, type Identity } from './identity';
import { decodeUtf8 } from './sync';
import { base64UrlToBytes, bytesToBase64Url, openKeyCipher, sealText } from './wire';
import {
  acceptFriendCode,
  createFriend,
  decodeFriendCode,
  DM_DECRYPT_FAILED_NOTICE,
  DM_KEY_MISSING_NOTICE,
  DmError,
  fetchConversation,
  listFriends,
  postDM,
  type DmOptions,
} from './dm';

const BASE = 'https://node.test';

function fixture() {
  const http = new FakeHttp();
  const storage = new MemoryStorage();
  const repo = new MemoryRepo();
  const adapters: Adapters = { fs: new MemoryFs(), storage, http, packReader: new FakePackReader() };
  const o: DmOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, storage, repo, o };
}

/** 造一个 200 JSON 响应（与 group.test.ts 同名同形）。 */
function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

/** 可开关的「网络不可达」模拟：只挡 http，本地存储与仓储照常走（照 comment.test.ts 的 gatePost）。 */
function gateOffline(o: DmOptions): { offline: boolean } {
  const real = o.adapters.http;
  const state = { offline: true };
  o.adapters.http = {
    get: (url, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.get(url, headers)),
    post: (url, body, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.post(url, body, headers)),
    put: (url, body, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.put(url, body, headers)),
  };
  return state;
}

/** 用自己的设备 KEK 解开 `dm_keys.key_cipher`，回原始 32 字节 hex（AC 1 的「key 相同」判定）。 */
async function dmKeyHex(storage: MemoryStorage, cipher: string): Promise<string> {
  const kek = await deviceKek(storage);
  const [n, ct] = cipher.split(':');
  return bytesToHex(openWithNonce(kek, hexToBytes(n!), hexToBytes(ct!)));
}

/** 手工重编码（篡改用）：解析原载荷 → mutate → 重新 base64url（**不重签**，故必然验签失败）。 */
function rewrap(code: string, mutate: (obj: Record<string, unknown>) => void): string {
  const obj = JSON.parse(decodeUtf8(base64UrlToBytes(code.slice('base1:'.length)))) as Record<string, unknown>;
  mutate(obj);
  return 'base1:' + bytesToBase64Url(utf8(JSON.stringify(obj)));
}

/** 手工签一张合法好友码（造「同 peer 不同 key」用；不经过 createFriend 的密钥落库）。 */
function handSignedCode(
  owner: Identity,
  fields: { peerId: string; keyHex: string; ownerName?: string; createdAt?: number },
): string {
  const payload: Record<string, Json> = {
    v: 1,
    peer_id: fields.peerId,
    key: fields.keyHex,
    owner_id: owner.id,
    owner_name: fields.ownerName ?? '',
    owner_pub: owner.pubHex,
    created_at: fields.createdAt ?? Date.now(),
  };
  const sig = sign(owner.seedHex, utf8(canonicalize(payload)));
  return 'base1:' + bytesToBase64Url(utf8(canonicalize({ ...payload, sig })));
}

/** 断言一个 Promise 抛 `DmError(code)`（比 `toThrowError` 更精确，不受文案影响）。 */
async function expectDmError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DmError && e.code === code) return;
    throw new Error(`期望 DmError(${code})，实得 ${String(e)}`);
  }
  throw new Error(`期望抛 DmError(${code})，但未抛错`);
}

describe('dm', () => {
  it('AC 1：A 断网出码、B 断网粘码，双方各落一条 dm_keys 且 key 相同', async () => {
    const a = fixture();
    const b = fixture();
    gateOffline(a.o);
    gateOffline(b.o);
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = (await ensureLocalIdentity(b.storage)).id;

    const made = await createFriend(a.o, idB, '阿甲');
    expect(made.code.startsWith('base1:')).toBe(true);
    expect(a.http.posted).toHaveLength(0); // 出码全程离线：不发任何请求

    const joined = await acceptFriendCode(b.o, made.code);
    expect(joined.idempotent).toBe(false);
    expect(b.http.posted).toHaveLength(0); // 粘码全程离线（AC 1）

    const ka = await a.repo.listDmKeys();
    const kb = await b.repo.listDmKeys();
    expect(ka).toHaveLength(1);
    expect(kb).toHaveLength(1);
    expect(ka[0]!.peerId).toBe(idB);
    expect(kb[0]!.peerId).toBe(idA);
    expect(await dmKeyHex(b.storage, kb[0]!.keyCipher)).toBe(await dmKeyHex(a.storage, ka[0]!.keyCipher));
  });

  it('AC 2：篡改任一字段被拒（统一文案）；码转给第三方因 peer_id 不符被拒', async () => {
    const a = fixture();
    const b = fixture();
    const c = fixture();
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = (await ensureLocalIdentity(b.storage)).id;
    const idC = (await ensureLocalIdentity(c.storage)).id;
    const made = await createFriend(a.o, idB, '阿甲');

    // ① 篡改 key 字段（不改 sig）⇒ 验签失败 ⇒ 统一文案
    const tampered = rewrap(made.code, (o) => {
      const k = String(o.key ?? '');
      o.key = (k[0] === 'a' ? 'b' : 'a') + k.slice(1);
    });
    expect(() => decodeFriendCode(tampered, idB)).toThrowError('好友码无效或已损坏');

    // ② 定向：把 B 的码转给 C ⇒ C 解码即因 peer_id 不符被拒
    expect(() => decodeFriendCode(made.code, idC)).toThrowError('好友码无效或已损坏');

    // 合法码在本人手里通过，owner 是 A
    expect(decodeFriendCode(made.code, idB).ownerId).toBe(idA);
  });

  it('AC 8：同码重复粘贴幂等通过；同 peer 不同 key 的码被拒 key_conflict', async () => {
    const a = fixture();
    const b = fixture();
    const ownerA = await ensureLocalIdentity(a.storage);
    const idB = (await ensureLocalIdentity(b.storage)).id;
    const k1 = '11'.repeat(32);
    const k2 = '22'.repeat(32);

    const first = await acceptFriendCode(b.o, handSignedCode(ownerA, { peerId: idB, keyHex: k1 }));
    expect(first).toEqual({ peerId: ownerA.id, idempotent: false });

    // 同一张码再粘一次：幂等通过，不报错、不覆盖
    const again = await acceptFriendCode(b.o, handSignedCode(ownerA, { peerId: idB, keyHex: k1 }));
    expect(again.idempotent).toBe(true);

    // 同 peer 不同 key：拒 key_conflict，且本地密钥不动
    const before = (await b.repo.listDmKeys())[0]!.keyCipher;
    await expectDmError(acceptFriendCode(b.o, handSignedCode(ownerA, { peerId: idB, keyHex: k2 })), 'key_conflict');
    expect((await b.repo.listDmKeys())[0]!.keyCipher).toBe(before);
  });

  it('AC 5：会话只合并双方的消息，第三方发给同一 peer 的条目被硬过滤', async () => {
    const a = fixture();
    const b = fixture();
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = (await ensureLocalIdentity(b.storage)).id;
    const idThird = 'c'.repeat(32);

    const made = await createFriend(a.o, idB, '阿甲');
    await acceptFriendCode(b.o, made.code);
    const key = await openKeyCipher(a.o.adapters.storage, (await a.repo.getDmKey(idB))!.keyCipher);

    // A 的收件箱：B → A 一条
    a.http.routes.set(
      `${BASE}/v1/dm/${idA}`,
      json({ events: [{ event_id: '1'.repeat(32), actor: idB, created_at: 1790000002000, payload_cid: 'cidIn' }], next_cursor: null }),
    );
    // 查 B：第三方 → B 一条（必须被过滤）+ A → B 一条
    a.http.routes.set(
      `${BASE}/v1/dm/${idB}`,
      json({
        events: [
          { event_id: '2'.repeat(32), actor: idThird, created_at: 1790000003000, payload_cid: 'cidThird' },
          { event_id: '3'.repeat(32), actor: idA, created_at: 1790000001000, payload_cid: 'cidOut' },
        ],
        next_cursor: null,
      }),
    );
    a.http.routes.set(`${BASE}/v1/blob/cidIn`, { status: 200, body: utf8(sealText(key, '在吗')) });
    a.http.routes.set(`${BASE}/v1/blob/cidOut`, { status: 200, body: utf8(sealText(key, '在的')) });
    a.http.routes.set(`${BASE}/v1/blob/cidThird`, { status: 200, body: utf8(sealText(key, '不该出现')) });

    const convo = await fetchConversation(a.o, idB);
    // 第三方条目被丢弃，只留 A ↔ B 两条，按 created_at 升序
    expect(convo.messages.map((m) => m.eventId)).toEqual(['3'.repeat(32), '1'.repeat(32)]);
    expect(convo.messages.map((m) => m.text)).toEqual(['在的', '在吗']);
    expect(convo.messages.map((m) => m.mine)).toEqual([true, false]);
    expect(convo.notice).toBe('');
    expect(JSON.stringify(convo)).not.toContain('不该出现');
  });

  it('AC 6：断网发言入队，联网后仅补发一条；wire 含 dm.v1、不含明文', async () => {
    const a = fixture();
    await ensureLocalIdentity(a.storage);
    const idB = 'b'.repeat(32);
    await createFriend(a.o, idB, '阿乙');
    const gate = gateOffline(a.o);

    const sent = await postDM(a.o, idB, '睡前读一段');
    expect(sent.queued).toBe(true);
    const rows = await a.repo.listCommentOut();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe(`dm/${idB}`);
    expect(rows[0]!.wire).toContain('dm.v1');
    expect(rows[0]!.wire).not.toContain('睡前读一段'); // 明文不进 wire，只进 text_cipher

    gate.offline = false;
    a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    a.http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'ignored', payload_cid: 'c'.repeat(32) }));

    const first = await flushPending(a.o);
    expect(first.sent).toBe(1);
    expect(await a.repo.listCommentOut()).toHaveLength(0);

    const second = await flushPending(a.o);
    expect(second.sent).toBe(0);
    expect(a.http.posted.filter((p) => p.url.endsWith('/v1/event'))).toHaveLength(1);
  });

  it('AC 9：本地无该 peer 密钥时显示索取提示、不显示密文原文', async () => {
    const a = fixture();
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = 'b'.repeat(32);
    // 没有任何好友关系（dm_keys 为空），但收件箱里有 B 发来的密文
    a.http.routes.set(
      `${BASE}/v1/dm/${idA}`,
      json({ events: [{ event_id: '1'.repeat(32), actor: idB, created_at: 1790000000000, payload_cid: 'cidX' }], next_cursor: null }),
    );
    a.http.routes.set(`${BASE}/v1/dm/${idB}`, json({ events: [], next_cursor: null }));
    a.http.routes.set(`${BASE}/v1/blob/cidX`, { status: 200, body: utf8('不可能解开的密文') });

    const convo = await fetchConversation(a.o, idB);
    expect(convo.messages).toHaveLength(1);
    expect(convo.messages[0]!.text).toBeNull();
    expect(convo.notice).toBe(DM_KEY_MISSING_NOTICE);
    expect(JSON.stringify(convo)).not.toContain('不可能'); // 密文原文永不进界面
  });

  it('解密失败：密钥在但认证失败 → 原位提示、不显示载荷', async () => {
    const a = fixture();
    const b = fixture();
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = (await ensureLocalIdentity(b.storage)).id;
    const made = await createFriend(a.o, idB, '阿甲');
    await acceptFriendCode(b.o, made.code);

    const wrong = sealText(hexToBytes('aa'.repeat(32)), '不该出现');
    a.http.routes.set(
      `${BASE}/v1/dm/${idA}`,
      json({ events: [{ event_id: '1'.repeat(32), actor: idB, created_at: 1790000000000, payload_cid: 'cidBad' }], next_cursor: null }),
    );
    a.http.routes.set(`${BASE}/v1/dm/${idB}`, json({ events: [], next_cursor: null }));
    a.http.routes.set(`${BASE}/v1/blob/cidBad`, { status: 200, body: utf8(wrong) });

    const convo = await fetchConversation(a.o, idB);
    expect(convo.messages[0]!.text).toBeNull();
    expect(convo.notice).toBe(DM_DECRYPT_FAILED_NOTICE);
    expect(JSON.stringify(convo)).not.toContain('不该出现');
  });

  it('发言前置校验：非 32 hex / 空明文 / 超 4096 字节 / 无密钥各自被拒，且均不入队', async () => {
    const a = fixture();
    await ensureLocalIdentity(a.storage);
    const idB = 'b'.repeat(32);

    await expectDmError(postDM(a.o, 'zz', '在吗'), 'client');
    await expectDmError(postDM(a.o, idB, ''), 'client');
    await expectDmError(postDM(a.o, idB, '好'.repeat(4096)), 'too_long'); // 3 字节/字 ⇒ 12288 > 4096
    await expectDmError(postDM(a.o, idB, '在吗'), 'not_friend'); // 尚未交换好友码

    expect(await a.repo.listCommentOut()).toHaveLength(0); // 全部在入队前拦下
  });

  it('listFriends：本地好友与收件箱发件人取并集；拉收件箱失败时静默回落为仅本地好友', async () => {
    const a = fixture();
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = 'b'.repeat(32);
    const idC = 'c'.repeat(32);
    await createFriend(a.o, idB, '阿甲');

    a.http.routes.set(
      `${BASE}/v1/dm/${idA}`,
      json({
        events: [
          { event_id: '1'.repeat(32), actor: idC, created_at: 1790000000000, payload_cid: 'c1' },
          { event_id: '2'.repeat(32), actor: idB, created_at: 1790000001000, payload_cid: 'c2' },
        ],
        next_cursor: null,
      }),
    );
    expect(await listFriends(a.o)).toEqual([
      { peerId: idB, hasKey: true },
      { peerId: idC, hasKey: false },
    ]);

    // 节点不可达 → 静默回落为仅本地好友，不抛错
    a.o.adapters.http = { get: () => Promise.reject(new Error('断网')), post: () => Promise.reject(new Error('断网')), put: () => Promise.reject(new Error('断网')) };
    expect(await listFriends(a.o)).toEqual([{ peerId: idB, hasKey: true }]);
  });
});

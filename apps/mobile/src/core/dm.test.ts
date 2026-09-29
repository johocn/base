import { describe, expect, it } from 'vitest';

import { bytesToHex, canonicalize, hexToBytes, openWithNonce, sign, utf8, type Json } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, MemoryStorage } from './fakes';
import type { Adapters } from '../platform/adapter';
import { deviceKek, ensureLocalIdentity, type Identity } from './identity';
import { decodeUtf8 } from './sync';
import { base64UrlToBytes, bytesToBase64Url } from './wire';
import { acceptFriendCode, createFriend, decodeFriendCode, DmError, type DmOptions } from './dm';

const BASE = 'https://node.test';

function fixture() {
  const http = new FakeHttp();
  const storage = new MemoryStorage();
  const repo = new MemoryRepo();
  const adapters: Adapters = { fs: new MemoryFs(), storage, http, packReader: new FakePackReader() };
  const o: DmOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, storage, repo, o };
}

/** 可开关的「网络不可达」模拟：只挡 http，本地存储与仓储照常走（照 comment.test.ts 的 gatePost）。 */
function gateOffline(o: DmOptions): { offline: boolean } {
  const real = o.adapters.http;
  const state = { offline: true };
  o.adapters.http = {
    get: (url, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.get(url, headers)),
    post: (url, body, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.post(url, body, headers)),
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
});

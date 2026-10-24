import { describe, expect, it } from 'vitest';

import type { StorageAdapter } from '@base/core-ts';
import {
  MIN_PASSPHRASE_LENGTH,
  deriveMeshSeedHex,
  derivedTlsFingerprint,
  loadMeshSignKey,
  saveMeshSignKey,
} from './sign-key';

function memStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe('签名种子：口令 + 设备号派生（Argon2id）', () => {
  it('同口令同设备号复现同一 64 hex 种子', () => {
    const a = deriveMeshSeedHex('base-pass-1', 'DEVICE-A');
    const b = deriveMeshSeedHex('base-pass-1', 'DEVICE-A');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('换设备号 / 换口令都得不同种子', () => {
    const base = deriveMeshSeedHex('base-pass-1', 'DEVICE-A');
    expect(deriveMeshSeedHex('base-pass-1', 'DEVICE-B')).not.toBe(base);
    expect(deriveMeshSeedHex('base-pass-2', 'DEVICE-A')).not.toBe(base);
  });

  it(`口令少于 ${MIN_PASSPHRASE_LENGTH} 位拒绝保存`, async () => {
    await expect(saveMeshSignKey(memStorage(), '1234567')).rejects.toThrow(/至少 8 位/);
  });

  it('口令保存后可读回，且标记为派生', async () => {
    const storage = memStorage();
    const saved = await saveMeshSignKey(storage, 'base-pass-1');
    expect(saved.derived).toBe(true);
    const loaded = await loadMeshSignKey(storage);
    expect(loaded?.derived).toBe(true);
    expect(loaded?.seedHex).toBe(saved.seedHex);
    expect(loaded?.nodeId).toBe(saved.nodeId);
  });

  it('64 位 hex 私钥直接使用，不走派生', async () => {
    const seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
    const saved = await saveMeshSignKey(memStorage(), seed);
    expect(saved.derived).toBe(false);
    expect(saved.seedHex).toBe(seed);
  });

  it('派生身份的 tls_fingerprint 占位为 64 hex', () => {
    expect(derivedTlsFingerprint('aa'.repeat(32))).toMatch(/^[0-9a-f]{64}$/);
  });
});

import { describe, expect, it } from 'vitest';

import { EntropyPool, installRandomFallback } from './entropy';

/** 可计数的假随机源：每次返回 length 个 0xAB，并记录被调用次数。 */
function fakeSource(length: number, calls: { n: number }) {
  return async (): Promise<Uint8Array> => {
    calls.n++;
    return new Uint8Array(length).fill(0xab);
  };
}

describe('EntropyPool', () => {
  it('take 按需切片：取出的字节数正确且被消耗掉', async () => {
    const calls = { n: 0 };
    const pool = new EntropyPool(fakeSource(256, calls));
    await pool.refill();
    expect(pool.take(4).length).toBe(4);
    expect(pool.take(8).length).toBe(8);
    // 池内还剩 244，高于低水位（128），不应触发补池
    expect(calls.n).toBe(1);
  });

  it('取数后低于低水位会异步补池（不阻塞当前取数）', async () => {
    const calls = { n: 0 };
    const pool = new EntropyPool(fakeSource(64, calls));
    await pool.refill();
    expect(pool.take(4).length).toBe(4);
    await Promise.resolve();
    expect(calls.n).toBe(2);
  });

  it('池不足时显式抛错，不给半截数据', async () => {
    const calls = { n: 0 };
    const pool = new EntropyPool(fakeSource(16, calls));
    await pool.refill();
    expect(() => pool.take(32)).toThrow(/随机池不足/);
  });

  it('并发 refill 复用同一个 Promise', async () => {
    const calls = { n: 0 };
    const pool = new EntropyPool(fakeSource(8, calls));
    await Promise.all([pool.refill(), pool.refill(), pool.refill()]);
    expect(calls.n).toBe(1);
  });

  it('随机源返回空字节时报错', async () => {
    const pool = new EntropyPool(async () => new Uint8Array(0));
    await expect(pool.refill()).rejects.toThrow(/随机源返回空字节/);
  });
});

describe('installRandomFallback', () => {
  it('预填成功后 randomBytes 可从池中取数（无 WebCrypto 环境）', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const calls = { n: 0 };
      await installRandomFallback(fakeSource(128, calls));
      const { randomBytes, setRandomBytesFallback } = await import('@base/protocol-ts');
      expect(Array.from(randomBytes(2))).toEqual([0xab, 0xab]);
      setRandomBytesFallback(null);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
      else delete (globalThis as { crypto?: unknown }).crypto;
    }
  });
});
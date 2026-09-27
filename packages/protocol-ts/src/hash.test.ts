import { afterEach, describe, expect, it } from 'vitest';

import { randomBytes, setRandomBytesFallback } from './hash';

/** 真机上没有 WebCrypto：把 globalThis.crypto 抹掉以复现 App 逻辑层的环境。 */
function withoutWebCrypto(): PropertyDescriptor | undefined {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  return desc;
}

function restoreWebCrypto(desc: PropertyDescriptor | undefined): void {
  if (desc) Object.defineProperty(globalThis, 'crypto', desc);
  else delete (globalThis as { crypto?: unknown }).crypto;
}

afterEach(() => setRandomBytesFallback(null));

describe('randomBytes', () => {
  it('有 WebCrypto 时直接用 getRandomValues', () => {
    const out = randomBytes(16);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(16);
  });

  it('无 WebCrypto 时走注入的兜底源', () => {
    const saved = withoutWebCrypto();
    try {
      let asked = -1;
      setRandomBytesFallback((n) => {
        asked = n;
        return new Uint8Array(n).fill(7);
      });
      const out = randomBytes(8);
      expect(asked).toBe(8);
      expect(Array.from(out)).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
    } finally {
      restoreWebCrypto(saved);
    }
  });

  it('无 WebCrypto 且未注入兜底源时显式报错（不静默降级）', () => {
    const saved = withoutWebCrypto();
    try {
      expect(() => randomBytes(4)).toThrow(/兜底随机源/);
    } finally {
      restoreWebCrypto(saved);
    }
  });
});
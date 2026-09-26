import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GCM_NONCE_BYTES, GCM_TAG_BYTES, open, seal, openWithNonce, sealWithNonce } from "./aead";
import { bytesToHex, hexToBytes, randomBytes } from "./hash";

const KEY = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");

describe("aead", () => {
  it("seal 产出 nonce(12) || ct || tag(16)，open 可还原", () => {
    const plain = new TextEncoder().encode("base L4a′ 封装格式");
    const blob = seal(KEY, plain);
    expect(blob.length).toBe(GCM_NONCE_BYTES + plain.length + GCM_TAG_BYTES);
    expect(new TextDecoder().decode(open(KEY, blob))).toBe("base L4a′ 封装格式");
  });

  it("固定 nonce 时输出可复现：同一 key/nonce/明文 → 同一密文", () => {
    const nonce = new Uint8Array(GCM_NONCE_BYTES); // 全 0
    const plain = new Uint8Array([1, 2, 3, 4]);
    const a = sealWithNonce(KEY, nonce, plain);
    const b = sealWithNonce(KEY, nonce, plain);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(plain.length + GCM_TAG_BYTES);
  });

  it("escrow 形态：nonce 独立成列，本体 = ct || tag", () => {
    const nonce = randomBytes(GCM_NONCE_BYTES);
    const plain = randomBytes(32);
    const ct = sealWithNonce(KEY, nonce, plain);
    expect(Array.from(openWithNonce(KEY, nonce, ct))).toEqual(Array.from(plain));
  });

  it("篡改密文 / 错 key 必须认证失败", () => {
    const blob = seal(KEY, new TextEncoder().encode("x"));
    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => open(KEY, tampered)).toThrow();
    expect(() => open(new Uint8Array(32), blob)).toThrow();
  });

  it("参数校验：key 必须 32 字节、nonce 必须 12 字节、密文不得过短", () => {
    expect(() => seal(new Uint8Array(16), new Uint8Array(1))).toThrow(/密钥/);
    expect(() => sealWithNonce(KEY, new Uint8Array(8), new Uint8Array(1))).toThrow(/nonce/);
    expect(() => open(KEY, new Uint8Array(GCM_NONCE_BYTES + GCM_TAG_BYTES - 1))).toThrow(/过短/);
  });

  // 黄金向量是 TS 与 Go 两侧的共同契约：只读、不重新生成（生成器已删除）。
  // 失败时改代码，不许改向量。
  it("消费 vectors/v1/aead.json：seal/open 与黄金向量逐字节一致", () => {
    const raw = readFileSync(new URL("../../../vectors/v1/aead.json", import.meta.url), "utf8");
    const v = JSON.parse(raw) as {
      key_hex: string;
      nonce_hex: string;
      plaintext_hex: string;
      ciphertext_hex: string;
    };
    const key = hexToBytes(v.key_hex);
    const nonce = hexToBytes(v.nonce_hex);
    const plain = hexToBytes(v.plaintext_hex);
    expect(bytesToHex(sealWithNonce(key, nonce, plain))).toBe(v.ciphertext_hex);
    expect(bytesToHex(openWithNonce(key, nonce, hexToBytes(v.ciphertext_hex)))).toBe(v.plaintext_hex);
    // 拼接形态也必须一致：nonce || ct || tag
    expect(bytesToHex(seal(key, plain, nonce))).toBe(v.nonce_hex + v.ciphertext_hex);
  });
});
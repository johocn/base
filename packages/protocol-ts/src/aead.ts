import { gcm } from "@noble/ciphers/aes";

import { randomBytes } from "@noble/hashes/utils";

/**
 * 与 Go 侧 `store.Encrypt` 的封装格式逐字节一致（册子 §7.1 / §9 交汇点 1）：
 * `nonce(12) || ciphertext || tag(16)`。
 *
 * 手机本地库列级加密与节点静态加密共用本文件——§9 交汇点 1 的「格式必须一致」靠这里落地，
 * 不靠两边各写一遍。改本文件 = 同时改节点与手机端，必须同步 Go 侧 crypto.go。
 */
export const GCM_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const AES_KEY_BYTES = 32;

function assertKey(key: Uint8Array): void {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`aead: 密钥必须 ${AES_KEY_BYTES} 字节，实得 ${key.length}`);
  }
}

function assertNonce(nonce: Uint8Array): void {
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new Error(`aead: nonce 必须 ${GCM_NONCE_BYTES} 字节，实得 ${nonce.length}`);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** 封装为 `nonce(12) || ciphertext || tag(16)`；不传 nonce 则随机生成。 */
export function seal(key: Uint8Array, plain: Uint8Array, nonce?: Uint8Array): Uint8Array {
  assertKey(key);
  const n = nonce ?? randomBytes(GCM_NONCE_BYTES);
  assertNonce(n);
  return concat(n, gcm(key, n).encrypt(plain));
}

/** 拆开 `nonce(12) || ciphertext || tag(16)`；认证失败即抛错，不做任何降级。 */
export function open(key: Uint8Array, blob: Uint8Array): Uint8Array {
  assertKey(key);
  if (blob.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error(`aead: 密文过短（${blob.length} 字节）`);
  }
  return gcm(key, blob.subarray(0, GCM_NONCE_BYTES)).decrypt(blob.subarray(GCM_NONCE_BYTES));
}

/** escrow 专用：源码约定 nonce 独立成列（册子 §4.1），故本体只有 `ciphertext || tag`。 */
export function sealWithNonce(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array {
  assertKey(key);
  assertNonce(nonce);
  return gcm(key, nonce).encrypt(plain);
}

export function openWithNonce(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array): Uint8Array {
  assertKey(key);
  assertNonce(nonce);
  return gcm(key, nonce).decrypt(ct);
}
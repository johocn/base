import { hexToBytes } from "@noble/hashes/utils";

import { sha256Hex } from "./hash";

/** 身份签名算法标识；一期只允许该值，其余一律拒绝。 */
export const ALG_ED25519 = "ed25519";

/**
 * 由公钥派生身份 id：sha256(公钥原始 32 字节) 的前 32 个十六进制字符。
 *
 * 这是不可变契约（与 Go 侧 protocol.IdentityID 必须逐字节一致）：
 * 节点不分配 id——任何人拿公钥都能算出同一个 id。
 */
export function deriveIdentityId(pubHex: string): string {
  const pub = hexToBytes(pubHex.trim().toLowerCase());
  if (pub.length !== 32) {
    throw new Error(`identity id: 期望 32 字节公钥，实得 ${pub.length}`);
  }
  return sha256Hex(pub).slice(0, 32);
}

/** 校验身份 id 是否为 32 字符小写十六进制。 */
export function isIdentityId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}

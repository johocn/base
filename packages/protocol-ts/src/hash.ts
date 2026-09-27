import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";

/**
 * 手写 UTF-8 编码。
 * 不用 noble 的 utf8ToBytes：它内部是 `new TextEncoder()`，而 App 端跑在系统 WebView 上，
 * 老内核没有 TextEncoder（真机实测同批缺失 URLSearchParams），同步时逐篇校验内容哈希会直接抛
 * 「TextEncoder is not defined」。孤立代理对按 U+FFFD 处理，与 TextEncoder / Go 的 `[]byte(s)` 一致。
 */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

/** 32 字节原始摘要。 */
export function sha256Sum(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/** 64 字符小写十六进制摘要。 */
export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

/** 内容寻址 id：sha256 十六进制前 32 字符（128 bit）。 */
export function blobId(data: Uint8Array): string {
  return sha256Hex(data).slice(0, 32);
}

export function isBlobId(id: string): boolean {
  return typeof id === "string" && /^[0-9a-f]{32}$/.test(id);
}

export { bytesToHex, hexToBytes, randomBytes };
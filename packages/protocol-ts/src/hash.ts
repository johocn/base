import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

export function utf8(s: string): Uint8Array {
  return utf8ToBytes(s);
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
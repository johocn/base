import { canonicalize, type Json } from "./canonical";
import { sign, verify } from "./ed25519";
import { sha256Hex, utf8 } from "./hash";

/** release 文档的签名载荷（spec §8.2）。 */
export interface ReleasePayload {
  schema_version: number;
  issuer: string;
  issued_at: string;
  version_name: string;
  min_version_name: string;
  apk_url: string;
  apk_size: number;
  apk_sha256: string;
  notes: string;
}

export interface ReleaseDoc {
  payload: ReleasePayload;
  signature: string;
}

/** 签名字节 = payload 的规范化 JSON（signature 不在域内，故无需删字段）。 */
export function releaseSignBytes(p: ReleasePayload): string {
  return canonicalize(p as unknown as Json);
}

export function signRelease(p: ReleasePayload, seedHex: string): ReleaseDoc {
  return { payload: p, signature: sign(seedHex, utf8(releaseSignBytes(p))) };
}

export function verifyRelease(doc: ReleaseDoc, pubHex: string): boolean {
  if (!doc || typeof doc !== "object" || !doc.payload) return false;
  if (doc.payload.schema_version !== 1) return false;
  try {
    return verify(pubHex, utf8(releaseSignBytes(doc.payload)), doc.signature);
  } catch {
    return false;
  }
}

/** 落盘字节的 sha256（与 Go 侧 MarshalCanonical 对齐）。 */
export function releaseDocSha256(doc: ReleaseDoc): string {
  return sha256Hex(utf8(canonicalize(doc as unknown as Json)));
}
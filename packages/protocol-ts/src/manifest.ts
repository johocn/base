import { canonicalize, type Json } from "./canonical";
import { sign, verify } from "./ed25519";
import { sha256Hex, utf8 } from "./hash";
import { merkleRoot } from "./merkle";

export interface Chunk {
  blob_id: string;
  size: number;
  seq: number;
}

export interface Entry {
  item_id: string;
  source: string;
  type: string;
  title: string;
  source_rev: string;
  content_hash: string;
  sqlite_table: string;
  chunks?: Chunk[];
  dist_class: string;
}

export interface Tombstone {
  item_id: string;
  revoked_rev: number;
}

export interface Manifest {
  pack_id: string;
  schema_version: number;
  issuer: string;
  issued_at: string;
  content_version: number;
  entries: Entry[];
  tombstone: Tombstone[];
  merkle_root: string;
  signature: string;
}

/** 契约第 4 条：merkle_root 的定义域。 */
export function manifestBlobIds(entries: readonly Entry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    for (const c of e.chunks ?? []) out.push(c.blob_id);
  }
  return out;
}

/** 契约第 5 条：pack_id 派生。 */
export function derivePackId(issuer: string, contentVersion: number, merkleRootHex: string): string {
  return sha256Hex(utf8(`pack:${issuer}:${contentVersion}:${merkleRootHex}`)).slice(0, 32);
}

/** 契约第 7 条：签名字节 = 去掉 signature 后的规范化 JSON。 */
export function signBytes(m: Manifest): string {
  const { signature: _ignored, ...rest } = m;
  return canonicalize(rest as unknown as Json);
}

export function signManifest(m: Manifest, seedHex: string): Manifest {
  return { ...m, signature: sign(seedHex, utf8(signBytes(m))) };
}

export function verifyManifest(m: Manifest, pubHex: string): boolean {
  if (m.schema_version !== 1) return false;
  if (m.pack_id !== derivePackId(m.issuer, m.content_version, m.merkle_root)) return false;
  if (merkleRoot(manifestBlobIds(m.entries)) !== m.merkle_root) return false;
  return verify(pubHex, utf8(signBytes(m)), m.signature);
}
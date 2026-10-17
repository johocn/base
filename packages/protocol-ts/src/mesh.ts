// mesh 一期签名对象：node-key-rotation 证书 / base-node-enroll 入网 / mesh-catalog 目录。
// canonical 字节与签名进 vectors/v1/mesh.json，Go oracle（tools/meshoracle）同消费。
import { canonicalize, type Json } from "./canonical";
import { sha256Hex, utf8 } from "./hash";
import { sign, verify } from "./ed25519";
import { isIdentityId } from "./identity";

export interface NodeKeyRotationDoc {
  type: "node-key-rotation";
  v: 1;
  node_id: string;
  old_pubkey: string;
  new_pubkey: string;
  effective_at: string;
  issued_at: string;
  signature: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/; // ed25519 签名 = 64 字节 = 128 hex
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/;

export function nodeKeyRotationSignBytes(doc: Omit<NodeKeyRotationDoc, "signature">): string {
  return canonicalize({
    type: doc.type,
    v: doc.v,
    node_id: doc.node_id,
    old_pubkey: doc.old_pubkey,
    new_pubkey: doc.new_pubkey,
    effective_at: doc.effective_at,
    issued_at: doc.issued_at,
  });
}

export function signNodeKeyRotation(doc: Omit<NodeKeyRotationDoc, "signature">, rootSeedHex: string): NodeKeyRotationDoc {
  return { ...doc, signature: sign(rootSeedHex, utf8(nodeKeyRotationSignBytes(doc))) };
}

/** cert_id = hex(sha256(canonical 字节))[0:32]（spec §1.2 写死）。 */
export function nodeKeyRotationCertId(doc: Omit<NodeKeyRotationDoc, "signature">): string {
  return sha256Hex(utf8(nodeKeyRotationSignBytes(doc))).slice(0, 32);
}

/**
 * 单级规则（spec §1.2）：cert 必须由根密钥亲签（sig 对 root_pubkey 验证）；
 * old_pubkey ∈ {root_pubkey, 当前生效工作密钥公钥}；字段形态全检。
 */
export function verifyNodeKeyRotation(
  doc: NodeKeyRotationDoc,
  rootPubHex: string,
  currentWorkingPubHex: string,
): boolean {
  if (doc.type !== "node-key-rotation" || doc.v !== 1) return false;
  if (!isIdentityId(doc.node_id)) return false;
  if (!HEX64.test(doc.old_pubkey) || !HEX64.test(doc.new_pubkey)) return false;
  if (!ISO_RE.test(doc.effective_at) || !ISO_RE.test(doc.issued_at)) return false;
  if (doc.old_pubkey !== rootPubHex && doc.old_pubkey !== currentWorkingPubHex) return false;
  if (!HEX128.test(doc.signature)) return false;
  return verify(rootPubHex, utf8(nodeKeyRotationSignBytes(doc)), doc.signature);
}

export interface NodeEnrollDoc {
  v: 1;
  kind: "base-node-enroll";
  node_id: string;
  url: string;
  sign_pubkey: string;
  tls_fingerprint: string;
  expires_at: string;
  /** 分享会话期 token（spec §3.3：同一次扫码完成 TOFU + 入网）；纯入网码可缺省。 */
  token?: string;
}

/** enroll 二维码（一期为配对码文本）：canonical JSON，缺一不收；token 可选。 */
export function parseNodeEnroll(raw: string): NodeEnrollDoc | null {
  let p: unknown;
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (p === null || typeof p !== "object" || Array.isArray(p)) return null;
  const m = p as Record<string, unknown>;
  if (m.v !== 1 || m.kind !== "base-node-enroll") return null;
  if (typeof m.node_id !== "string" || !isIdentityId(m.node_id)) return null;
  if (typeof m.url !== "string" || !/^https:\/\/.+/.test(m.url)) return null;
  if (typeof m.sign_pubkey !== "string" || !HEX64.test(m.sign_pubkey)) return null;
  if (typeof m.tls_fingerprint !== "string" || !HEX64.test(m.tls_fingerprint)) return null;
  if (typeof m.expires_at !== "string" || !ISO_RE.test(m.expires_at)) return null;
  const doc: NodeEnrollDoc = {
    v: 1,
    kind: "base-node-enroll",
    node_id: m.node_id,
    url: m.url,
    sign_pubkey: m.sign_pubkey,
    tls_fingerprint: m.tls_fingerprint,
    expires_at: m.expires_at,
  };
  if (m.token !== undefined) {
    if (typeof m.token !== "string" || !/^[0-9a-f]{64}$/.test(m.token)) return null;
    doc.token = m.token;
  }
  return doc;
}

export interface MeshCatalogEntry {
  item_id: string;
  rev: number;
  content_hash: string;
  size: number;
}

export interface MeshCatalogDoc {
  type: "mesh-catalog";
  v: 1;
  node_id: string;
  catalog_version: number;
  entries: MeshCatalogEntry[];
  signed_at: string;
  signature: string;
}

export function meshCatalogSignBytes(doc: Omit<MeshCatalogDoc, "signature">): string {
  return canonicalize({
    type: doc.type,
    v: doc.v,
    node_id: doc.node_id,
    catalog_version: doc.catalog_version,
    entries: doc.entries.map((e) => ({
      item_id: e.item_id,
      rev: e.rev,
      content_hash: e.content_hash,
      size: e.size,
    })),
    signed_at: doc.signed_at,
  } satisfies Json as Json);
}

export function signMeshCatalog(doc: Omit<MeshCatalogDoc, "signature">, seedHex: string): MeshCatalogDoc {
  return { ...doc, signature: sign(seedHex, utf8(meshCatalogSignBytes(doc))) };
}

/** 验签集合 = {root_pubkey, 当前生效 cert 的 new_pubkey, TOFU 锚点 sign_pubkey}，调用方逐个试。 */
export function verifyMeshCatalog(doc: MeshCatalogDoc, pubHex: string): boolean {
  if (doc.type !== "mesh-catalog" || doc.v !== 1) return false;
  if (!isIdentityId(doc.node_id)) return false;
  if (!Number.isInteger(doc.catalog_version) || doc.catalog_version < 0) return false;
  if (!Array.isArray(doc.entries)) return false;
  for (const e of doc.entries) {
    if (typeof e.item_id !== "string" || e.item_id === "") return false;
    if (!Number.isInteger(e.rev) || e.rev < 0) return false;
    if (!HEX64.test(e.content_hash)) return false;
    if (!Number.isInteger(e.size) || e.size < 0) return false;
  }
  if (!ISO_RE.test(doc.signed_at)) return false;
  if (!HEX128.test(doc.signature)) return false;
  return verify(pubHex, utf8(meshCatalogSignBytes(doc)), doc.signature);
}

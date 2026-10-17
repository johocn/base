import { describe, expect, it } from "vitest";
import { keyPairFromSeed } from "./ed25519";
import { deriveIdentityId } from "./identity";
import {
  nodeKeyRotationCertId,
  parseNodeEnroll,
  signMeshCatalog,
  signNodeKeyRotation,
  verifyMeshCatalog,
  verifyNodeKeyRotation,
  type MeshCatalogDoc,
} from "./mesh";

const ROOT_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const WORK_SEED = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
// node_id 由公钥派生（plan Task 5 定案：node_id = deriveIdentityId(sign_pubkey)，hex32 形态）
const NODE_ID = deriveIdentityId(keyPairFromSeed(WORK_SEED).pubHex);

describe("node-key-rotation", () => {
  const doc = signNodeKeyRotation({
    type: "node-key-rotation",
    v: 1,
    node_id: NODE_ID,
    old_pubkey: keyPairFromSeed(ROOT_SEED).pubHex,
    new_pubkey: keyPairFromSeed(WORK_SEED).pubHex,
    effective_at: "2026-10-17T00:00:00Z",
    issued_at: "2026-10-17T00:00:00Z",
  }, ROOT_SEED);
  it("根密钥亲签通过 + cert_id 32 hex", () => {
    expect(verifyNodeKeyRotation(doc, keyPairFromSeed(ROOT_SEED).pubHex, keyPairFromSeed(WORK_SEED).pubHex)).toBe(true);
    expect(nodeKeyRotationCertId(doc)).toMatch(/^[0-9a-f]{32}$/);
  });
  it("工作密钥签发（单级约束）必须失败", () => {
    const bad = signNodeKeyRotation({ ...doc, signature: "" } as never, WORK_SEED);
    expect(verifyNodeKeyRotation(bad, keyPairFromSeed(ROOT_SEED).pubHex, keyPairFromSeed(WORK_SEED).pubHex)).toBe(false);
  });
  it("篡改 new_pubkey 拒绝", () => {
    const bad = { ...doc, new_pubkey: "0" + doc.new_pubkey.slice(1) };
    expect(verifyNodeKeyRotation(bad as never, keyPairFromSeed(ROOT_SEED).pubHex, keyPairFromSeed(WORK_SEED).pubHex)).toBe(false);
  });
});

describe("base-node-enroll", () => {
  const ok = {
    v: 1,
    kind: "base-node-enroll",
    node_id: NODE_ID,
    url: "https://node.example.com",
    sign_pubkey: keyPairFromSeed(WORK_SEED).pubHex,
    tls_fingerprint: "aa".repeat(32),
    expires_at: "2026-12-31T00:00:00Z",
    token: "bb".repeat(32),
  };
  it("合法 + 带 token 通过", () => {
    expect(parseNodeEnroll(JSON.stringify(ok))?.node_id).toBe(NODE_ID);
  });
  it("缺 tls_fingerprint 拒收（双锚缺一不收）", () => {
    const { tls_fingerprint: _drop, ...rest } = ok;
    expect(parseNodeEnroll(JSON.stringify(rest))).toBeNull();
  });
  it("坏 token 形态拒收", () => {
    expect(parseNodeEnroll(JSON.stringify({ ...ok, token: "zz" }))).toBeNull();
  });
});

describe("mesh-catalog", () => {
  const base = {
    type: "mesh-catalog" as const,
    v: 1 as const,
    node_id: NODE_ID,
    catalog_version: 7,
    entries: [
      { item_id: "article/hello", rev: 3, content_hash: "cc".repeat(32), size: 1234 },
      { item_id: "course/c1", rev: 1, content_hash: "dd".repeat(32), size: 0 },
    ],
    signed_at: "2026-10-17T00:00:00Z",
  };
  it("签名/验签往返", () => {
    const doc = signMeshCatalog(base, WORK_SEED);
    expect(verifyMeshCatalog(doc, keyPairFromSeed(WORK_SEED).pubHex)).toBe(true);
  });
  it("换锚公钥拒绝（TOFU 不匹配）", () => {
    const doc: MeshCatalogDoc = signMeshCatalog(base, ROOT_SEED);
    expect(verifyMeshCatalog(doc, keyPairFromSeed(WORK_SEED).pubHex)).toBe(false);
  });
  it("非整数 rev 拒绝", () => {
    const good = signMeshCatalog(base, WORK_SEED);
    // 非整数 rev 过不了 canonicalize，直接篡改已签文档走 verify 形态门
    const doc: MeshCatalogDoc = { ...good, entries: [{ ...good.entries[0]!, rev: 1.5 }] };
    expect(verifyMeshCatalog(doc, keyPairFromSeed(WORK_SEED).pubHex)).toBe(false);
  });
});

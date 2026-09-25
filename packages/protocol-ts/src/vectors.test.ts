import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";

import {
  ALG_ED25519,
  blobId,
  canonicalize,
  deriveIdentityId,
  derivePackId,
  emptyBodySha256,
  isIdentityId,
  keyPairFromSeed,
  manifestBlobIds,
  merkleRoot,
  requestSignBytes,
  sha256Hex,
  sign,
  signBytes,
  utf8,
  verify,
  verifyManifest,
  type Manifest,
} from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const vdir = join(here, "..", "..", "..", "vectors", "v1");
const load = (name: string): any => JSON.parse(readFileSync(join(vdir, name), "utf8"));

describe("canonical.json", () => {
  const f = load("canonical.json");
  it("version 与用例数", () => {
    expect(f.version).toBe(1);
    expect(f.cases.length).toBeGreaterThanOrEqual(10);
  });
  for (const c of load("canonical.json").cases) {
    it(c.name, () => {
      expect(canonicalize(c.input)).toBe(c.expected);
    });
  }
  it("拒绝非整数与非整数形态", () => {
    expect(() => canonicalize(1.5)).toThrow(/only integers/);
    expect(() => canonicalize(1e21)).toThrow(/only integers/);
    expect(() => canonicalize({ n: -0 })).not.toThrow();
    expect(canonicalize({ n: -0 })).toBe('{"n":0}');
  });
  it("拒绝非 ASCII 键", () => {
    expect(() => canonicalize({ 中文: 1 } as any)).toThrow(/non-ascii/);
  });
});

describe("hash.json", () => {
  for (const c of load("hash.json").cases) {
    it(c.name, () => {
      expect(c.sha256).not.toContain("__");
      expect(sha256Hex(utf8(c.input_utf8))).toBe(c.sha256);
      expect(blobId(utf8(c.input_utf8))).toBe(c.blob_id);
    });
  }
});

describe("merkle.json", () => {
  for (const c of load("merkle.json").cases) {
    it(c.name, () => {
      expect(merkleRoot(c.blob_ids)).toBe(c.merkle_root);
    });
  }
  it("顺序无关 + 去重等价", () => {
    const ids = load("merkle.json").cases[3].blob_ids as string[];
    const base = merkleRoot(ids);
    expect(merkleRoot([...ids].reverse())).toBe(base);
    expect(merkleRoot([...ids, ...ids])).toBe(base);
  });
  it("非法 id 报错", () => {
    expect(() => merkleRoot(["XX"])).toThrow(/invalid blob id/);
  });
});

describe("ed25519.json", () => {
  for (const c of load("ed25519.json").cases) {
    it(c.name, () => {
      expect(keyPairFromSeed(c.seed_hex).pubHex).toBe(c.pub_hex);
      expect(sign(c.seed_hex, utf8(c.message_utf8))).toBe(c.signature_hex);
      expect(verify(c.pub_hex, utf8(c.message_utf8), c.signature_hex)).toBe(true);
    });
  }
  it("篡改消息/签名/换公钥均拒绝", () => {
    const c = load("ed25519.json").cases[0];
    expect(verify(c.pub_hex, utf8("x"), c.signature_hex)).toBe(false);
    expect(verify(c.pub_hex, utf8(c.message_utf8), "0" + c.signature_hex.slice(1))).toBe(false);
    expect(verify(keyPairFromSeed("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7").pubHex, utf8(c.message_utf8), c.signature_hex)).toBe(false);
  });
});

describe("manifest.json", () => {
  const f = load("manifest.json");
  it("向量公钥与种子一致", () => {
    expect(f.version).toBe(1);
    expect(keyPairFromSeed(f.key.seed_hex).pubHex).toBe(f.key.pub_hex);
  });
  for (const c of f.cases) {
    it(c.name, () => {
      const m = c.manifest as Manifest;
      expect(verifyManifest(m, f.key.pub_hex)).toBe(true);
      expect(m.pack_id).toBe(c.pack_id);
      expect(m.content_version).toBe(c.content_version);
      expect(m.merkle_root).toBe(c.merkle_root);
      expect(m.entries.length).toBe(c.entries);
      expect(derivePackId(m.issuer, m.content_version, m.merkle_root)).toBe(c.pack_id);
      expect(merkleRoot(manifestBlobIds(m.entries))).toBe(c.merkle_root);
      expect(signBytes(m)).toBe(c.sign_bytes);
      expect(sha256Hex(utf8(canonicalize(m as any)))).toBe(c.manifest_sha256);
      expect(m.tombstone.length).toBeGreaterThan(0);
      expect(m.entries.every((e) => e.dist_class === "public")).toBe(true);
    });
  }
  it("篡改标题后拒收", () => {
    const c = load("manifest.json").cases[0];
    const bad = JSON.parse(JSON.stringify(c.manifest)) as Manifest;
    bad.entries[0].title = "被改";
    expect(verifyManifest(bad, load("manifest.json").key.pub_hex)).toBe(false);
  });
});

describe("identity.json", () => {
  const f = load("identity.json");
  it("version 与用例数", () => {
    expect(f.version).toBe(1);
    expect(f.cases.length).toBeGreaterThanOrEqual(2);
  });
  for (const c of f.cases) {
    it(c.name, () => {
      expect(keyPairFromSeed(c.seed_hex).pubHex).toBe(c.pub_hex);
      expect(c.alg).toBe(ALG_ED25519);
      expect(deriveIdentityId(c.pub_hex)).toBe(c.id);
      expect(isIdentityId(c.id)).toBe(true);
    });
  }
  it("大小写归一 + 拒绝非法长度", () => {
    const c = f.cases[0];
    expect(deriveIdentityId(c.pub_hex.toUpperCase())).toBe(c.id);
    expect(() => deriveIdentityId("9d61b19d")).toThrow(/32 字节公钥/);
    expect(isIdentityId(c.id + "0")).toBe(false);
    expect(isIdentityId(c.id.toUpperCase())).toBe(false);
  });
});

describe("reqsig.json", () => {
  const f = load("reqsig.json");
  it("version、用例数与密钥", () => {
    expect(f.version).toBe(1);
    expect(f.cases.length).toBeGreaterThanOrEqual(2);
    expect(keyPairFromSeed(f.seed_hex).pubHex).toBe(f.pub_hex);
  });
  for (const c of f.cases) {
    it(c.name, () => {
      const bytes = requestSignBytes({
        method: c.method,
        path: c.path,
        query: c.query,
        bodySha256: c.body_sha256,
        ts: c.ts,
        nonce: c.nonce,
      });
      expect(bytesToHex(bytes)).toBe(bytesToHex(utf8(c.sign_bytes)));
      expect(verify(f.pub_hex, bytes, c.signature_hex)).toBe(true);
    });
  }
  it("无请求体的固定 body_sha256", () => {
    expect(emptyBodySha256()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("篡改任一字段后签名不再成立", () => {
    const c = f.cases[0];
    const bytes = requestSignBytes({
      method: c.method,
      path: c.path,
      query: c.query,
      bodySha256: c.body_sha256,
      ts: c.ts,
      nonce: "ffffffffffffffffffffffffffffffff",
    });
    expect(verify(f.pub_hex, bytes, c.signature_hex)).toBe(false);
  });
});

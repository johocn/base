import { describe, expect, it } from "vitest";

import { deriveIdentityId, sha256Hex, utf8, verify, requestSignBytes, type KdfParams, type RequestMeta } from "@base/protocol-ts";

import { MemoryStorage } from "./fakes";
import {
  buildEscrowPayload,
  createIdentity,
  deviceKek,
  identityFromSeed,
  loadLocalIdentity,
  openEscrowPayload,
  exportIdentityBackup,
  importIdentityBackup,
  saveLocalIdentity,
  signRequestHeaders,
} from "./identity";

// 测试用低成本参数：参数随密文走，故测试可自由选值而不影响生产默认（DEFAULT_KDF）。
const FAST_KDF: KdfParams = { alg: "argon2id", m: 8, t: 1, p: 1, len: 32 };

describe("identity", () => {
  it("id 由公钥派生且自证：同一 seed 恒得同一 id", () => {
    const a = createIdentity();
    expect(a.alg).toBe("ed25519");
    expect(a.pubHex).toHaveLength(64);
    expect(a.id).toHaveLength(32);
    expect(a.id).toBe(deriveIdentityId(a.pubHex));
    expect(identityFromSeed(a.seedHex).id).toBe(a.id);
  });

  it("两次生成的身份互不相同", () => {
    expect(createIdentity().id).not.toBe(createIdentity().id);
  });

  it("deviceKek 幂等：同一存储返回同一 KEK，且为 32 字节", async () => {
    const st = new MemoryStorage();
    const k1 = await deviceKek(st);
    const k2 = await deviceKek(st);
    expect(k1.length).toBe(32);
    expect(Array.from(k1)).toEqual(Array.from(k2));
  });

  it("本机密文往返：解锁得到同一身份", async () => {
    const st = new MemoryStorage();
    const kek = await deviceKek(st);
    const ident = createIdentity();
    await saveLocalIdentity(st, ident, kek, "device", "alice");
    const back = await loadLocalIdentity(st, kek);
    expect(back?.id).toBe(ident.id);
    expect(back?.seedHex).toBe(ident.seedHex);
  });

  it("私钥不明文落盘：存储里搜不到 seedHex", async () => {
    const st = new MemoryStorage();
    const kek = await deviceKek(st);
    const ident = createIdentity();
    await saveLocalIdentity(st, ident, kek, "device");
    for (const v of st.map.values()) {
      expect(v.includes(ident.seedHex)).toBe(false);
    }
  });

  it("错误 KEK 解不开本机密文", async () => {
    const st = new MemoryStorage();
    const ident = createIdentity();
    await saveLocalIdentity(st, ident, await deviceKek(st), "device");
    await expect(loadLocalIdentity(st, new Uint8Array(32))).rejects.toThrow();
  });

  it("无本地记录时返回 null（不抛错）", async () => {
    await expect(loadLocalIdentity(new MemoryStorage(), new Uint8Array(32))).resolves.toBeNull();
  });

  it("托管闭环：设密码上传 → 用同一密码取回 → 同一 id", () => {
    const ident = createIdentity();
    const payload = buildEscrowPayload(ident, "正确的马匹电池订书钉", FAST_KDF);
    expect(payload.id).toBe(ident.id);
    expect(payload.alg).toBe("ed25519");
    expect(payload.salt).toHaveLength(32); // 16 字节 → 32 hex
    expect(payload.encNonce).toHaveLength(24); // 12 字节 → 24 hex
    expect(payload.privCipher.length).toBeGreaterThan(64);
    expect(payload.kdf).toEqual(FAST_KDF);

    const back = openEscrowPayload(payload, "正确的马匹电池订书钉");
    expect(back.id).toBe(ident.id);
    expect(back.seedHex).toBe(ident.seedHex);
  });

  it("托管：错误密码解不开（客户端判定）", () => {
    const payload = buildEscrowPayload(createIdentity(), "right", FAST_KDF);
    expect(() => openEscrowPayload(payload, "wrong")).toThrow(/密码错误/);
  });

  it("托管：篡改 priv_cipher 即认证失败", () => {
    const payload = buildEscrowPayload(createIdentity(), "right", FAST_KDF);
    const flipped = (payload.privCipher[0] === "0" ? "1" : "0") + payload.privCipher.slice(1);
    expect(() => openEscrowPayload({ ...payload, privCipher: flipped }, "right")).toThrow(/密码错误/);
  });

  it("托管：篡改 id 会被识破（解出的私钥与 id 不符）", () => {
    const payload = buildEscrowPayload(createIdentity(), "right", FAST_KDF);
    const other = createIdentity();
    expect(() => openEscrowPayload({ ...payload, id: other.id }, "right")).toThrow(/不符/);
  });

  it("签名头：5 个头齐全，且能被公钥验过", () => {
    const ident = createIdentity();
    const body = utf8('{"type":"ping"}');
    const ts = 1_700_000_000_000;
    const h = signRequestHeaders(ident, { method: "post", path: "/v1/event", body }, ts);

    expect(Object.keys(h).sort()).toEqual([
      "X-Base-Alg",
      "X-Base-Id",
      "X-Base-Nonce",
      "X-Base-Sig",
      "X-Base-Ts",
    ]);
    expect(h["X-Base-Id"]).toBe(ident.id);
    expect(h["X-Base-Alg"]).toBe("ed25519");
    expect(h["X-Base-Ts"]).toBe(String(ts));
    // 契约 3.2：X-Base-Nonce 必须是 16 字节 hex（服务端 auth_nonces 也按 32 hex 存），
    // 不是 escrow 那种 12 字节 GCM nonce。
    expect(h["X-Base-Nonce"]).toHaveLength(32);

    const meta: RequestMeta = {
      method: "POST",
      path: "/v1/event",
      query: "",
      bodySha256: sha256Hex(body),
      ts,
      nonce: h["X-Base-Nonce"],
    };
    expect(verify(ident.pubHex, requestSignBytes(meta), h["X-Base-Sig"])).toBe(true);
  });

  it("签名头：无请求体时 body_sha256 用空体固定值", () => {
    const ident = createIdentity();
    const ts = 1_700_000_000_100;
    const h = signRequestHeaders(ident, { method: "GET", path: "/v1/me" }, ts);
    const meta: RequestMeta = {
      method: "GET",
      path: "/v1/me",
      query: "",
      bodySha256: sha256Hex(new Uint8Array(0)),
      ts,
      nonce: h["X-Base-Nonce"],
    };
    expect(verify(ident.pubHex, requestSignBytes(meta), h["X-Base-Sig"])).toBe(true);
  });

  it("签名头：每次 nonce 不同（防重放前提）", () => {
    const ident = createIdentity();
    const a = signRequestHeaders(ident, { method: "GET", path: "/v1/me" }, 1000);
    const b = signRequestHeaders(ident, { method: "GET", path: "/v1/me" }, 1000);
    expect(a["X-Base-Nonce"]).not.toBe(b["X-Base-Nonce"]);
  });

  it("私钥可主动备份并完整还原（册子 §2.2）", () => {
    const ident = createIdentity();
    const backup = exportIdentityBackup(ident);
    expect(backup).toBe(ident.seedHex);
    expect(identityFromSeed(backup).id).toBe(ident.id);
    // 手抄/扫码会有首尾空白与大小写噪声
    expect(importIdentityBackup("  " + backup.toUpperCase() + "\n").id).toBe(ident.id);
    expect(() => importIdentityBackup("not-a-seed")).toThrow(/64 位 hex/);
  });
});
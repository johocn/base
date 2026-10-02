// peer.ts 的单测：ParseIssuerPubKeys 的正常/空串/非法/非小写 hex/空 issuer，以及 doRequest 的请求头。
import { describe, expect, it } from "vitest";
import {
  doRequest,
  fetchMaxBlobs,
  parseIssuerPubKeys,
  type Config,
  type PeerRequest,
} from "./peer";

const HEX64 = "ab12cd34".repeat(8); // 64 字符小写 hex

describe("parseIssuerPubKeys", () => {
  it("正常：issuer → 公钥；重复 issuer 后者覆盖", () => {
    const raw = JSON.stringify([
      { issuer: "issuer-a", public_key_hex: HEX64 },
      { issuer: " issuer-b ", public_key_hex: HEX64.toUpperCase() },
    ]);
    const out = parseIssuerPubKeys(raw);
    expect(out).toEqual({ "issuer-a": HEX64, "issuer-b": HEX64 });
  });

  it("空串 / 纯空白 → 空表", () => {
    expect(parseIssuerPubKeys("")).toEqual({});
    expect(parseIssuerPubKeys("   \n\t ")).toEqual({});
  });

  it("非法 JSON → 报错", () => {
    expect(() => parseIssuerPubKeys("{not json")).toThrow(/BASE_ISSUER_PUBKEYS 不是合法 JSON 数组/);
  });

  it("非数组 JSON → 报错", () => {
    expect(() => parseIssuerPubKeys('{"issuer":"a"}')).toThrow(/BASE_ISSUER_PUBKEYS 不是合法 JSON 数组/);
  });

  it("非小写 hex（含 g/Z）→ 报错", () => {
    expect(() =>
      parseIssuerPubKeys(JSON.stringify([{ issuer: "a", public_key_hex: "Z".repeat(64) }])),
    ).toThrow(/public_key_hex 必须是 64 位小写 hex/);
  });

  it("长度不为 64 → 报错", () => {
    expect(() =>
      parseIssuerPubKeys(JSON.stringify([{ issuer: "a", public_key_hex: "ab".repeat(31) }])),
    ).toThrow(/public_key_hex 必须是 64 位小写 hex/);
  });

  it("空 issuer → 报错", () => {
    expect(() =>
      parseIssuerPubKeys(JSON.stringify([{ issuer: "  ", public_key_hex: HEX64 }])),
    ).toThrow(/\[0\]: issuer 不能为空/);
  });
});

describe("fetchMaxBlobs", () => {
  it("<=0 取默认 64；>0 原样", () => {
    expect(fetchMaxBlobs({})).toBe(64);
    expect(fetchMaxBlobs({ fetchMaxBlobs: 0 })).toBe(64);
    expect(fetchMaxBlobs({ fetchMaxBlobs: -3 })).toBe(64);
    expect(fetchMaxBlobs({ fetchMaxBlobs: 7 })).toBe(7);
  });
});

describe("doRequest", () => {
  it("有 body 时带 Content-Type；NodeKey 非空带 X-Base-Node-Key", async () => {
    let seen: PeerRequest | null = null;
    const c: Config = {
      nodeKey: "k-1",
      transportFor: () => async (req) => {
        seen = req;
        return { status: 200, headers: {}, body: new Uint8Array() };
      },
    };
    await doRequest(c, undefined, c.transportFor!({ url: "https://p", tlsFingerprint: "" }), "POST", "https://p/x", new Uint8Array([1]));
    const req = seen as PeerRequest | null;
    expect(req).not.toBeNull();
    expect(req!.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(req!.headers["X-Base-Node-Key"]).toBe("k-1");
    expect(req!.signal).toBeDefined();
  });

  it("无 body 不带 Content-Type；NodeKey 为空不带该头", async () => {
    let seen: PeerRequest | null = null;
    const c: Config = {
      transportFor: () => async (req) => {
        seen = req;
        return { status: 200, headers: {}, body: new Uint8Array() };
      },
    };
    await doRequest(c, undefined, c.transportFor!({ url: "https://p", tlsFingerprint: "" }), "GET", "https://p/x", null);
    const req = seen as PeerRequest | null;
    expect(req!.headers["Content-Type"]).toBeUndefined();
    expect(req!.headers["X-Base-Node-Key"]).toBeUndefined();
  });
});
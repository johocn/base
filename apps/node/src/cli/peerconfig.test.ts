// cli/peerconfig.ts 的单测：Go duration 解析（合法/非法逐字错误）、对端清单解析、
// 证书路径决策（off/大小写/空白/默认落回）、flag 默认值来自 env。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  certPaths,
  defaultCertPaths,
  parseGoDuration,
  peerFlagSpecs,
  peersFromRaw,
  type PeerFlags,
} from "./peerconfig";

const BASE: PeerFlags = {
  data: "/d",
  storeKey: "",
  peers: "",
  issuerPubkeys: "",
  tlsCert: "",
  tlsKey: "",
  nodeKey: "",
  fetchMaxBlobs: "64",
  syncInterval: "5m",
  scrubInterval: "24h",
};

function flags(over: Partial<PeerFlags>): PeerFlags {
  return { ...BASE, ...over };
}

describe("parseGoDuration（time.ParseDuration 等价）", () => {
  it("合法：多段 / 小数 / 负号 / 毫秒 / 零", () => {
    expect(parseGoDuration("5m")).toBe(300_000);
    expect(parseGoDuration("24h")).toBe(86_400_000);
    expect(parseGoDuration("1h30m")).toBe(5_400_000);
    expect(parseGoDuration("1.5s")).toBe(1500);
    expect(parseGoDuration("-3s")).toBe(-3000);
    expect(parseGoDuration("500ms")).toBe(500);
    expect(parseGoDuration("0")).toBe(0);
  });

  it("非法：错误消息文本逐字", () => {
    expect(() => parseGoDuration("5x")).toThrowError('time: unknown unit "x" in duration "5x"');
    expect(() => parseGoDuration("5")).toThrowError('time: missing unit in duration "5"');
    expect(() => parseGoDuration("")).toThrowError('time: invalid duration ""');
    expect(() => parseGoDuration("abc")).toThrowError('time: invalid duration "abc"');
  });
});

describe("peersFromRaw（parsePeers + peers()）", () => {
  it("空白 → []", () => {
    expect(peersFromRaw("")).toEqual([]);
    expect(peersFromRaw("   ")).toEqual([]);
  });

  it("[] → []", () => {
    expect(peersFromRaw("[]")).toEqual([]);
  });

  it("单元素 → Peer{url,tlsFingerprint}", () => {
    expect(peersFromRaw('[{"url":"https://p","tls_fingerprint":"ab"}]')).toEqual([
      { url: "https://p", tlsFingerprint: "ab" },
    ]);
  });

  it("非法 JSON / 非数组 → 前缀 + 细节", () => {
    expect(() => peersFromRaw("{")).toThrowError(/^BASE_PEERS 不是合法 JSON 数组/);
    expect(() => peersFromRaw("{}")).toThrowError(/^BASE_PEERS 不是合法 JSON 数组/);
    expect(() => peersFromRaw("[1]")).toThrowError(/^BASE_PEERS 不是合法 JSON 数组/);
  });
});

describe("certPaths（peerconfig.go:68-81）", () => {
  it("off（忽略大小写、去空白）→ 两空串", () => {
    expect(certPaths(flags({ tlsCert: "off" }))).toEqual(["", ""]);
    expect(certPaths(flags({ tlsCert: "OFF" }))).toEqual(["", ""]);
    expect(certPaths(flags({ tlsCert: "  off " }))).toEqual(["", ""]);
  });

  it("缺省落回 <data>/tls/node.crt|key", () => {
    expect(certPaths(flags({}))).toEqual(defaultCertPaths("/d"));
  });

  it("显式路径去空白采用；仅给 cert 时 key 落回默认", () => {
    expect(certPaths(flags({ tlsCert: " /x/c ", tlsKey: " /x/k " }))).toEqual(["/x/c", "/x/k"]);
    const [, defKey] = defaultCertPaths("/d");
    expect(certPaths(flags({ tlsCert: "/x/c" }))).toEqual(["/x/c", defKey]);
  });
});

describe("peerFlagSpecs：默认值来自 env", () => {
  const KEYS = [
    "BASE_DATA",
    "BASE_STORE_KEY",
    "BASE_PEERS",
    "BASE_ISSUER_PUBKEYS",
    "BASE_TLS_CERT",
    "BASE_TLS_KEY",
    "BASE_NODE_KEY",
    "BASE_FETCH_MAX_BLOBS",
    "BASE_SYNC_INTERVAL",
    "BASE_SCRUB_INTERVAL",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function defOf(name: string): string {
    return peerFlagSpecs().find((s) => s.name === name)?.def ?? "";
  }

  it("env 存在则采用（fetch-max-blobs 走 TrimSpace+Atoi，非法回默认）", () => {
    process.env.BASE_DATA = "/envdata";
    process.env.BASE_PEERS = "[]";
    process.env.BASE_FETCH_MAX_BLOBS = " 7 ";
    process.env.BASE_SYNC_INTERVAL = "2m";
    process.env.BASE_SCRUB_INTERVAL = "1h";
    process.env.BASE_FETCH_MAX_BLOBS_BAD = "x";
    expect(defOf("data")).toBe("/envdata");
    expect(defOf("peers")).toBe("[]");
    expect(defOf("fetch-max-blobs")).toBe("7");
    expect(defOf("sync-interval")).toBe("2m");
    expect(defOf("scrub-interval")).toBe("1h");
  });

  it("env 缺失 → Go 默认值", () => {
    expect(defOf("data")).toBe("data");
    expect(defOf("tls-cert")).toBe("");
    expect(defOf("tls-key")).toBe("");
    expect(defOf("fetch-max-blobs")).toBe("64");
    expect(defOf("sync-interval")).toBe("5m");
    expect(defOf("scrub-interval")).toBe("24h");
  });

  it("env 存在但空格/非法：envOr 不 trim 原样保留；envIntOr 非法回默认", () => {
    process.env.BASE_DATA = "  ";
    process.env.BASE_FETCH_MAX_BLOBS = "not-a-number";
    expect(defOf("data")).toBe("  "); // Go os.Getenv 原样
    expect(defOf("fetch-max-blobs")).toBe("64");
  });
});
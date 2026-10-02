// 逐行移植 cmd/based/peerconfig.go：peer-sync / scrub / serve 共用的 flag 集合、
// 对端清单解析、证书路径决策、出站 Config 组装、Go duration 解析与日志。
//
// 与 Go 的**有意差异**（记录于文件头）：
//   1. openStore：Go 的 `store.Open` 在 Node 侧被拆成 host 库（store/store.ts）与出站端口
//      （store/syncstore.ts）。peersync 的 RunOnce / ScrubOnce 需要 SyncStore（content_version /
//      listAllBlobIDs / putBlob / verifyBlobs 等），故此处用 openSyncStore 而非 openStore。
//   2. parseGoDuration 返回**毫秒**（number）而非 Go 的纳秒 Duration；本工程只用于调度间隔。
import { join } from "node:path";
import type { FlagSpec } from "./flags";
import type { TlsAdapter, TlsInfo } from "@base/core-ts";
import { parseIssuerPubKeys, type Config, type Peer } from "../peersync/peer";
import { openSyncStore, type SyncStore } from "../store/syncstore";

/** 10 个 flag 的原始字符串值（对齐 Go peerFlags 的 *string / *int）。 */
export interface PeerFlags {
  data: string;
  storeKey: string;
  peers: string;
  issuerPubkeys: string;
  tlsCert: string;
  tlsKey: string;
  nodeKey: string;
  fetchMaxBlobs: string;
  syncInterval: string;
  scrubInterval: string;
}

/** registerPeerFlags（peerconfig.go:33-46）：默认值来自同名 env。 */
export function peerFlagSpecs(): FlagSpec[] {
  return [
    { name: "data", def: envOr("BASE_DATA", "data") },
    { name: "store-key", def: process.env.BASE_STORE_KEY ?? "" },
    { name: "peers", def: process.env.BASE_PEERS ?? "" },
    { name: "issuer-pubkeys", def: process.env.BASE_ISSUER_PUBKEYS ?? "" },
    { name: "tls-cert", def: envOr("BASE_TLS_CERT", "") },
    { name: "tls-key", def: envOr("BASE_TLS_KEY", "") },
    { name: "node-key", def: process.env.BASE_NODE_KEY ?? "" },
    { name: "fetch-max-blobs", def: String(envIntOr("BASE_FETCH_MAX_BLOBS", 64)) },
    { name: "sync-interval", def: envOr("BASE_SYNC_INTERVAL", "5m") },
    { name: "scrub-interval", def: envOr("BASE_SCRUB_INTERVAL", "24h") },
  ];
}

/** 把 parseFlags 的值表映射为具名 flag 结构。 */
export function peerFlagsFromValues(values: Record<string, string>): PeerFlags {
  return {
    data: values["data"] ?? "data",
    storeKey: values["store-key"] ?? "",
    peers: values["peers"] ?? "",
    issuerPubkeys: values["issuer-pubkeys"] ?? "",
    tlsCert: values["tls-cert"] ?? "",
    tlsKey: values["tls-key"] ?? "",
    nodeKey: values["node-key"] ?? "",
    fetchMaxBlobs: values["fetch-max-blobs"] ?? "64",
    syncInterval: values["sync-interval"] ?? "5m",
    scrubInterval: values["scrub-interval"] ?? "24h",
  };
}

/** envOr（export.go:54-59）：env 非空则取其值（**不 trim**），否则 def。 */
export function envOr(key: string, def: string): string {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : def;
}

/** envIntOr（peerconfig.go:130-137）：env 非空且 `Atoi(TrimSpace(v))` 成功则用，否则 def。 */
export function envIntOr(key: string, def: number): number {
  const v = process.env[key];
  if (v !== undefined && v !== "") {
    const n = atoi(v.trim());
    if (n !== null) return n;
  }
  return def;
}

/** 64 位平台 strconv.Atoi 的等价（十进制、可带正负号）。 */
function atoi(s: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * peersFromRaw：parsePeers（serve.go:29-38）+ peers()（peerconfig.go:49-59）。
 * 空串 → []；`JSON.parse` 必须得数组；每元素映射为 `Peer{url, tlsFingerprint}`。
 */
export function peersFromRaw(raw: string): Peer[] {
  if (raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`BASE_PEERS 不是合法 JSON 数组: ${errMsg(err)}`);
  }
  if (parsed === null) return []; // Go：JSON null → nil 切片，无错
  if (!Array.isArray(parsed)) {
    throw new Error("BASE_PEERS 不是合法 JSON 数组: 期望 JSON 数组");
  }
  return parsed.map((e, i) => {
    if (e === null) return { url: "", tlsFingerprint: "" }; // Go：元素 null → 零值 struct
    if (typeof e !== "object" || Array.isArray(e)) {
      throw new Error(`BASE_PEERS 不是合法 JSON 数组: 第 ${i} 个元素不是对象`);
    }
    const o = e as { url?: unknown; tls_fingerprint?: unknown };
    return { url: strField(o.url, i, "url"), tlsFingerprint: strField(o.tls_fingerprint, i, "tls_fingerprint") };
  });
}

function strField(v: unknown, i: number, name: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") {
    throw new Error(`BASE_PEERS 不是合法 JSON 数组: 第 ${i} 个元素的 ${name} 不是字符串`);
  }
  return v;
}

/** defaultCertPaths（peerconfig.go:63-65）：`<data>/tls/node.crt`、`<data>/tls/node.key`。 */
export function defaultCertPaths(data: string): [string, string] {
  return [join(data, "tls", "node.crt"), join(data, "tls", "node.key")];
}

/** certPaths（peerconfig.go:68-81）：off（忽略大小写、去空白）→ 两空串；否则去空白并落回默认。 */
export function certPaths(f: PeerFlags): [string, string] {
  if (f.tlsCert.trim().toLowerCase() === "off") return ["", ""];
  let cert = f.tlsCert.trim();
  let key = f.tlsKey.trim();
  const [defCert, defKey] = defaultCertPaths(f.data);
  if (cert === "") cert = defCert;
  if (key === "") key = defKey;
  return [cert, key];
}

/** tlsInfo（peerconfig.go:86-92）：off 时落回默认证书路径（节点↔节点身份仍在）。 */
export async function tlsInfo(f: PeerFlags, tls: TlsAdapter): Promise<TlsInfo> {
  let [certFile, keyFile] = certPaths(f);
  if (certFile === "" && keyFile === "") {
    [certFile, keyFile] = defaultCertPaths(f.data);
  }
  return tls.loadOrCreate({ certFile, keyFile });
}

/** openStore（peerconfig.go:95-101）：注入 -store-key 时优先于 `<data>.key`。 */
export function openStore(f: PeerFlags): SyncStore {
  const opts = f.storeKey.trim() !== "" ? { storeKeyHex: f.storeKey } : {};
  return openSyncStore(f.data, opts);
}

/** config（peerconfig.go:104-115）：组装出站配置（issuer-pubkeys 解析失败原样抛）。 */
export function config(f: PeerFlags, info: TlsInfo): Config {
  const pubs = parseIssuerPubKeys(f.issuerPubkeys);
  const n = atoi(f.fetchMaxBlobs.trim());
  if (n === null) {
    // 对齐 Go flag 包：`invalid value %q for flag -%s: %v`（整型 Set 失败 → "parse error"）。
    throw new Error(
      `invalid value "${f.fetchMaxBlobs}" for flag -fetch-max-blobs: parse error`,
    );
  }
  return {
    ownTls: info,
    nodeKey: f.nodeKey.trim(),
    issuerPubKeys: pubs,
    fetchMaxBlobs: n,
  };
}

/** durations（peerconfig.go:118-128）：解析两个调度间隔，失败带 flag 名前缀。 */
export function durations(f: PeerFlags): { syncMs: number; scrubMs: number } {
  let syncMs: number;
  try {
    syncMs = parseGoDuration(f.syncInterval.trim());
  } catch (err) {
    throw new Error(`-sync-interval 解析失败: ${errMsg(err)}`);
  }
  let scrubMs: number;
  try {
    scrubMs = parseGoDuration(f.scrubInterval.trim());
  } catch (err) {
    throw new Error(`-scrub-interval 解析失败: ${errMsg(err)}`);
  }
  return { syncMs, scrubMs };
}

/** logf（peerconfig.go:139）：Go `log.Printf` 默认格式 = 本地时间 `YYYY/MM/DD HH:MM:SS ` + 消息，写 stderr。 */
export function logf(msg: string): void {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
  process.stderr.write(`${stamp} ${msg}\n`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// —— time.ParseDuration 等价实现（Go src/time/format.go）——

/** 单位 → 纳秒（unitMap）。 */
const UNIT_NS: Record<string, number> = {
  ns: 1,
  us: 1e3,
  "µs": 1e3, // U+00B5 micro sign
  "μs": 1e3, // U+03BC Greek mu
  ms: 1e6,
  s: 1e9,
  m: 60e9,
  h: 3600e9,
};

const MAX_INT64 = 2 ** 63;

function quote(s: string): string {
  return `"${s}"`;
}

/**
 * parseGoDuration：Go `time.ParseDuration` 的等价实现，返回**毫秒**（number）。
 * 文法：`[-+]?([0-9]*(\.[0-9]*)?[a-zµμ]+)+`；支持多段（`1h30m`）、小数、正负号。
 * 非法 → `time: invalid duration "<s>"`；缺单位 → `time: missing unit in duration "<s>"`；
 * 未知单位 → `time: unknown unit "<u>" in duration "<s>"`。
 */
export function parseGoDuration(input: string): number {
  const orig = input;
  let s = input;
  let neg = false;
  if (s !== "") {
    const c = s[0];
    if (c === "-" || c === "+") {
      neg = c === "-";
      s = s.slice(1);
    }
  }
  if (s === "0") return 0;
  if (s === "") throw new Error(`time: invalid duration ${quote(orig)}`);

  let total = 0; // 纳秒
  while (s !== "") {
    const c0 = s[0];
    if (!(c0 === "." || (c0 >= "0" && c0 <= "9"))) {
      throw new Error(`time: invalid duration ${quote(orig)}`);
    }
    // leadingInt
    let i = 0;
    let v = 0;
    let overflowInt = false;
    while (i < s.length && s[i] >= "0" && s[i] <= "9") {
      if (!overflowInt) {
        v = v * 10 + (s.charCodeAt(i) - 48);
        if (v > MAX_INT64) overflowInt = true;
      }
      i++;
    }
    const pre = i !== 0;
    s = s.slice(i);
    // leadingFraction
    let f = 0;
    let scale = 1;
    let post = false;
    if (s !== "" && s[0] === ".") {
      s = s.slice(1);
      let j = 0;
      while (j < s.length && s[j] >= "0" && s[j] <= "9") {
        if (f <= (MAX_INT64 - 1) / 10) {
          const y = f * 10 + (s.charCodeAt(j) - 48);
          if (y <= MAX_INT64) {
            f = y;
            scale *= 10;
          }
        }
        j++;
      }
      post = j !== 0;
      s = s.slice(j);
    }
    if (!pre && !post) throw new Error(`time: invalid duration ${quote(orig)}`);
    // 单位：消费到下一个数字/小数点之前
    let k = 0;
    while (k < s.length && !(s[k] === "." || (s[k] >= "0" && s[k] <= "9"))) k++;
    if (k === 0) throw new Error(`time: missing unit in duration ${quote(orig)}`);
    const u = s.slice(0, k);
    s = s.slice(k);
    const unit = UNIT_NS[u];
    if (unit === undefined) {
      throw new Error(`time: unknown unit ${quote(u)} in duration ${quote(orig)}`);
    }
    if (overflowInt || v > MAX_INT64 / unit) throw new Error(`time: invalid duration ${quote(orig)}`);
    v *= unit;
    if (f > 0) {
      // value = v + f/scale（v 已换算为纳秒）；float 用于对小时的小数保持纳秒精度。
      v += Math.floor(f * (unit / scale));
      if (v > MAX_INT64) throw new Error(`time: invalid duration ${quote(orig)}`);
    }
    total += v;
    if (total > MAX_INT64) throw new Error(`time: invalid duration ${quote(orig)}`);
  }
  if (neg) return -total / 1e6;
  if (total > MAX_INT64 - 1) throw new Error(`time: invalid duration ${quote(orig)}`);
  return total / 1e6;
}
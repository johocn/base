// 对端同步·反熵的**出站**侧（逐行移植 internal/peersync/peer.go）。
// 本文件只发起请求，不提供任何 handler。
//
// 与 Go 的**有意差异**（记录于文件头）：
//   1. 重定向：Go 的 http.Client 默认跟随最多 10 次重定向；Node 的 https.request 默认**不跟随**。
//      本系统对端 handler 从不重定向，故此处实现为**不跟随**（真实对端下行为等价）。
//   2. TransportFor 抽象：Go 是 `func(p Peer) (http.RoundTripper, error)`；Node 无 RoundTripper，
//      改为 `(p: Peer) => PeerTransport`。PeerTransport 是一次「发请求」的进程内抽象
//      （PeerRequest → PeerResponse），使单测可在**无 TCP 环境**（沙箱缺环回）下跑。
//   3. client 的 TLS 传输：Go 用 httpapi.ClientTLSConfig + PeerVerifier（internal/httpapi/tlscfg.go:149-199）。
//      Node 无对应类型，用 node:https 的 cert/key（本节点证书）+ rejectUnauthorized:false
//      + checkServerIdentity（并在响应处再核一次对端 DER 指纹）实现**对端 DER sha256 指纹钉扎**；
//      白名单为空即 fail-closed 拒绝。
//   4. Go 的方法 `Config.do` 在 TS 里叫 `doRequest`（`do` 是 JS 保留字，不能作函数名）。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import type { PeerCertificate, TLSSocket } from "node:tls";

/** 一个对端节点（与 cmd/based 的 peerSpec / BASE_PEERS 元素同形）。 */
export interface Peer {
  url: string;
  tlsFingerprint: string;
}

/** 本节点 TLS 身份（对齐 httpapi.TLSInfo 的出站所需三字段）。fingerprintHex 为小写 hex64。 */
export interface TlsIdentity {
  certFile: string;
  keyFile: string;
  fingerprintHex: string;
}

/** 一次出站请求（PeerTransport 的入参）。 */
export interface PeerRequest {
  method: string;
  url: string;
  /** 已叠加 Content-Type / X-Base-Node-Key 的请求头。 */
  headers: Record<string, string>;
  /** 无 body 时为 null。 */
  body: Uint8Array | null;
  /** 覆盖整次请求的超时/取消信号。 */
  signal: AbortSignal | undefined;
}

/** 一次出站响应（PeerTransport 的出参）。headers 键为小写。 */
export interface PeerResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** 「发一次请求」的可注入抽象；生产路径为 nil 时用上面的 TLS 客户端。 */
export type PeerTransport = (req: PeerRequest) => Promise<PeerResponse>;

/** 取消信号（Go 的 context.Context 在出站侧的等价物）；可为 undefined。 */
export type SyncContext = AbortSignal | undefined;

/** Config 是一次 Session 的出站配置（对齐 Go peersync.Config）。 */
export interface Config {
  /** 本节点 TLS 身份（对端是双向 TLS，客户端必须带证书）。 */
  ownTls?: TlsIdentity;
  /** 可选；非空时所有出站请求带 X-Base-Node-Key（对端监听可叠加这层）。 */
  nodeKey?: string;
  /** 签发方公钥信任表（issuer → 公钥 hex64），来源只有配置注入。 */
  issuerPubKeys?: Record<string, string>;
  /** fetch 单请求块数上限；<=0 取 defaultFetchMaxBlobs。 */
  fetchMaxBlobs?: number;
  /** 为 nil 时按 ownTls + peer 指纹构造 TLS 传输（生产路径）。非 nil 时用它（测试注入）。 */
  transportFor?: (p: Peer) => PeerTransport;
}

export const DEFAULT_FETCH_MAX_BLOBS = 64;
/** Go requestTimeout = 2 * time.Minute。 */
export const REQUEST_TIMEOUT_MS = 120_000;

/** fetchMaxBlobs（peer.go:61-66）：<=0 取默认 64。 */
export function fetchMaxBlobs(c: Config): number {
  const n = c.fetchMaxBlobs ?? 0;
  if (n <= 0) return DEFAULT_FETCH_MAX_BLOBS;
  return n;
}

function fingerprintMismatch(msg: string): Error {
  const err = new Error(`tls_fingerprint_mismatch: ${msg}`);
  (err as Error & { code?: string }).code = "tls_fingerprint_mismatch";
  return err;
}

/** 白名单只做 trim + 小写；空项保留（保持 fail-closed，剔掉会退化成「不校验」）。 */
function normalizeFingerprints(list: readonly string[]): Set<string> {
  return new Set(list.map((f) => f.trim().toLowerCase()));
}

/** 对端 DER 指纹钉扎（对齐 PeerVerifier，tlscfg.go:149-167）。raw 为空即拒绝。 */
function verifyPinned(raw: Uint8Array | undefined, allowed: Set<string>): Error | null {
  if (raw === undefined || raw.length === 0) return fingerprintMismatch("对端未提供证书");
  const got = createHash("sha256").update(raw).digest("hex");
  if (!allowed.has(got)) return fingerprintMismatch(`对端指纹 ${got} 不在白名单`);
  return null;
}

/** 构造默认 TLS 传输：读本节点证书/私钥（对齐 ClientTLSConfig 的加载时机，失败即抛错）。 */
function tlsTransport(own: TlsIdentity | undefined, peerFingerprintHex: string): PeerTransport {
  if (own === undefined) throw new Error("tls: 缺少本节点 TLS 身份");
  const cert = readFileSync(own.certFile);
  const key = readFileSync(own.keyFile);
  const allowed = normalizeFingerprints([peerFingerprintHex]);
  return (req) =>
    new Promise<PeerResponse>((resolve, reject) => {
      const u = new URL(req.url);
      const r = httpsRequest(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port === "" ? undefined : u.port,
          path: u.pathname + u.search,
          method: req.method,
          headers: req.headers,
          cert,
          key,
          rejectUnauthorized: false,
          checkServerIdentity: (_host, peer: PeerCertificate) =>
            verifyPinned(peer.raw, allowed) ?? undefined,
          signal: req.signal,
        },
        (res) => {
          // 响应到达时握手已完成：再核一次对端 DER 指纹，保证 fail-closed。
          const socket = res.socket as TLSSocket | null;
          if (socket !== null) {
            const bad = verifyPinned(socket.getPeerCertificate().raw, allowed);
            if (bad !== null) {
              res.destroy(bad);
              reject(bad);
              return;
            }
          }
          const chunks: Buffer[] = [];
          res.on("data", (d: Buffer) => chunks.push(d));
          res.on("end", () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
            }
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: new Uint8Array(Buffer.concat(chunks)),
            });
          });
          res.on("error", reject);
        },
      );
      r.on("error", reject);
      if (req.body !== null) r.write(Buffer.from(req.body));
      r.end();
    });
}

/** client（peer.go:43-59）：transportFor 非空用它，否则按 ownTls + peer 指纹构造 TLS 传输。 */
export function client(c: Config, p: Peer): PeerTransport {
  if (c.transportFor !== undefined) return c.transportFor(p);
  return tlsTransport(c.ownTls, p.tlsFingerprint);
}

/** 超时用 AbortSignal.timeout 覆盖整次请求；有 ctx 则与之取并集。 */
function withTimeout(ctx: SyncContext): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (ctx === undefined) return timeout;
  return AbortSignal.any([ctx, timeout]);
}

/** doRequest（peer.go:69-81）：发起一次请求并叠加 node key。 */
export function doRequest(
  c: Config,
  ctx: SyncContext,
  tr: PeerTransport,
  method: string,
  url: string,
  body: Uint8Array | null,
): Promise<PeerResponse> {
  const headers: Record<string, string> = {};
  if (body !== null) headers["Content-Type"] = "application/json; charset=utf-8";
  const nodeKey = c.nodeKey ?? "";
  if (nodeKey !== "") headers["X-Base-Node-Key"] = nodeKey;
  return tr({ method, url, headers, body, signal: withTimeout(ctx) });
}

/** isLowerHex（peer.go:115-122）：只认 0-9 / a-f。 */
export function isLowerHex(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x30 || c > 0x39) && (c < 0x61 || c > 0x66)) return false;
  }
  return true;
}

/**
 * ParseIssuerPubKeys（peer.go:92-113）：解析签发方公钥信任表：issuer → 公钥 hex64。
 * 这是**唯一**的信任来源：不做 TOFU、不调 /v1/pubkey。空串 → 空表。
 */
export function parseIssuerPubKeys(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw.trim() === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`BASE_ISSUER_PUBKEYS 不是合法 JSON 数组: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`BASE_ISSUER_PUBKEYS 不是合法 JSON 数组: 期望 JSON 数组`);
  }
  parsed.forEach((rawEntry, i) => {
    const e = (rawEntry ?? {}) as { issuer?: unknown; public_key_hex?: unknown };
    const issuer = String(e.issuer ?? "").trim();
    if (issuer === "") {
      throw new Error(`BASE_ISSUER_PUBKEYS[${i}]: issuer 不能为空`);
    }
    const pub = String(e.public_key_hex ?? "")
      .trim()
      .toLowerCase();
    if (pub.length !== 64 || !isLowerHex(pub)) {
      throw new Error(`BASE_ISSUER_PUBKEYS[${i}]: public_key_hex 必须是 64 位小写 hex`);
    }
    out[issuer] = pub;
  });
  return out;
}
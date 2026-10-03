// HttpServerAdapter：Go 1.22 http.ServeMux 体例的路由 + node:http 监听。
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import type {
  HttpServerAdapter,
  Listener,
  ServerHandler,
  ServerRequest,
  ServerResponse,
  TlsConfig,
} from "@base/core-ts";
import { verifyPeerFingerprint } from "./tls";

type Segment =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string }
  | { kind: "rest"; name: string };

interface Route {
  method?: string;
  segments: Segment[];
  literalCount: number;
  wildcardCount: number;
  order: number;
  handler: ServerHandler;
}

export interface RouteMatch {
  handler: ServerHandler;
  params: Record<string, string>;
}

export interface Router {
  handle(pattern: string, handler: ServerHandler): void;
  match(method: string, path: string): RouteMatch | null;
}

function parseSegments(path: string): Segment[] {
  const raw = path.startsWith("/") ? path.slice(1) : path;
  const parts = raw.split("/");
  const segments: Segment[] = [];
  parts.forEach((part, i) => {
    if (part.startsWith("{") && part.endsWith("}")) {
      const inner = part.slice(1, -1);
      if (inner.endsWith("...")) {
        if (i !== parts.length - 1) {
          throw new Error(`invalid pattern: {${inner}} 必须是最后一段`);
        }
        segments.push({ kind: "rest", name: inner.slice(0, -3) });
        return;
      }
      segments.push({ kind: "param", name: inner });
      return;
    }
    segments.push({ kind: "literal", value: part });
  });
  return segments;
}

interface ParsedPattern {
  method?: string;
  segments: Segment[];
}

function parsePattern(pattern: string): ParsedPattern {
  const sp = pattern.indexOf(" ");
  if (sp < 0) {
    return { segments: parseSegments(pattern) };
  }
  return { method: pattern.slice(0, sp), segments: parseSegments(pattern.slice(sp + 1)) };
}

/** GET pattern 同时匹配 HEAD（Go 语义）。 */
function methodAllows(patternMethod: string | undefined, method: string): boolean {
  if (patternMethod === undefined) return true;
  if (patternMethod === method) return true;
  return patternMethod === "GET" && method === "HEAD";
}

function matchSegments(segments: Segment[], path: string): Record<string, string> | null {
  const raw = path.startsWith("/") ? path.slice(1) : path;
  const parts = raw.split("/");
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as Segment;
    if (seg.kind === "rest") {
      params[seg.name] = parts.slice(i).join("/");
      return params;
    }
    const part = parts[i];
    if (part === undefined) return null;
    if (seg.kind === "literal") {
      if (part !== seg.value) return null;
    } else {
      params[seg.name] = part;
    }
  }
  if (parts.length !== segments.length) return null;
  return params;
}

/** 纯函数匹配：pattern 形如 "GET /v1/catalog"、"/a/{id}"、"GET /a/{rest...}"。 */
export function matchPattern(
  pattern: string,
  method: string,
  path: string,
): Record<string, string> | null {
  const parsed = parsePattern(pattern);
  if (!methodAllows(parsed.method, method)) return null;
  return matchSegments(parsed.segments, path);
}

/** 更具体者胜出：字面段多者优先 → 通配段少者优先 → 方法限定者优先 → 注册顺序早者优先。 */
function moreSpecific(a: Route, b: Route): boolean {
  if (a.literalCount !== b.literalCount) return a.literalCount > b.literalCount;
  if (a.wildcardCount !== b.wildcardCount) return a.wildcardCount < b.wildcardCount;
  const aRestricted = a.method !== undefined;
  const bRestricted = b.method !== undefined;
  if (aRestricted !== bRestricted) return aRestricted;
  return a.order < b.order;
}

export function createRouter(): Router {
  const routes: Route[] = [];
  let order = 0;
  return {
    handle(pattern, handler) {
      const parsed = parsePattern(pattern);
      routes.push({
        method: parsed.method,
        segments: parsed.segments,
        literalCount: parsed.segments.filter((s) => s.kind === "literal").length,
        wildcardCount: parsed.segments.filter((s) => s.kind !== "literal").length,
        order: order++,
        handler,
      });
    },
    match(method, path) {
      let best: RouteMatch | null = null;
      let bestRoute: Route | null = null;
      for (const route of routes) {
        if (!methodAllows(route.method, method)) continue;
        const params = matchSegments(route.segments, path);
        if (params === null) continue;
        if (bestRoute === null || moreSpecific(route, bestRoute)) {
          bestRoute = route;
          best = { handler: route.handler, params };
        }
      }
      return best;
    },
  };
}

const encoder = new TextEncoder();
const NOT_FOUND_BODY = encoder.encode("404 page not found\n");

async function readBody(req: http.IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function toServerRequest(req: http.IncomingMessage, body: Uint8Array): ServerRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    if (query[key] === undefined) query[key] = value;
  });
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : (value ?? "");
  }
  return {
    method: req.method ?? "GET",
    path: url.pathname,
    params: {},
    query,
    headers,
    body,
  };
}

// withCommon 语义（server.go:167-190）：每个响应都带 CORS 与 nosniff 头。
const COMMON_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Base-Id, X-Base-Alg, X-Base-Ts, X-Base-Nonce, X-Base-Sig",
  "X-Content-Type-Options": "nosniff",
};

function writeResponse(res: http.ServerResponse, resp: ServerResponse): void {
  const body = resp.body ?? new Uint8Array(0);
  const headers: Record<string, string> = { ...COMMON_HEADERS, ...(resp.headers ?? {}) };
  if (resp.status === 304 || resp.status === 204) {
    // Go net/http 对 304/204 省略 Content-Length（handler 显式设置的也去掉）。
    delete headers["Content-Length"];
  } else if (headers["Content-Length"] === undefined) {
    // 未显式设置时才按 body 字节数补齐；HEAD /v1/blob 需保留「明文大小」的 Content-Length。
    headers["Content-Length"] = String(body.byteLength);
  }
  res.writeHead(resp.status, headers);
  res.end(Buffer.from(body));
}

/**
 * 对端监听 TLS（计划 #77 T2 / B-③）：对齐 Go ServerTLSConfig（tlscfg.go:170-182）。
 * 白名单非空 ⇒ 双向 TLS：要求对端证书 + 握手期指纹固定；空白名单 ⇒ 不设 ClientAuth（与 Go 一致）。
 */
function createTlsServer(tls: TlsConfig, handler: http.RequestListener): https.Server {
  const requirePeer = tls.trustPeerByFingerprint;
  const server = https.createServer(
    {
      cert: readFileSync(tls.certFile),
      key: readFileSync(tls.keyFile),
      // 自签证书链校验必失败，信任完全由指纹承担（对齐 Go 的 InsecureSkipVerify + 指纹固定）。
      ...(requirePeer ? { requestCert: true, rejectUnauthorized: false } : {}),
      // 对齐 ServerTLSConfig 的 MinVersion: tls.VersionTLS12（恒设）。
      minVersion: "TLSv1.2",
    },
    handler,
  );
  if (requirePeer) {
    // 唯一的 fail-closed 点：rejectUnauthorized:false 下「不带证书」的握手会成功，
    // 故握手完成即刻校验对端 DER 指纹，失败即 destroy（对齐 Go 握手期拒绝）。
    server.on("secureConnection", (socket) => {
      const raw = socket.getPeerCertificate(false).raw;
      if (verifyPeerFingerprint(raw, tls.peerFingerprints) !== null) {
        socket.destroy();
      }
    });
  }
  return server;
}

export function createHttpServerAdapter(): HttpServerAdapter {
  const router = createRouter();

  return {
    handle(pattern, handler) {
      router.handle(pattern, handler);
    },

    async listen(opts): Promise<Listener> {
      const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
        void (async () => {
          // withCommon 短路：OPTIONS 无论路径是否命中路由都返回 204 无 body。
          if ((req.method ?? "GET") === "OPTIONS") {
            writeResponse(res, { status: 204 });
            return;
          }
          const body = await readBody(req);
          const request = toServerRequest(req, body);
          const matched = router.match(request.method, request.path);
          if (matched === null) {
            writeResponse(res, {
              status: 404,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
              body: NOT_FOUND_BODY,
            });
            return;
          }
          request.params = matched.params;
          writeResponse(res, await matched.handler(request));
        })();
      };

      const server: http.Server | https.Server =
        opts.tls === undefined ? http.createServer(handler) : createTlsServer(opts.tls, handler);

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once("error", onError);
        server.listen(opts.port, opts.host, () => {
          server.off("error", onError);
          resolve();
        });
      });

      return {
        addr(): string {
          const a = server.address();
          if (a === null || typeof a === "string") return String(a);
          const host = a.address.includes(":") ? `[${a.address}]` : a.address;
          return `${host}:${a.port}`;
        },
        close(): Promise<void> {
          return new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          });
        },
      };
    },
  };
}

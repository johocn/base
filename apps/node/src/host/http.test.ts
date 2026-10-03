import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Listener, ServerHandler, TlsConfig } from "@base/core-ts";
import { createHttpServerAdapter, createRouter, matchPattern } from "./http";
import { createTlsAdapter, generateSelfSigned } from "./tls";

const noop: ServerHandler = async () => ({ status: 200 });

describe("matchPattern：段语法", () => {
  it("{name} 匹配单段并提取 params", () => {
    expect(matchPattern("/a/{id}", "GET", "/a/42")).toEqual({ id: "42" });
    expect(matchPattern("/a/{id}/b", "GET", "/a/42/b")).toEqual({ id: "42" });
  });

  it("{name} 不跨段、不匹配长度不符", () => {
    expect(matchPattern("/a/{id}", "GET", "/a/42/b")).toBeNull();
    expect(matchPattern("/a/{id}", "GET", "/b/42")).toBeNull();
    expect(matchPattern("/a/{id}", "GET", "/a")).toBeNull();
  });

  it("{name...} 匹配剩余全部（含空）", () => {
    expect(matchPattern("/a/{rest...}", "GET", "/a/x/y.z")).toEqual({ rest: "x/y.z" });
    expect(matchPattern("/a/{rest...}", "GET", "/a/x")).toEqual({ rest: "x" });
    expect(matchPattern("/a/{rest...}", "GET", "/a/")).toEqual({ rest: "" });
  });

  it("无方法 pattern 匹配任意方法", () => {
    expect(matchPattern("/healthz", "POST", "/healthz")).toEqual({});
  });
});

describe("matchPattern：方法语义", () => {
  it("GET pattern 同时命中 HEAD", () => {
    expect(matchPattern("GET /healthz", "GET", "/healthz")).toEqual({});
    expect(matchPattern("GET /healthz", "HEAD", "/healthz")).toEqual({});
    expect(matchPattern("GET /healthz", "POST", "/healthz")).toBeNull();
  });
});

describe("createRouter：具体度优先", () => {
  it("字面段多者胜出", () => {
    const router = createRouter();
    const wild: ServerHandler = async () => ({ status: 200 });
    const literal: ServerHandler = async () => ({ status: 201 });
    router.handle("/a/{id}", wild);
    router.handle("/a/x", literal);
    expect(router.match("GET", "/a/x")?.handler).toBe(literal);
    expect(router.match("GET", "/a/y")?.handler).toBe(wild);
  });

  it("同具体度时方法限定者胜出", () => {
    const router = createRouter();
    const any: ServerHandler = async () => ({ status: 200 });
    const get: ServerHandler = async () => ({ status: 201 });
    router.handle("/v1/catalog", any);
    router.handle("GET /v1/catalog", get);
    expect(router.match("GET", "/v1/catalog")?.handler).toBe(get);
    expect(router.match("POST", "/v1/catalog")?.handler).toBe(any);
  });
});

// ---- 计划 #77 T2 / B-③：对端监听的双向 TLS 指纹固定（门禁 G6 三格 + 空白名单一格）。 ----

const tls = createTlsAdapter();
const dirs: string[] = [];
const encoder = new TextEncoder();

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "base-http-tls-"));
  dirs.push(dir);
  return dir;
}

/** 生成一张自签身份（服务端/对端共用同一套生成器）。 */
function identity(dir: string, name: string): { certFile: string; keyFile: string } {
  const certFile = join(dir, `${name}.crt`);
  const keyFile = join(dir, `${name}.key`);
  generateSelfSigned(certFile, keyFile);
  return { certFile, keyFile };
}

function fingerprint(certFile: string): string {
  return createHash("sha256").update(new X509Certificate(readFileSync(certFile)).raw).digest("hex");
}

async function loadIdentity(dir: string, name: string) {
  return tls.loadOrCreate(identity(dir, name));
}

/** 起一个只挂 GET /peer/ping 的对端口监听（host/port 由 ListenOptions 决定，port 0 = 随机）。 */
async function startPeer(cfg: TlsConfig): Promise<Listener> {
  const http = createHttpServerAdapter();
  http.handle("GET /peer/ping", async () => ({ status: 200, body: encoder.encode("pong") }));
  return http.listen({ host: "127.0.0.1", port: 0, tls: cfg });
}

/** 作为对端发起一次请求；client 为空表示**不带**客户端证书。agent:false ⇒ 无 keep-alive，close() 不挂起。 */
function peerGet(addr: string, client?: { cert: Buffer; key: Buffer }): Promise<number> {
  const i = addr.lastIndexOf(":");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: addr.slice(0, i),
        port: Number(addr.slice(i + 1)),
        path: "/peer/ping",
        method: "GET",
        agent: false,
        rejectUnauthorized: false,
        signal: AbortSignal.timeout(4000),
        ...(client ?? {}),
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("listen：对端 mTLS 指纹固定（计划 #77 G6）", () => {
  it("白名单命中：带证书的对端通过", async () => {
    const dir = tmpDir();
    const node = await loadIdentity(dir, "node");
    const peer = identity(dir, "peer");
    const listener = await startPeer(tls.serverConfig(node, [fingerprint(peer.certFile)]));
    try {
      await expect(
        peerGet(listener.addr(), {
          cert: readFileSync(peer.certFile),
          key: readFileSync(peer.keyFile),
        }),
      ).resolves.toBe(200);
    } finally {
      await listener.close();
    }
  });

  it("无证书：TLS 层被拒（fail-closed，唯一的 fail-closed 点）", async () => {
    const dir = tmpDir();
    const node = await loadIdentity(dir, "node");
    const peer = identity(dir, "peer");
    const listener = await startPeer(tls.serverConfig(node, [fingerprint(peer.certFile)]));
    try {
      await expect(peerGet(listener.addr())).rejects.toThrow();
    } finally {
      await listener.close();
    }
  });

  it("错指纹：TLS 层被拒", async () => {
    const dir = tmpDir();
    const node = await loadIdentity(dir, "node");
    const peer = identity(dir, "peer");
    const other = identity(dir, "other");
    const listener = await startPeer(tls.serverConfig(node, [fingerprint(peer.certFile)]));
    try {
      await expect(
        peerGet(listener.addr(), {
          cert: readFileSync(other.certFile),
          key: readFileSync(other.keyFile),
        }),
      ).rejects.toThrow();
    } finally {
      await listener.close();
    }
  });

  it("空白名单：不要求对端证书（对齐 Go 不设 ClientAuth）", async () => {
    const dir = tmpDir();
    const node = await loadIdentity(dir, "node");
    const listener = await startPeer(tls.serverConfig(node, []));
    try {
      await expect(peerGet(listener.addr())).resolves.toBe(200);
    } finally {
      await listener.close();
    }
  });
});

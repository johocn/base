import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Listener, ServerAdapters } from "@base/core-ts";
import { openDb, type Db } from "../db";
import { createHttpServerAdapter } from "../host/http";
import { createTlsAdapter } from "../host/tls";
import { createSchedulerAdapter } from "../host/scheduler";
import { createCliHost } from "../host/cli";
import { createLifecycleAdapter } from "../host/lifecycle";
import { startServer } from "../serve";

// RFC 8032 §7.1 TEST 1 的确定性测试密钥（与 Go httpapi_test.go 一致）。
const SIGN_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUB_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(url: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      })
      .on("error", reject);
  });
}

function adapters(): ServerAdapters {
  return {
    http: createHttpServerAdapter(),
    tls: createTlsAdapter(),
    scheduler: createSchedulerAdapter(),
    cli: createCliHost(),
    lifecycle: createLifecycleAdapter(),
  };
}

let dir: string;
let db: Db;
let withKey: Listener;
let withoutKey: Listener;
let baseWith: string;
let baseWithout: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-pubkey-"));
  db = openDb(join(dir, "base.db"));
  withKey = await startServer(adapters(), db, {
    host: "127.0.0.1",
    port: 0,
    issuer: "base-node-1",
    signKeyHex: SIGN_SEED,
  });
  withoutKey = await startServer(adapters(), db, { host: "127.0.0.1", port: 0, issuer: "base-node-1" });
  baseWith = `http://${withKey.addr()}`;
  baseWithout = `http://${withoutKey.addr()}`;
});

afterAll(async () => {
  await withKey.close();
  await withoutKey.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /v1/pubkey", () => {
  it("配置签名密钥 → 200 公钥 + issuer", async () => {
    const res = await request(`${baseWith}/v1/pubkey`);
    const body = `{"issuer":"base-node-1","public_key_hex":"${PUB_HEX}"}\n`;
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("未配置签名密钥 → 404", async () => {
    const res = await request(`${baseWithout}/v1/pubkey`);
    const body = `{"error":"本节点未配置签名密钥（只读分发节点）"}\n`;
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(body);
  });
});

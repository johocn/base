import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Listener, ServerAdapters, ServerRequest } from "@base/core-ts";
import {
  bytesToHex,
  keyPairFromSeed,
  randomBytes,
  requestSignBytes,
  sha256Hex,
  sign,
} from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { createHttpServerAdapter } from "../host/http";
import { createTlsAdapter } from "../host/tls";
import { createSchedulerAdapter } from "../host/scheduler";
import { createCliHost } from "../host/cli";
import { createLifecycleAdapter } from "../host/lifecycle";
import { optionalAuth } from "./authmw";
import { jsonResponse } from "./json";
import { startServer } from "../serve";

const IDENTITIES_DDL = `CREATE TABLE identities(
		id           TEXT PRIMARY KEY,
		alg          TEXT NOT NULL,
		pubkey       TEXT NOT NULL,
		created_at   INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL DEFAULT 0
	)`;
const NONCES_DDL = `CREATE TABLE auth_nonces(
		id      TEXT NOT NULL,
		nonce   TEXT NOT NULL,
		seen_at INTEGER NOT NULL,
		PRIMARY KEY(id, nonce)
	)`;
const PROFILES_DDL = `CREATE TABLE profiles(
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)`;
const PROGRESS_DDL = `CREATE TABLE progress(
		id         TEXT    NOT NULL,
		item_id    TEXT    NOT NULL,
		position   INTEGER NOT NULL,
		done       INTEGER NOT NULL,
		day        TEXT    NOT NULL,
		updated_at INTEGER NOT NULL,
		event_id   TEXT    NOT NULL,
		dirty      INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY(id, item_id)
	)`;
const CHECKIN_DDL = `CREATE TABLE checkin_days(
		id             TEXT    NOT NULL,
		day            TEXT    NOT NULL,
		first_event_id TEXT    NOT NULL,
		created_at     INTEGER NOT NULL,
		PRIMARY KEY(id, day)
	)`;

const ID = "0123456789abcdef0123456789abcdef";
// RFC 8032 test-1 种子：其公钥即 identity.test.ts 里的 PUB（真私钥签、真公钥验）。
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUB = keyPairFromSeed(SEED).pubHex;
const UNREG = "f".repeat(32);

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function send(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Uint8Array,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(Buffer.from(body));
    req.end();
  });
}

function authHeaders(
  seedHex: string,
  id: string,
  method: string,
  path: string,
  opts: { ts?: number; nonce?: string; body?: Uint8Array; alg?: string } = {},
): Record<string, string> {
  const ts = opts.ts ?? Date.now();
  const nonce = opts.nonce ?? bytesToHex(randomBytes(16));
  const body = opts.body ?? new Uint8Array(0);
  const sig = sign(
    seedHex,
    requestSignBytes({
      method,
      path,
      query: "",
      bodySha256: sha256Hex(body),
      ts,
      nonce,
    }),
  );
  return {
    "X-Base-Id": id,
    "X-Base-Alg": opts.alg ?? "ed25519",
    "X-Base-Ts": String(ts),
    "X-Base-Nonce": nonce,
    "X-Base-Sig": sig,
  };
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
let listener: Listener;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-authmw-"));
  db = openDb(join(dir, "base.db"));
  db.execute(IDENTITIES_DDL);
  db.execute(NONCES_DDL);
  db.execute(PROFILES_DDL);
  db.execute(PROGRESS_DDL);
  db.execute(CHECKIN_DDL);
  db.execute(
    `INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
    [ID, "ed25519", PUB, 1700000000000, 0],
  );
  listener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0 });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 逐字节断言 writeAuthErr 的 {"code":...,"error":...}（code 在前，Go map 字典序）。 */
function expectAuthErr(res: Res, status: number, code: string, text: string): void {
  expect(res.status).toBe(status);
  expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.body.toString("utf8")).toBe(`{"code":"${code}","error":"${text}"}\n`);
}

describe("authenticate 七步拒绝矩阵（真签名/真验签）", () => {
  it("五头缺失 → 400 auth_missing_header", async () => {
    const res = await send("POST", `${base}/v1/profile`, {}, new Uint8Array(0));
    expectAuthErr(res, 400, "auth_missing_header", "缺少签名头");
  });

  it("半带头（只给 Id/Alg）→ 400 auth_missing_header", async () => {
    const res = await send("POST", `${base}/v1/profile`, { "X-Base-Id": ID, "X-Base-Alg": "ed25519" });
    expectAuthErr(res, 400, "auth_missing_header", "缺少签名头");
  });

  it("alg 不支持 → 400 identity_alg_unsupported", async () => {
    const h = authHeaders(SEED, ID, "GET", "/v1/me");
    const res = await send("GET", `${base}/v1/me`, { ...h, "X-Base-Alg": "rsa" });
    expectAuthErr(res, 400, "identity_alg_unsupported", "算法不受支持");
  });

  it("id 非 32hex → 400 identity_id_invalid", async () => {
    const h = authHeaders(SEED, ID, "GET", "/v1/me");
    const res = await send("GET", `${base}/v1/me`, { ...h, "X-Base-Id": "zz" });
    expectAuthErr(res, 400, "identity_id_invalid", "身份 id 必须是 32 位 hex");
  });

  it("ts 非十进制 → 400 auth_ts_invalid", async () => {
    const h = authHeaders(SEED, ID, "GET", "/v1/me");
    const res = await send("GET", `${base}/v1/me`, { ...h, "X-Base-Ts": "abc" });
    expectAuthErr(res, 400, "auth_ts_invalid", "X-Base-Ts 不是十进制毫秒时间戳");
  });

  it("nonce 非 16 字节 hex → 400 auth_nonce_invalid", async () => {
    const h = authHeaders(SEED, ID, "GET", "/v1/me");
    const res = await send("GET", `${base}/v1/me`, { ...h, "X-Base-Nonce": "ab" });
    expectAuthErr(res, 400, "auth_nonce_invalid", "X-Base-Nonce 必须是 16 字节 hex");
  });

  it("sig 非 hex → 400 auth_sig_invalid", async () => {
    const h = authHeaders(SEED, ID, "GET", "/v1/me");
    const res = await send("GET", `${base}/v1/me`, { ...h, "X-Base-Sig": "zz" });
    expectAuthErr(res, 400, "auth_sig_invalid", "X-Base-Sig 必须是 hex");
  });

  it("身份未登记 → 403 identity_unregistered", async () => {
    const h = authHeaders(SEED, UNREG, "GET", "/v1/me");
    const res = await send("GET", `${base}/v1/me`, h);
    expectAuthErr(res, 403, "identity_unregistered", "身份未登记");
  });

  it("时间窗越界（±300s 之外）→ 401 auth_ts_out_of_window", async () => {
    const h = authHeaders(SEED, ID, "GET", "/v1/me", { ts: Date.now() - 400_000 });
    const res = await send("GET", `${base}/v1/me`, h);
    expectAuthErr(res, 401, "auth_ts_out_of_window", "时间戳超出 ±300 秒窗口");
  });

  it("nonce 重放（同 id+nonce 第二次）→ 401 auth_nonce_replay", async () => {
    const h = authHeaders(SEED, ID, "GET", "/v1/me");
    const first = await send("GET", `${base}/v1/me`, h);
    expect(first.status).toBe(200);
    const second = await send("GET", `${base}/v1/me`, h);
    expectAuthErr(second, 401, "auth_nonce_replay", "nonce 在 10 分钟内已使用过");
  });

  it("签名错（对别的 path 签）→ 401 auth_bad_signature", async () => {
    const h = authHeaders(SEED, ID, "GET", "/v1/other");
    const res = await send("GET", `${base}/v1/me`, h);
    expectAuthErr(res, 401, "auth_bad_signature", "签名验证失败");
  });

  it("体超 64 KiB → 413 auth_body_too_large", async () => {
    const big = new Uint8Array(64 * 1024 + 1);
    big.fill(0x20);
    const h = authHeaders(SEED, ID, "POST", "/v1/profile", { body: big });
    const res = await send("POST", `${base}/v1/profile`, h, big);
    expectAuthErr(res, 413, "auth_body_too_large", "请求体超过本接口上限");
  });
});

describe("optionalAuth（5 头全缺按匿名、半带头仍拒）", () => {
  function req(headers: Record<string, string>, method = "GET", path = "/v1/x"): ServerRequest {
    return { method, path, params: {}, query: {}, headers, body: new Uint8Array(0) };
  }

  it("五头全缺 → 匿名放行（identityId 为空串）", async () => {
    const h = optionalAuth({ db }, async (_r, id) => jsonResponse(200, { id }));
    const res = await h(req({}));
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body ?? new Uint8Array(0)).toString("utf8")).toBe(`{"id":""}\n`);
  });

  it("半带头 → 400 auth_missing_header", async () => {
    const h = optionalAuth({ db }, async (_r, id) => jsonResponse(200, { id }));
    const res = await h(req({ "x-base-id": ID }));
    expect(res.status).toBe(400);
    expect(Buffer.from(res.body ?? new Uint8Array(0)).toString("utf8")).toBe(
      `{"code":"auth_missing_header","error":"缺少签名头"}\n`,
    );
  });

  it("全带且验签通过 → identityId 交给 handler", async () => {
    const h = optionalAuth({ db }, async (_r, id) => jsonResponse(200, { id }));
    const signed = authHeaders(SEED, ID, "GET", "/v1/x");
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(signed)) lower[k.toLowerCase()] = v;
    const res = await h(req(lower));
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body ?? new Uint8Array(0)).toString("utf8")).toBe(`{"id":"${ID}"}\n`);
  });
});
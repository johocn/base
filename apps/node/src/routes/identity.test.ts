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

// identities / escrow 两表 DDL 逐字取自 store/schema.ts。
const IDENTITIES_DDL = `CREATE TABLE identities(
		id           TEXT PRIMARY KEY,
		alg          TEXT NOT NULL,
		pubkey       TEXT NOT NULL,
		created_at   INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL DEFAULT 0
	)`;
const ESCROW_DDL = `CREATE TABLE escrow(
		username    TEXT PRIMARY KEY,
		id          TEXT NOT NULL,
		alg         TEXT NOT NULL,
		salt        TEXT NOT NULL,
		kdf_json    TEXT NOT NULL,
		enc_nonce   TEXT NOT NULL,
		priv_cipher TEXT NOT NULL,
		updated_at  INTEGER NOT NULL
	)`;

// 数据面：合法 32 位小写 hex id + 一条真实形状的 escrow 记录。
const ID = "0123456789abcdef0123456789abcdef";
const PUB = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const CREATED_AT = 1700000000000; // int64 毫秒
const SALT = "cd".repeat(16);
const NONCE = "ef".repeat(12);
const PRIV = "ab".repeat(48);
const UPDATED_AT = 1700000000001;
// kdf_json 故意用**非字典序、非 kdfParams 结构序**存储：
// 只有「原样嵌入」才能逐字节还原它，重新序列化（排序键或按结构体键序）都会露馅。
const KDF_RAW = `{"p":1,"len":32,"m":65536,"t":3,"alg":"argon2id"}`;

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
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
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
let listener: Listener;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-identity-"));
  db = openDb(join(dir, "base.db"));
  db.execute(IDENTITIES_DDL);
  db.execute(ESCROW_DDL);
  db.execute(
    `INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
    [ID, "ed25519", PUB, CREATED_AT, 0],
  );
  db.execute(
    `INSERT INTO escrow(username,id,alg,salt,kdf_json,enc_nonce,priv_cipher,updated_at)
			VALUES(?,?,?,?,?,?,?,?)`,
    ["alice", ID, "ed25519", SALT, KDF_RAW, NONCE, PRIV, UPDATED_AT],
  );
  listener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0 });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /v1/identity/{id}", () => {
  it("已登记 → 200，body 逐字节等于 Go 键序 alg/created_at/id/pubkey", async () => {
    const res = await request(`${base}/v1/identity/${ID}`);
    const body = `{"alg":"ed25519","created_at":${CREATED_AT},"id":"${ID}","pubkey":"${PUB}"}\n`;
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("未登记（合法 hex）→ 404 identity_not_found", async () => {
    const res = await request(`${base}/v1/identity/${"a".repeat(32)}`);
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"identity_not_found"}\n`);
  });

  it("非法 id（长度/字符不符）→ 400 identity_id_invalid", async () => {
    for (const bad of ["notahex", "abc", "g".repeat(32), "A".repeat(31), ""]) {
      const res = await request(`${base}/v1/identity/${encodeURIComponent(bad)}`);
      expect(res.status, `id=${JSON.stringify(bad)}`).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"identity_id_invalid"}\n`);
    }
  });

  it("大写 id → 400（Go isHex32 只认小写，ToLower 对合法 id 不可达）", async () => {
    const res = await request(`${base}/v1/identity/${ID.toUpperCase()}`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"identity_id_invalid"}\n`);
  });
});

describe("GET /v1/identity/escrow/{username}", () => {
  it("已托管 → 200，body 逐字节等于 Go 键序且 kdf 原样嵌入", async () => {
    const res = await request(`${base}/v1/identity/escrow/alice`);
    const body =
      `{"alg":"ed25519","enc_nonce":"${NONCE}","id":"${ID}","kdf":${KDF_RAW},` +
      `"priv_cipher":"${PRIV}","salt":"${SALT}","updated_at":${UPDATED_AT},"username":"alice"}\n`;
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("未托管 → 404 escrow_not_found", async () => {
    const res = await request(`${base}/v1/identity/escrow/nobody`);
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"escrow_not_found"}\n`);
  });

  it("非法 username 严格 ^[a-zA-Z0-9_]{3,32}$ → 400", async () => {
    const bads = ["a", "ab", "has space", "-lead", "has.dot", "用户名", "x".repeat(33)];
    for (const u of bads) {
      const res = await request(`${base}/v1/identity/escrow/${encodeURIComponent(u)}`);
      expect(res.status, `username=${JSON.stringify(u)}`).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"escrow_username_invalid"}\n`);
    }
  });

  it("连续请求超突发（10）→ 429 rate_limited + Retry-After: 60", async () => {
    // 用**全新** server 实例拿到干净令牌桶（escrowLimiter 为独立实例，突发 10）。
    const fresh = await startServer(adapters(), db, { host: "127.0.0.1", port: 0 });
    const freshBase = `http://${fresh.addr()}`;
    try {
      // 前 10 次消费全部令牌：未命中同样计数，均应为 404。
      for (let i = 1; i <= 10; i++) {
        const res = await request(`${freshBase}/v1/identity/escrow/nobody`);
        expect(res.status, `第 ${i} 次`).toBe(404);
      }
      const res11 = await request(`${freshBase}/v1/identity/escrow/nobody`);
      expect(res11.status).toBe(429);
      expect(res11.headers["retry-after"]).toBe("60");
      expect(res11.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(res11.body.toString("utf8")).toBe(`{"error":"rate_limited"}\n`);
    } finally {
      await fresh.close();
    }
  });
});

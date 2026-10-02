import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Listener, ServerAdapters } from "@base/core-ts";
import { bytesToHex, keyPairFromSeed, randomBytes, requestSignBytes, sha256Hex, sign } from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { createHttpServerAdapter } from "../host/http";
import { createTlsAdapter } from "../host/tls";
import { createSchedulerAdapter } from "../host/scheduler";
import { createCliHost } from "../host/cli";
import { createLifecycleAdapter } from "../host/lifecycle";
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

const ID = "0123456789abcdef0123456789abcdef";
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUB = keyPairFromSeed(SEED).pubHex;

interface Res {
  status: number;
  body: Buffer;
}

function post(url: string, headers: Record<string, string>, body: Uint8Array): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.write(Buffer.from(body));
    req.end();
  });
}

function authHeaders(body: Uint8Array): Record<string, string> {
  const ts = Date.now();
  const nonce = bytesToHex(randomBytes(16));
  return {
    "Content-Type": "application/json",
    "X-Base-Id": ID,
    "X-Base-Alg": "ed25519",
    "X-Base-Ts": String(ts),
    "X-Base-Nonce": nonce,
    "X-Base-Sig": sign(
      SEED,
      requestSignBytes({
        method: "POST",
        path: "/v1/profile",
        query: "",
        bodySha256: sha256Hex(body),
        ts,
        nonce,
      }),
    ),
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
  dir = mkdtempSync(join(tmpdir(), "base-node-profile-"));
  db = openDb(join(dir, "base.db"));
  db.execute(IDENTITIES_DDL);
  db.execute(NONCES_DDL);
  db.execute(PROFILES_DDL);
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

function put(bodyText: string): Promise<Res> {
  const body = Buffer.from(bodyText, "utf8");
  return post(`${base}/v1/profile`, authHeaders(new Uint8Array(body)), new Uint8Array(body));
}

describe("POST /v1/profile", () => {
  it("成功：去首尾空白后写入 → 200 {\"id\",\"name\"}", async () => {
    const res = await put(`{"name":"  Alice  "}`);
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(`{"id":"${ID}","name":"Alice"}\n`);
    const rows = db.select(`SELECT name FROM profiles WHERE id=?`, [ID]);
    expect(rows.length).toBe(1);
    expect(String(rows[0].name)).toBe("Alice");
  });

  it("二次写入按 id upsert 覆盖", async () => {
    const res = await put(`{"name":"Bob"}`);
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(`{"id":"${ID}","name":"Bob"}\n`);
    const rows = db.select(`SELECT name FROM profiles WHERE id=?`, [ID]);
    expect(String(rows[0].name)).toBe("Bob");
  });

  it("携带 id → 400 profile_id_forbidden（code 形状）", async () => {
    const res = await put(`{"id":"x","name":"Alice"}`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(
      `{"code":"profile_id_forbidden","error":"请求体不得携带 id"}\n`,
    );
  });

  it("携带 id:null 也算携带 → 400 profile_id_forbidden", async () => {
    const res = await put(`{"id":null,"name":"Alice"}`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(
      `{"code":"profile_id_forbidden","error":"请求体不得携带 id"}\n`,
    );
  });

  it("name 非法（空白/控制字符/超 32 rune）→ 400 profile_name_invalid（code 形状）", async () => {
    const bads = [`{"name":"   "}`, `{"name":""}`, `{"name":"a\\u0001b"}`, `{"name":"${"x".repeat(33)}"}`];
    for (const b of bads) {
      const res = await put(b);
      expect(res.status, b).toBe(400);
      expect(res.body.toString("utf8")).toBe(
        `{"code":"profile_name_invalid","error":"昵称必须是去首尾空白后 1..32 个字符，且不含控制字符"}\n`,
      );
    }
  });

  it("非对象 JSON → 400 {\"error\":\"bad_json\"}（普通形状，非 code）", async () => {
    const res = await put(`[]`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"bad_json"}\n`);
  });

  it("body 为 JSON null → 解码 no-op → 400 profile_name_invalid（不抛错挂起）", async () => {
    const res = await put(`null`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(
      `{"code":"profile_name_invalid","error":"昵称必须是去首尾空白后 1..32 个字符，且不含控制字符"}\n`,
    );
  });

  it("id 出现即为携带（含 null）→ 400 profile_id_forbidden", async () => {
    const res = await put(`{"id":null,"name":"ok"}`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(
      `{"code":"profile_id_forbidden","error":"请求体不得携带 id"}\n`,
    );
  });

  it("字段类型严格（name 收数字）→ 400 {\"error\":\"bad_json\"}", async () => {
    const res = await put(`{"name":123}`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"bad_json"}\n`);
  });

  it("未签名 → 400 auth_missing_header", async () => {
    const res = await post(`${base}/v1/profile`, {}, Buffer.from(`{"name":"A"}`));
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"code":"auth_missing_header","error":"缺少签名头"}\n`);
  });
});
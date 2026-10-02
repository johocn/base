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
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUB = keyPairFromSeed(SEED).pubHex;
const ID2 = "11111111111111111111111111111111";
const SEED2 = "01".repeat(32);
const PUB2 = keyPairFromSeed(SEED2).pubHex;

const E1 = "11111111111111111111111111111111";
const E2 = "22222222222222222222222222222222";

interface Res {
  status: number;
  body: Buffer;
}

function get(url: string, headers: Record<string, string>): Promise<Res> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      })
      .on("error", reject);
  });
}

function authHeaders(seedHex: string, id: string, path: string): Record<string, string> {
  const ts = Date.now();
  const nonce = bytesToHex(randomBytes(16));
  return {
    "X-Base-Id": id,
    "X-Base-Alg": "ed25519",
    "X-Base-Ts": String(ts),
    "X-Base-Nonce": nonce,
    "X-Base-Sig": sign(
      seedHex,
      requestSignBytes({
        method: "GET",
        path,
        query: "",
        bodySha256: sha256Hex(new Uint8Array(0)),
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
  dir = mkdtempSync(join(tmpdir(), "base-node-me-"));
  db = openDb(join(dir, "base.db"));
  db.execute(IDENTITIES_DDL);
  db.execute(NONCES_DDL);
  db.execute(PROGRESS_DDL);
  db.execute(CHECKIN_DDL);
  db.execute(
    `INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
    [ID, "ed25519", PUB, 1700000000000, 0],
  );
  db.execute(
    `INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
    [ID2, "ed25519", PUB2, 1700000000000, 0],
  );
  db.execute(
    `INSERT INTO progress(id,item_id,position,done,day,updated_at,event_id,dirty) VALUES(?,?,?,?,?,?,?,0)`,
    [ID, "article/a", 10, 1, "2026-01-01", 1700000000000, E1],
  );
  db.execute(
    `INSERT INTO progress(id,item_id,position,done,day,updated_at,event_id,dirty) VALUES(?,?,?,?,?,?,?,0)`,
    [ID, "quiz/b", 0, 0, "2026-01-02", 1700000000001, E2],
  );
  db.execute(`INSERT INTO checkin_days(id,day,first_event_id,created_at) VALUES(?,?,?,?)`, [
    ID,
    "2026-01-01",
    E1,
    1700000000000,
  ]);
  db.execute(`INSERT INTO checkin_days(id,day,first_event_id,created_at) VALUES(?,?,?,?)`, [
    ID,
    "2026-01-02",
    E2,
    1700000000001,
  ]);
  listener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0 });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /v1/me", () => {
  it("空进度 → 三数组恒为数组（非 null）", async () => {
    const res = await get(`${base}/v1/me`, authHeaders(SEED2, ID2, "/v1/me"));
    const body = `{"checkin_days":[],"events":[],"id":"${ID2}","progress":[]}\n`;
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(body);
    expect(res.body.toString("utf8")).not.toContain("null");
  });

  it("有进度/打卡 → 逐字节等于 Go 键序（progress: day/done/event_id/item_id/position/updated_at）", async () => {
    const res = await get(`${base}/v1/me`, authHeaders(SEED, ID, "/v1/me"));
    const body =
      `{"checkin_days":[` +
      `{"created_at":1700000000000,"day":"2026-01-01","first_event_id":"${E1}"},` +
      `{"created_at":1700000000001,"day":"2026-01-02","first_event_id":"${E2}"}` +
      `],"events":[],"id":"${ID}","progress":[` +
      `{"day":"2026-01-01","done":true,"event_id":"${E1}","item_id":"article/a","position":10,"updated_at":1700000000000},` +
      `{"day":"2026-01-02","done":false,"event_id":"${E2}","item_id":"quiz/b","position":0,"updated_at":1700000000001}` +
      `]}\n`;
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("未签名 → 400 auth_missing_header（走中间件）", async () => {
    const res = await get(`${base}/v1/me`, {});
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"code":"auth_missing_header","error":"缺少签名头"}\n`);
  });
});
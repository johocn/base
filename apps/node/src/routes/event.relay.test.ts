// #82 mesh 一期（spec §4.3）：POST /v1/event 代报审计。
// X-Base-Relay-For = 原签名者 id，X-Base-Relay-Device = 代报设备 id；
// 事件归属验签查 Relay-For 的公钥，请求签名鉴权仍以代报设备身份；
// events 表 relay_channel / relay_device_id 审计列：同 event_id 重放保留首次值。
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bytesToHex,
  canonicalize,
  deriveIdentityId,
  keyPairFromSeed,
  randomBytes,
  requestSignBytes,
  sha256Hex,
  sign,
  utf8,
  type Json,
} from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { createHttpServerAdapter } from "../host/http";
import { createTlsAdapter } from "../host/tls";
import { createSchedulerAdapter } from "../host/scheduler";
import { createCliHost } from "../host/cli";
import { createLifecycleAdapter } from "../host/lifecycle";
import { startServer } from "../serve";
import type { Listener, ServerAdapters } from "@base/core-ts";

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
const EVENTS_DDL = `CREATE TABLE events(
		event_id        TEXT PRIMARY KEY,
		id              TEXT NOT NULL,
		type            TEXT NOT NULL,
		body_json       TEXT NOT NULL,
		created_at      INTEGER NOT NULL,
		received_at     INTEGER NOT NULL,
		target_id       TEXT,
		payload_cid     TEXT,
		reply_to        TEXT,
		relay_channel   TEXT NOT NULL DEFAULT 'direct',
		relay_device_id TEXT
	)`;
const BLOBS_DDL = `CREATE TABLE blobs(
		blob_id    TEXT PRIMARY KEY,
		size       INTEGER NOT NULL,
		item_id    TEXT NOT NULL DEFAULT '',
		seq        INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	)`;
const TOMBSTONE_DDL = `CREATE TABLE comment_tombstone(
		event_id    TEXT PRIMARY KEY,
		payload_cid TEXT NOT NULL,
		reason      TEXT,
		at          INTEGER NOT NULL,
		received_at INTEGER NOT NULL
	)`;

const SEED_A = "a1".repeat(32); // A = 事件原签名者（Relay-For）
const SEED_B = "b2".repeat(32); // B = 代报设备（请求验签身份）
const ID_A = deriveIdentityId(keyPairFromSeed(SEED_A).pubHex);
const ID_B = deriveIdentityId(keyPairFromSeed(SEED_B).pubHex);

const TS = 1_700_000_000_000;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function post(url: string, headers: Record<string, string>, body: Uint8Array): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.write(Buffer.from(body));
    req.end();
  });
}

function authHeaders(seed: string, id: string, body: Uint8Array): Record<string, string> {
  const ts = Date.now();
  const nonce = bytesToHex(randomBytes(16));
  return {
    "Content-Type": "application/json",
    "X-Base-Id": id,
    "X-Base-Alg": "ed25519",
    "X-Base-Ts": String(ts),
    "X-Base-Nonce": nonce,
    "X-Base-Sig": sign(
      seed,
      requestSignBytes({
        method: "POST",
        path: "/v1/event",
        query: "",
        bodySha256: sha256Hex(body),
        ts,
        nonce,
      }),
    ),
  };
}

/** 真签真验：事件内容签名覆盖 canonical({event_id,type,created_at,body})。 */
function makeEnvelope(
  seed: string,
  eventId: string,
  type: string,
  createdAtRaw: string,
  bodyObj: unknown,
): string {
  const bodyPart = JSON.stringify(bodyObj);
  const sig = sign(
    seed,
    utf8(
      canonicalize({
        event_id: eventId,
        type,
        created_at: Number(createdAtRaw),
        body: bodyObj as Json,
      }),
    ),
  );
  return `{"event_id":"${eventId}","type":"${type}","created_at":${createdAtRaw},"body":${bodyPart},"sig":"${sig}"}`;
}

/** 代报请求：请求签名头 = authSeed/authId，外加 Relay 头。 */
function postRelay(
  base: string,
  authSeed: string,
  authId: string,
  relayFor: string,
  relayDevice: string,
  bodyText: string,
): Promise<Res> {
  const body = new Uint8Array(Buffer.from(bodyText, "utf8"));
  const headers: Record<string, string> = { ...authHeaders(authSeed, authId, body) };
  if (relayFor !== "") headers["X-Base-Relay-For"] = relayFor;
  if (relayDevice !== "") headers["X-Base-Relay-Device"] = relayDevice;
  return post(`${base}/v1/event`, headers, body);
}

function postDirect(base: string, seed: string, id: string, bodyText: string): Promise<Res> {
  const body = new Uint8Array(Buffer.from(bodyText, "utf8"));
  return post(`${base}/v1/event`, authHeaders(seed, id, body), body);
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
  dir = mkdtempSync(join(tmpdir(), "base-node-event-relay-"));
  db = openDb(join(dir, "base.db"));
  db.execute(IDENTITIES_DDL);
  db.execute(NONCES_DDL);
  db.execute(EVENTS_DDL);
  db.execute(BLOBS_DDL);
  db.execute(TOMBSTONE_DDL);
  for (const [seed, id] of [
    [SEED_A, ID_A],
    [SEED_B, ID_B],
  ] as const) {
    db.execute(`INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, [
      id,
      "ed25519",
      keyPairFromSeed(seed).pubHex,
      TS,
      0,
    ]);
  }
  listener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0, dataDir: dir });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /v1/event mesh 代报（#82 spec §4.3）", () => {
  it("①代报正例：B 代报 A 的评论 → 200，relay_channel='mesh'/relay_device_id=B/事件归属 id=A", async () => {
    const E = "81".repeat(16);
    const env = makeEnvelope(SEED_A, E, "comment.v1", String(TS), {
      target_id: "t1",
      text: "mesh hello",
    });
    const res = await postRelay(base, SEED_B, ID_B, ID_A, ID_B, env);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.toString("utf8")) as Record<string, unknown>;
    expect(parsed.event_id).toBe(E);

    const rows = db.select(
      `SELECT id,relay_channel,relay_device_id FROM events WHERE event_id=?`,
      [E],
    );
    expect(rows.length).toBe(1);
    expect(String(rows[0].id)).toBe(ID_A);
    expect(String(rows[0].relay_channel)).toBe("mesh");
    expect(String(rows[0].relay_device_id)).toBe(ID_B);
  });

  it("②Relay-For 与事件签名者不一致 → 403 event_sig_invalid（验签查 A 的公钥）", async () => {
    const E = "82".repeat(16);
    const env = makeEnvelope(SEED_B, E, "comment.v1", String(TS), {
      target_id: "t1",
      text: "forged",
    });
    const res = await postRelay(base, SEED_B, ID_B, ID_A, ID_B, env);
    expect(res.status).toBe(403);
    expect(res.body.toString("utf8")).toBe(
      `{"code":"event_sig_invalid","error":"事件内容签名验证失败"}\n`,
    );
    expect(db.select(`SELECT 1 FROM events WHERE event_id=?`, [E]).length).toBe(0);
  });

  it("③只带 Device 不带 For → 400 relay_header_invalid", async () => {
    const E = "83".repeat(16);
    const env = makeEnvelope(SEED_B, E, "comment.v1", String(TS), {
      target_id: "t1",
      text: "hi",
    });
    const res = await postRelay(base, SEED_B, ID_B, "", ID_B, env);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"relay_header_invalid"}\n`);
    expect(db.select(`SELECT 1 FROM events WHERE event_id=?`, [E]).length).toBe(0);
  });

  it("④直连无头 → relay_channel='direct'、relay_device_id 空", async () => {
    const E = "84".repeat(16);
    const env = makeEnvelope(SEED_A, E, "comment.v1", String(TS), {
      target_id: "t1",
      text: "direct hello",
    });
    const res = await postDirect(base, SEED_A, ID_A, env);
    expect(res.status).toBe(200);
    const rows = db.select(
      `SELECT id,relay_channel,relay_device_id FROM events WHERE event_id=?`,
      [E],
    );
    expect(rows.length).toBe(1);
    expect(String(rows[0].id)).toBe(ID_A);
    expect(String(rows[0].relay_channel)).toBe("direct");
    expect(String(rows[0].relay_device_id)).toBe("");
  });

  it("⑤mesh 头 + progress.v1 → 400 relay_type_unsupported（一期仅 comment.v1 可代报）", async () => {
    const E = "85".repeat(16);
    const env = makeEnvelope(SEED_A, E, "progress.v1", String(TS), {
      item_id: "article/x",
      position: 1,
      done: false,
      day: "2026-01-01",
    });
    const res = await postRelay(base, SEED_B, ID_B, ID_A, ID_B, env);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"relay_type_unsupported"}\n`);
    expect(db.select(`SELECT 1 FROM events WHERE event_id=?`, [E]).length).toBe(0);
  });

  it("⑥同 event_id 直连先到、mesh 重放 → 审计列保持首次 direct/空", async () => {
    const E = "86".repeat(16);
    const env = makeEnvelope(SEED_A, E, "comment.v1", String(TS), {
      target_id: "t1",
      text: "replayed",
    });
    const first = await postDirect(base, SEED_A, ID_A, env);
    expect(first.status).toBe(200);
    const second = await postRelay(base, SEED_B, ID_B, ID_A, ID_B, env);
    expect(second.status).toBe(200);

    const rows = db.select(
      `SELECT id,relay_channel,relay_device_id FROM events WHERE event_id=?`,
      [E],
    );
    expect(rows.length).toBe(1);
    expect(String(rows[0].id)).toBe(ID_A);
    expect(String(rows[0].relay_channel)).toBe("direct");
    expect(String(rows[0].relay_device_id)).toBe("");
  });
});

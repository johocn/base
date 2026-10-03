// circle.v1 事件的 7 格镜像测试（逐字对齐 Go 侧 internal/httpapi/circle_test.go）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerRequest, ServerResponse } from "@base/core-ts";
import {
  bytesToHex,
  canonicalize,
  deriveIdentityId,
  keyPairFromSeed,
  sha256Hex,
  sign,
  utf8,
  type Json,
} from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { IpLimiter } from "./derived";
import { eventPostHandler } from "./event";

const DDL: string[] = [
  `CREATE TABLE identities(
    id           TEXT PRIMARY KEY,
    alg          TEXT NOT NULL,
    pubkey       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE auth_nonces(
    id      TEXT NOT NULL,
    nonce   TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY(id, nonce)
  )`,
  `CREATE TABLE events(
    event_id    TEXT PRIMARY KEY,
    id          TEXT NOT NULL,
    type        TEXT NOT NULL,
    body_json   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    target_id   TEXT,
    payload_cid TEXT,
    reply_to    TEXT
  )`,
  `CREATE TABLE circle_assignments(
    item_id    TEXT    NOT NULL,
    circle_id  TEXT    NOT NULL,
    origin     TEXT    NOT NULL DEFAULT 'fusion',
    created_at INTEGER NOT NULL,
    PRIMARY KEY(item_id, circle_id)
  )`,
  `CREATE TABLE groups(
    group_id         TEXT PRIMARY KEY,
    creator_id       TEXT NOT NULL,
    epoch            INTEGER NOT NULL,
    roster_rev       INTEGER NOT NULL DEFAULT 0,
    encrypted        INTEGER NOT NULL DEFAULT 1,
    member_ids_json  TEXT NOT NULL,
    key_envelopes    TEXT NOT NULL DEFAULT '[]',
    event_id         TEXT NOT NULL,
    updated_at       INTEGER NOT NULL,
    origin           TEXT NOT NULL DEFAULT 'user'
  )`,
  `CREATE TABLE items(
    item_id      TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    source_rev   TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    sqlite_table TEXT NOT NULL,
    dist_class   TEXT NOT NULL DEFAULT 'public',
    state        TEXT NOT NULL DEFAULT 'active',
    updated_at   TEXT NOT NULL,
    author_id    TEXT NOT NULL DEFAULT '',
    author_sig   TEXT NOT NULL DEFAULT ''
  )`,
];

const SEED_A = "a1".repeat(32);
const ID_A = deriveIdentityId(keyPairFromSeed(SEED_A).pubHex);

const TS = 1_700_000_000_000;
const STORE_KEY = new Uint8Array(32).fill(7);

const EVENT_ID_1 = "11".repeat(16); // 32 hex
const EVENT_ID_2 = "22".repeat(16);
const EVENT_ID_3 = "33".repeat(16);
const EVENT_ID_4 = "44".repeat(16);
const EVENT_ID_5 = "55".repeat(16);
const EVENT_ID_6 = "66".repeat(16);
const EVENT_ID_7 = "77".repeat(16);

const CIRCLE_ID_A = "1".repeat(32);   // 16 字节 hex（32 字符）
const CIRCLE_ID_B = "2".repeat(32);
const ITEM_ID_A = "article/circle-a";
const ITEM_ID_B = "article/circle-b";

let dir: string;
let db: Db;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "base-node-circle-"));
  db = openDb(join(dir, "base.db"));
  for (const stmt of DDL) db.execute(stmt);
  db.execute(`INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, [
    ID_A,
    "ed25519",
    keyPairFromSeed(SEED_A).pubHex,
    TS,
    0,
  ]);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 事件内容签名覆盖 canonical({event_id,type,created_at,body})——同 verifyEventSig 口径。 */
function makeEnvelope(
  seed: string,
  eventId: string,
  type: string,
  createdAtRaw: string,
  bodyObj: unknown,
  sigOverride?: string,
): string {
  const bodyPart = JSON.stringify(bodyObj);
  const sig =
    sigOverride ??
    sign(
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

/** 每次调用给全新令牌桶（避免共享桶干扰）；请求头留空（绕过 requireAuth，只测 circle 分支）。 */
async function post(actor: string, envelope: string): Promise<ServerResponse> {
  const handler = eventPostHandler({
    db,
    dataDir: dir,
    storeKey: STORE_KEY,
    byID: new IpLimiter(30, 10),
    byIP: new IpLimiter(120, 30),
  });
  const req = {
    method: "POST",
    path: "/v1/event",
    params: {},
    query: {},
    headers: {},
    body: new Uint8Array(Buffer.from(envelope, "utf8")),
  } as ServerRequest;
  return handler(req, actor);
}

function text(res: ServerResponse): string {
  return Buffer.from(res.body ?? new Uint8Array()).toString("utf8");
}

function jsonOf(res: ServerResponse): Record<string, unknown> {
  return JSON.parse(text(res)) as Record<string, unknown>;
}

function sha256Of(s: string): string {
  return sha256Hex(utf8(s));
}

function fakeSig(): string {
  return "0".repeat(64);
}

describe("POST /v1/event circle.v1", () => {
  it("① assign 正例：落 circle_assignments 行，origin=fusion createdAt 与 created_at 同值", async () => {
    const body = { action: "assign", item_id: ITEM_ID_A, circle_id: CIRCLE_ID_A, content_hash: sha256Of("payload") };
    const envelope = makeEnvelope(SEED_A, EVENT_ID_1, "circle.v1", "1000", body);

    const res = await post(ID_A, envelope);
    expect(res.status).toBe(200);
    const parsed = jsonOf(res);
    expect(parsed.event_id).toBe(EVENT_ID_1);

    // 断言投影表有行。
    const rows = db.select(`SELECT origin,created_at FROM circle_assignments WHERE item_id=? AND circle_id=?`, [
      ITEM_ID_A,
      CIRCLE_ID_A,
    ]);
    expect(rows.length).toBe(1);
    expect(String(rows[0].origin)).toBe("fusion");
    expect(Number(rows[0].created_at)).toBe(1000);
  });

  it("② form 正例：造 groups 行（creator_id=作者 epoch=1 roster_rev=0 encrypted=1 member_ids_json=[作者] origin=user event_id=circleID）+ circle_assignments", async () => {
    // 造带归属的条目（author_id = 测试身份）。
    db.execute(
      `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ITEM_ID_B,
        "source-test",
        "article",
        "测试",
        "rev-1",
        bytesToHex(new Uint8Array(32).fill(1)),
        "articles",
        "public",
        "active",
        "2026-01-02T00:00:00Z",
        ID_A,
        "00",
      ],
    );

    const body = { action: "form", item_id: ITEM_ID_B, circle_id: CIRCLE_ID_B, origin: "user" };
    const envelope = makeEnvelope(SEED_A, EVENT_ID_2, "circle.v1", "2000", body);

    const res = await post(ID_A, envelope);
    expect(res.status).toBe(200);
    const parsed = jsonOf(res);
    expect(parsed.event_id).toBe(EVENT_ID_2);

    // 断言 groups 行被创建。
    const groups = db.select(
      `SELECT creator_id,epoch,roster_rev,encrypted,member_ids_json,origin,event_id FROM groups WHERE group_id=?`,
      [CIRCLE_ID_B],
    );
    expect(groups.length).toBe(1);
    const g = groups[0];
    expect(String(g.creator_id)).toBe(ID_A);
    expect(Number(g.epoch)).toBe(1);
    expect(Number(g.roster_rev)).toBe(0);
    expect(Number(g.encrypted)).toBe(1);
    expect(String(g.member_ids_json)).toBe(JSON.stringify([ID_A]));
    expect(String(g.origin)).toBe("user");
    expect(String(g.event_id)).toBe(CIRCLE_ID_B);

    // 断言 circle_assignments 也有行。
    const ca = db.select(`SELECT origin FROM circle_assignments WHERE item_id=? AND circle_id=?`, [
      ITEM_ID_B,
      CIRCLE_ID_B,
    ]);
    expect(ca.length).toBe(1);
    expect(String(ca[0].origin)).toBe("user");
  });

  it("③ form item_not_found（fail-closed）：条目不存在 → 400", async () => {
    const body = { action: "form", item_id: "article/does-not-exist", circle_id: CIRCLE_ID_A };
    const envelope = makeEnvelope(SEED_A, EVENT_ID_3, "circle.v1", "3000", body);

    const res = await post(ID_A, envelope);
    expect(res.status).toBe(400);
    expect(jsonOf(res).error).toBe("item_not_found");
  });

  it("④ 未知 action → 400 event_param_invalid（parseCircleBody 返回 false）", async () => {
    const body = { action: "destroy", item_id: ITEM_ID_A, circle_id: CIRCLE_ID_A };
    const envelope = makeEnvelope(SEED_A, EVENT_ID_4, "circle.v1", "4000", body);

    const res = await post(ID_A, envelope);
    expect(res.status).toBe(400);
    expect(jsonOf(res).error).toBe("event_param_invalid");
  });

  it("⑤ 未知 type → 400 event_type_unknown（注册表拒绝，在验签之前）", async () => {
    const body = { action: "assign", item_id: ITEM_ID_A, circle_id: CIRCLE_ID_A };
    const envelope = makeEnvelope(SEED_A, EVENT_ID_5, "circle_unknown.v1", "5000", body);

    const res = await post(ID_A, envelope);
    expect(res.status).toBe(400);
    expect(jsonOf(res).error).toBe("event_type_unknown");
  });

  it("⑥ 坏事件体 sig → 403 event_sig_invalid（伪造事件体 sig 字段）", async () => {
    const body = { action: "assign", item_id: ITEM_ID_A, circle_id: CIRCLE_ID_A };
    // makeEnvelope 生成正确信封，然后替换 sig 为假值。
    const envelope = makeEnvelope(SEED_A, EVENT_ID_6, "circle.v1", "6000", body);
    const parsed = JSON.parse(envelope) as Record<string, unknown>;
    parsed.sig = fakeSig();
    const tampered = JSON.stringify(parsed);

    const res = await post(ID_A, tampered);
    expect(res.status).toBe(403);
    const obj = jsonOf(res);
    expect(obj.code ?? obj.error).toBe("event_sig_invalid");
  });

  it("⑦ assign 白名单外多键（assign 没有 origin）→ 400 event_param_invalid", async () => {
    const body = { action: "assign", item_id: ITEM_ID_A, circle_id: CIRCLE_ID_A, origin: "fusion" };
    const envelope = makeEnvelope(SEED_A, EVENT_ID_7, "circle.v1", "7000", body);

    const res = await post(ID_A, envelope);
    expect(res.status).toBe(400);
    expect(jsonOf(res).error).toBe("event_param_invalid");
  });
});

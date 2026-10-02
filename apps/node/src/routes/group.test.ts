// GET /v1/group/{group_id}（批 B4b）：直接驱动 optionalAuth(optionalAuth→groupGetHandler)，
// 自建 schema、插数据、断言响应字节。逐条对齐 internal/httpapi/group.go:647-800 的读语义。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerRequest } from "@base/core-ts";
import {
  bytesToHex,
  canonicalize,
  deriveIdentityId,
  keyPairFromSeed,
  randomBytes,
  requestSignBytes,
  sha256Hex,
  sign,
  type Json,
} from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { optionalAuth } from "./authmw";
import { groupGetHandler } from "./group";

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
  `CREATE TABLE groups(
    group_id         TEXT PRIMARY KEY,
    creator_id       TEXT NOT NULL,
    epoch            INTEGER NOT NULL,
    roster_rev       INTEGER NOT NULL DEFAULT 0,
    encrypted        INTEGER NOT NULL DEFAULT 1,
    member_ids_json  TEXT NOT NULL,
    key_envelopes    TEXT NOT NULL DEFAULT '[]',
    event_id         TEXT NOT NULL,
    updated_at       INTEGER NOT NULL
  )`,
];

const SEED_A = "a1".repeat(32);
const SEED_B = "b2".repeat(32);
const ID_A = deriveIdentityId(keyPairFromSeed(SEED_A).pubHex);
const ID_B = deriveIdentityId(keyPairFromSeed(SEED_B).pubHex);

// 16 字节 hex（32 字符）的组 id。
const OPEN = "01".repeat(16);
const CLOSED = "02".repeat(16);
const MISSING = "03".repeat(16);
const PAGED = "04".repeat(16);
const ENV_EMPTY = "06".repeat(16);
const ENV_FULL = "07".repeat(16);
const ENV_NOKEY = "08".repeat(16);
const ROSTER = "09".repeat(16);

const OPEN_EVENT = "a0".repeat(16);
const MISSING_EVENT = "ff".repeat(16);
const E1 = "e1".repeat(16);
const E2 = "e2".repeat(16);
const E3 = "e3".repeat(16);
const M1 = "m1".repeat(16);
const R1 = "r1".repeat(16);
const REPLY = "1a".repeat(16);

let dir: string;
let db: Db;

function putEventRow(
  eventId: string,
  targetId: string,
  bodyJson: string,
  createdAt: number,
): void {
  db.execute(
    `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    [eventId, ID_A, "group.v1", bodyJson, createdAt, createdAt, targetId, "", ""],
  );
}

function putGroupRow(
  groupId: string,
  encrypted: number,
  memberIds: string[],
  keyEnvelopes: string,
  eventId: string,
): void {
  db.execute(
    `INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    [groupId, ID_A, 1, 1, encrypted, JSON.stringify(memberIds), keyEnvelopes, eventId, 1],
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "base-node-groupread-"));
  db = openDb(join(dir, "base.db"));
  for (const stmt of DDL) db.execute(stmt);
  for (const [seed, id] of [
    [SEED_A, ID_A],
    [SEED_B, ID_B],
  ] as const) {
    db.execute(`INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, [
      id,
      "ed25519",
      keyPairFromSeed(seed).pubHex,
      1,
      0,
    ]);
  }

  // 开放圈：event_id 指向带 name 的 roster 事件。
  putEventRow(
    OPEN_EVENT,
    "group/" + OPEN,
    canonicalize({ action: "roster", epoch: 1, member_ids: [ID_A, ID_B], name: "开放圈" } as Json),
    1,
  );
  putGroupRow(OPEN, 0, [ID_A, ID_B], "[]", OPEN_EVENT);

  // 封闭圈：成员仅 ID_A；event_id 指向不存在的事件（name 回落空串）。
  putGroupRow(CLOSED, 1, [ID_A], "[]", MISSING_EVENT);

  // 分页圈：3 条 msg 事件（E1 带 reply_to）。
  putEventRow(
    E1,
    "group/" + PAGED,
    canonicalize({ action: "msg", epoch: 1, payload_cid: "c1", reply_to: REPLY } as Json),
    300,
  );
  putEventRow(E2, "group/" + PAGED, canonicalize({ action: "msg", epoch: 2, payload_cid: "c2" } as Json), 200);
  putEventRow(E3, "group/" + PAGED, canonicalize({ action: "msg", epoch: 3, payload_cid: "c3" } as Json), 100);
  putGroupRow(PAGED, 0, [ID_A], "[]", MISSING_EVENT);

  putGroupRow(ENV_EMPTY, 0, [ID_A], "[]", MISSING_EVENT);
  putGroupRow(ENV_FULL, 0, [ID_A], '{"envelopes":[{"cipher":"abc","from_epoch":2}]}', MISSING_EVENT);
  putGroupRow(ENV_NOKEY, 0, [ID_A], '{"other":1}', MISSING_EVENT);

  // 名单事件不进会话流：混入一条 action=roster。
  putEventRow(M1, "group/" + ROSTER, canonicalize({ action: "msg", epoch: 1, payload_cid: "cm" } as Json), 100);
  putEventRow(R1, "group/" + ROSTER, canonicalize({ action: "roster", epoch: 2, member_ids: [ID_A] } as Json), 200);
  putGroupRow(ROSTER, 0, [ID_A], "[]", MISSING_EVENT);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 匿名请求（5 个签名头全缺 → optionalAuth 按匿名放行）。 */
async function anon(
  groupId: string,
  query: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const handler = optionalAuth({ db }, groupGetHandler({ db }));
  const req = {
    method: "GET",
    path: "/v1/group/" + groupId,
    params: { group_id: groupId },
    query,
    headers: {},
    body: new Uint8Array(0),
  } as ServerRequest;
  const res = await handler(req);
  return { status: res.status, body: Buffer.from(res.body ?? new Uint8Array()).toString("utf8") };
}

/** 签名请求：真私钥签 GET 待签字节（无 query）。 */
async function signed(
  groupId: string,
  seed: string,
  id: string,
): Promise<{ status: number; body: string }> {
  const path = "/v1/group/" + groupId;
  const ts = Date.now();
  const nonce = bytesToHex(randomBytes(16));
  const body = new Uint8Array(0);
  const sig = sign(
    seed,
    requestSignBytes({ method: "GET", path, query: "", bodySha256: sha256Hex(body), ts, nonce }),
  );
  const handler = optionalAuth({ db }, groupGetHandler({ db }));
  const req = {
    method: "GET",
    path,
    params: { group_id: groupId },
    query: {},
    headers: {
      "x-base-id": id,
      "x-base-alg": "ed25519",
      "x-base-ts": String(ts),
      "x-base-nonce": nonce,
      "x-base-sig": sig,
    },
    body,
  } as ServerRequest;
  const res = await handler(req);
  return { status: res.status, body: Buffer.from(res.body ?? new Uint8Array()).toString("utf8") };
}

function json(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

describe("GET /v1/group 开放圈匿名可读", () => {
  it("200：键序与字段集字节对齐 Go struct 声明顺序", async () => {
    const res = await anon(OPEN);
    const expected =
      `{"group":{"group_id":"${OPEN}","creator_id":"${ID_A}","epoch":1,"roster_rev":1,"encrypted":0,` +
      `"member_ids":["${ID_A}","${ID_B}"],"name":"开放圈","seat_count":1,"governors":["${ID_A}"],` +
      `"envelopes":[]},"events":[],"next_cursor":null}\n`;
    expect(res.status).toBe(200);
    expect(res.body).toBe(expected);
  });
});

describe("GET /v1/group 封闭圈形态分支", () => {
  it("匿名非成员 → 404 group_read_denied（带 code）", async () => {
    const res = await anon(CLOSED);
    expect(res.status).toBe(404);
    expect(res.body).toBe(`{"code":"group_read_denied","error":"圈子不存在或不可见"}\n`);
  });

  it("已登记但非成员签名 → 404 group_read_denied", async () => {
    const res = await signed(CLOSED, SEED_B, ID_B);
    expect(res.status).toBe(404);
    expect(res.body).toBe(`{"code":"group_read_denied","error":"圈子不存在或不可见"}\n`);
  });

  it("成员签名 → 200", async () => {
    const res = await signed(CLOSED, SEED_A, ID_A);
    expect(res.status).toBe(200);
    const g = json(res.body).group as Record<string, unknown>;
    expect(g.encrypted).toBe(1);
    expect(g.member_ids).toEqual([ID_A]);
    expect(g.seat_count).toBe(1);
    expect(g.governors).toEqual([ID_A]);
    // event_id 指向缺失事件 ⇒ name 回落空串。
    expect(g.name).toBe("");
  });
});

describe("GET /v1/group 错误码", () => {
  it("库中无该圈 → 404 group_not_found", async () => {
    const res = await anon(MISSING);
    expect(res.status).toBe(404);
    expect(res.body).toBe(`{"code":"group_not_found","error":"group_not_found"}\n`);
  });

  it("group_id 非 hex16 → 400 event_param_invalid", async () => {
    const res = await anon("zz");
    expect(res.status).toBe(400);
    expect(res.body).toBe(`{"error":"event_param_invalid"}\n`);
  });
});

describe("GET /v1/group 分页", () => {
  it("limit=2 满页给游标；用游标取到剩余", async () => {
    const first = await anon(PAGED, { limit: "2" });
    expect(first.status).toBe(200);
    const b1 = json(first.body);
    expect(b1.next_cursor).toBe(`200_${E2}`);
    const ev1 = b1.events as Record<string, unknown>[];
    expect(ev1.map((e) => e.event_id)).toEqual([E1, E2]);
    // reply_to：E1 有原值、E2 无 → null。
    expect(ev1[0].reply_to).toBe(REPLY);
    expect(ev1[1].reply_to).toBeNull();
    // 每个 event 的键序照 Go struct 声明顺序。
    expect(Object.keys(ev1[0])).toEqual([
      "event_id",
      "actor",
      "created_at",
      "payload_cid",
      "epoch",
      "action",
      "reply_to",
    ]);

    // 游标往返：取更旧的行。
    const second = await anon(PAGED, { limit: "2", cursor: `200_${E2}` });
    expect(second.status).toBe(200);
    const b2 = json(second.body);
    expect((b2.events as Record<string, unknown>[]).map((e) => e.event_id)).toEqual([E3]);
    expect(b2.next_cursor).toBeNull();
  });

  it("不满页 → next_cursor 为 null", async () => {
    const res = await anon(PAGED, { limit: "5" });
    const b = json(res.body);
    expect((b.events as unknown[]).length).toBe(3);
    expect(b.next_cursor).toBeNull();
  });
});

describe("GET /v1/group 名单事件不进 events", () => {
  it("action=roster 的事件行不出现", async () => {
    const res = await anon(ROSTER);
    const ev = json(res.body).events as Record<string, unknown>[];
    expect(ev.map((e) => e.event_id)).toEqual([M1]);
    expect(res.body.includes(R1)).toBe(false);
  });
});

describe("GET /v1/group envelopes 三分支", () => {
  it("'[]' ⇒ []", async () => {
    const res = await anon(ENV_EMPTY);
    expect(res.body.includes(`"envelopes":[]`)).toBe(true);
  });

  it("含 envelopes 数组 ⇒ 原样返回（文本比对）", async () => {
    const res = await anon(ENV_FULL);
    expect(res.body.includes(`"envelopes":[{"cipher":"abc","from_epoch":2}]`)).toBe(true);
  });

  it("无 envelopes 键 ⇒ null（不是省略、不是 []）", async () => {
    const res = await anon(ENV_NOKEY);
    expect(res.body.includes(`"envelopes":null`)).toBe(true);
  });
});
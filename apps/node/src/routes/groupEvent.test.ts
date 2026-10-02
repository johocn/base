// 真签真验：直接驱动 eventPostHandler 的 group.v1 分支，覆盖 msg / roster(v1) / roster_v2 写面。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerRequest, ServerResponse } from "@base/core-ts";
import {
  blobId,
  canonicalize,
  deriveIdentityId,
  keyPairFromSeed,
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
  `CREATE TABLE blobs(
    blob_id    TEXT PRIMARY KEY,
    size       INTEGER NOT NULL,
    item_id    TEXT NOT NULL DEFAULT '',
    seq        INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
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

// 11 人组用的额外成员 id（任意 32 hex，不需要登记身份——它们不签名）。
const MEMBERS_EXTRA = Array.from({ length: 10 }, (_, i) =>
  (i + 1).toString(16).padStart(2, "0").repeat(16),
);

const TS = 1_700_000_000_000;
const STORE_KEY = new Uint8Array(32).fill(7);

let dir: string;
let db: Db;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "base-node-group-"));
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
      TS,
      0,
    ]);
  }
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 事件内容签名覆盖 canonical({event_id,type,created_at,body})。 */
function makeEnvelope(
  seed: string,
  eventId: string,
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
          type: "group.v1",
          created_at: Number(createdAtRaw),
          body: bodyObj as Json,
        }),
      ),
    );
  return `{"event_id":"${eventId}","type":"group.v1","created_at":${createdAtRaw},"body":${bodyPart},"sig":"${sig}"}`;
}

/** 不做内容签名：仅用于在验签之前就会被拒的用例（sig 不被读取）。 */
function rawEnvelope(eventId: string, createdAtRaw: string, bodyText: string): string {
  return `{"event_id":"${eventId}","type":"group.v1","created_at":${createdAtRaw},"body":${bodyText},"sig":"${"00".repeat(32)}"}`;
}

/** 每次调用给全新令牌桶，避免共享桶干扰；请求头留空（绕过 requireAuth，只测 group 分支）。 */
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

const BAD_PARAM = `{"error":"event_param_invalid"}\n`;
const BAD_SIG = `{"code":"event_sig_invalid","error":"事件内容签名验证失败"}\n`;

/** 独立重建 v2 多签待签载荷（与 handler 的 rosterApprovalPayload 同字节契约）。 */
function rosterPayload(o: {
  groupId: string;
  sub: string;
  epoch: number;
  rosterRev: number;
  memberIds: string[];
  encrypted: number;
  eventId: string;
  name?: string;
}): string {
  const f: Record<string, unknown> = {
    domain: "base/group-roster-v2",
    event_id: o.eventId,
    group_id: o.groupId,
    action: "roster",
    sub: o.sub,
    epoch: o.epoch,
    roster_rev: o.rosterRev,
    member_ids: o.memberIds,
    encrypted: o.encrypted,
    created_at: TS,
  };
  if (o.name !== undefined && o.name !== "") f.name = o.name;
  return canonicalize(f as Json);
}

/** 造一条 v2 roster body；sigs 由调用方按 rosterPayload 签好后传入。 */
function v2Body(
  groupId: string,
  sub: string,
  epoch: number,
  rosterRev: number,
  memberIds: string[],
  encrypted: number,
  sigs: { id: string; sig: string }[],
  envelopes?: unknown,
): Record<string, unknown> {
  const b: Record<string, unknown> = {
    group_id: groupId,
    action: "roster",
    sub,
    epoch,
    roster_rev: rosterRev,
    member_ids: memberIds,
    encrypted,
    sigs,
  };
  if (envelopes !== undefined) b.envelopes = envelopes;
  return b;
}

function approval(
  seed: string,
  id: string,
  p: string,
): { id: string; sig: string } {
  return { id, sig: sign(seed, utf8(p)) };
}

function groupsRow(groupId: string): Record<string, unknown> | null {
  const rows = db.select(`SELECT * FROM groups WHERE group_id=?`, [groupId]);
  return rows.length === 0 ? null : rows[0];
}

describe("group.v1 msg", () => {
  const GID = "b1".repeat(16);

  it("直角 200：落块 + 落事件行，body_json 为减化 canonical 形态", async () => {
    const cipher = "hello-cipher";
    const E = "e0".repeat(16);
    const bodyObj = { group_id: GID, action: "msg", epoch: 1, text_cipher: cipher };
    const res = await post(ID_A, makeEnvelope(SEED_A, E, String(TS), bodyObj));
    const payloadCid = blobId(utf8(cipher));
    expect(res.status).toBe(200);
    const parsed = jsonOf(res);
    expect(parsed.event_id).toBe(E);
    expect(parsed.payload_cid).toBe(payloadCid);
    expect(typeof parsed.received_at).toBe("number");

    const rows = db.select(`SELECT * FROM events WHERE event_id=?`, [E]);
    expect(rows.length).toBe(1);
    expect(String(rows[0].target_id)).toBe("group/" + GID);
    expect(String(rows[0].payload_cid)).toBe(payloadCid);
    expect(String(rows[0].reply_to)).toBe("");
    expect(String(rows[0].body_json)).toBe(
      canonicalize({ group_id: GID, action: "msg", epoch: 1, payload_cid: payloadCid }),
    );
    const blobs = db.select(`SELECT size FROM blobs WHERE blob_id=?`, [payloadCid]);
    expect(blobs.length).toBe(1);
    expect(Number(blobs[0].size)).toBe(Buffer.byteLength(cipher, "utf8"));
  });

  it("带 reply_to → body_json 含 reply_to，events.reply_to 落值", async () => {
    const cipher = "with-reply";
    const reply = "1a".repeat(16);
    const E = "e1".repeat(16);
    const bodyObj = {
      group_id: GID,
      action: "msg",
      epoch: 2,
      text_cipher: cipher,
      reply_to: reply,
    };
    const res = await post(ID_A, makeEnvelope(SEED_A, E, String(TS), bodyObj));
    const payloadCid = blobId(utf8(cipher));
    expect(res.status).toBe(200);
    const rows = db.select(`SELECT * FROM events WHERE event_id=?`, [E]);
    expect(String(rows[0].reply_to)).toBe(reply);
    expect(String(rows[0].body_json)).toBe(
      canonicalize({
        group_id: GID,
        action: "msg",
        epoch: 2,
        payload_cid: payloadCid,
        reply_to: reply,
      }),
    );
  });

  it("缺 text_cipher / 未知键 → 400 event_param_invalid", async () => {
    const bad: Record<string, unknown>[] = [
      { group_id: GID, action: "msg", epoch: 1 },
      { group_id: GID, action: "msg", epoch: 1, text_cipher: "x", extra: 1 },
    ];
    for (const bodyObj of bad) {
      const res = await post(ID_A, makeEnvelope(SEED_A, "e2".repeat(16), String(TS), bodyObj));
      expect(res.status).toBe(400);
      expect(text(res)).toBe(BAD_PARAM);
    }
  });

  it("group_id 非 hex16 / epoch 0 / epoch 1.5 / 空或超限密文 / reply_to 非 hex16 → 400", async () => {
    const cases: string[] = [
      JSON.stringify({ group_id: "zz", action: "msg", epoch: 1, text_cipher: "x" }),
      JSON.stringify({ group_id: GID, action: "msg", epoch: 0, text_cipher: "x" }),
      JSON.stringify({ group_id: GID, action: "msg", epoch: 1.5, text_cipher: "x" }),
      JSON.stringify({ group_id: GID, action: "msg", epoch: 1, text_cipher: "" }),
      JSON.stringify({ group_id: GID, action: "msg", epoch: 1, text_cipher: "x".repeat(8193) }),
      JSON.stringify({ group_id: GID, action: "msg", epoch: 1, text_cipher: "x", reply_to: "zz" }),
    ];
    for (const bodyText of cases) {
      const res = await post(ID_A, rawEnvelope("e3".repeat(16), String(TS), bodyText));
      expect(res.status, bodyText).toBe(400);
      expect(text(res)).toBe(BAD_PARAM);
    }
  });

  it("内容签名不匹配 → 403 event_sig_invalid", async () => {
    const bodyObj = { group_id: GID, action: "msg", epoch: 1, text_cipher: "x" };
    const res = await post(
      ID_A,
      makeEnvelope(SEED_A, "e4".repeat(16), String(TS), bodyObj, "00".repeat(32)),
    );
    expect(res.status).toBe(403);
    expect(text(res)).toBe(BAD_SIG);
  });
});

describe("group.v1 roster v1", () => {
  const GID = "a2".repeat(16);

  it("直角 200：groups 行 roster_rev=1、encrypted 缺省为 1、creator 锁定", async () => {
    const E = "f0".repeat(16);
    const bodyObj = {
      group_id: GID,
      action: "roster",
      epoch: 1,
      member_ids: [ID_A, ID_B],
      name: "圈子",
    };
    const res = await post(ID_A, makeEnvelope(SEED_A, E, String(TS), bodyObj));
    expect(res.status).toBe(200);
    const g = groupsRow(GID);
    expect(g).not.toBeNull();
    expect(String(g?.creator_id)).toBe(ID_A);
    expect(Number(g?.epoch)).toBe(1);
    expect(Number(g?.roster_rev)).toBe(1);
    expect(Number(g?.encrypted)).toBe(1);
    expect(String(g?.member_ids_json)).toBe(JSON.stringify([ID_A, ID_B]));
    expect(String(g?.key_envelopes)).toBe("[]");
    expect(String(g?.event_id)).toBe(E);

    const ev = db.select(`SELECT * FROM events WHERE event_id=?`, [E]);
    expect(String(ev[0].target_id)).toBe("group/" + GID);
    expect(String(ev[0].body_json)).toBe(canonicalize(bodyObj as Json));
  });

  it("member_ids 空 / 成员非 hex16 / name 超 64 / encrypted=2 → 400", async () => {
    const cases: Record<string, unknown>[] = [
      { group_id: GID, action: "roster", epoch: 2, member_ids: [] },
      { group_id: GID, action: "roster", epoch: 2, member_ids: ["zz"] },
      { group_id: GID, action: "roster", epoch: 2, member_ids: [ID_A], name: "x".repeat(65) },
      { group_id: GID, action: "roster", epoch: 2, member_ids: [ID_A], encrypted: 2 },
    ];
    for (const bodyObj of cases) {
      const res = await post(ID_A, makeEnvelope(SEED_A, "f1".repeat(16), String(TS), bodyObj));
      expect(res.status).toBe(400);
      expect(text(res)).toBe(BAD_PARAM);
    }
  });

  it("同 actor epoch 不增 → 409 group_epoch_stale", async () => {
    const bodyObj = { group_id: GID, action: "roster", epoch: 1, member_ids: [ID_A] };
    const res = await post(ID_A, makeEnvelope(SEED_A, "f2".repeat(16), String(TS), bodyObj));
    expect(res.status).toBe(409);
    expect(text(res)).toBe(`{"code":"group_epoch_stale","error":"group_epoch_stale"}\n`);
  });

  it("换 actor → 403 group_owner_mismatch", async () => {
    const bodyObj = { group_id: GID, action: "roster", epoch: 5, member_ids: [ID_A, ID_B] };
    const res = await post(ID_B, makeEnvelope(SEED_B, "f3".repeat(16), String(TS), bodyObj));
    expect(res.status).toBe(403);
    expect(text(res)).toBe(`{"code":"group_owner_mismatch","error":"group_owner_mismatch"}\n`);
  });
});

describe("group.v1 roster v2", () => {
  const GID = "d1".repeat(16);

  it("直角：rename 建圈 200 → rotate 递增 200", async () => {
    const E1 = "c0".repeat(16);
    const members = [ID_A, ID_B];
    const p1 = rosterPayload({
      groupId: GID,
      sub: "rename",
      epoch: 1,
      rosterRev: 1,
      memberIds: members,
      encrypted: 0,
      eventId: E1,
    });
    const res1 = await post(
      ID_A,
      makeEnvelope(
        SEED_A,
        E1,
        String(TS),
        v2Body(GID, "rename", 1, 1, members, 0, [approval(SEED_A, ID_A, p1)]),
      ),
    );
    expect(res1.status).toBe(200);
    const g1 = groupsRow(GID);
    expect(Number(g1?.epoch)).toBe(1);
    expect(Number(g1?.roster_rev)).toBe(1);
    expect(Number(g1?.encrypted)).toBe(0);
    expect(String(g1?.creator_id)).toBe(ID_A);

    const E2 = "c1".repeat(16);
    const p2 = rosterPayload({
      groupId: GID,
      sub: "rotate",
      epoch: 2,
      rosterRev: 2,
      memberIds: members,
      encrypted: 0,
      eventId: E2,
    });
    const res2 = await post(
      ID_A,
      makeEnvelope(
        SEED_A,
        E2,
        String(TS),
        v2Body(GID, "rotate", 2, 2, members, 0, [approval(SEED_A, ID_A, p2)]),
      ),
    );
    expect(res2.status).toBe(200);
    const g2 = groupsRow(GID);
    expect(Number(g2?.epoch)).toBe(2);
    expect(Number(g2?.roster_rev)).toBe(2);
    expect(String(g2?.event_id)).toBe(E2);
  });

  it("sigs 空 / sig 非 hex64 / sig 项 3 键 / sub 非法 / member_ids 空非 dissolve / roster_rev=0 / encrypted 缺失 / envelopes 项 1 键 → 400", async () => {
    const G2 = "d6".repeat(16);
    const base = (): Record<string, unknown> =>
      v2Body(G2, "rename", 1, 1, [ID_A], 0, [{ id: ID_A, sig: "ab".repeat(32) }]);
    const cases: Record<string, unknown>[] = [
      { ...base(), sigs: [] },
      { ...base(), sigs: [{ id: ID_A, sig: "zz" }] },
      { ...base(), sigs: [{ id: ID_A, sig: "ab".repeat(32), extra: 1 }] },
      { ...base(), sub: "frob" },
      { ...base(), member_ids: [] },
      { ...base(), roster_rev: 0 },
      (({ encrypted: _e, ...rest }) => rest)(base()),
      { ...base(), envelopes: [{ from_epoch: 1 }] },
    ];
    for (const bodyObj of cases) {
      const res = await post(ID_A, makeEnvelope(SEED_A, "c2".repeat(16), String(TS), bodyObj));
      expect(res.status, JSON.stringify(bodyObj)).toBe(400);
      expect(text(res)).toBe(BAD_PARAM);
    }
  });

  it("remove 签名者不足 removeQuorum（11 人组 k=3 需 2 签）→ 403 group_roster_quorum_missing", async () => {
    const G = "d2".repeat(16);
    const members = [ID_A, ...MEMBERS_EXTRA];
    const E1 = "c3".repeat(16);
    const p1 = rosterPayload({
      groupId: G,
      sub: "rename",
      epoch: 1,
      rosterRev: 1,
      memberIds: members,
      encrypted: 0,
      eventId: E1,
    });
    const create = await post(
      ID_A,
      makeEnvelope(
        SEED_A,
        E1,
        String(TS),
        v2Body(G, "rename", 1, 1, members, 0, [approval(SEED_A, ID_A, p1)]),
      ),
    );
    expect(create.status).toBe(200);

    const E2 = "c4".repeat(16);
    const after = members.slice(0, members.length - 1);
    const p2 = rosterPayload({
      groupId: G,
      sub: "remove",
      epoch: 2,
      rosterRev: 2,
      memberIds: after,
      encrypted: 0,
      eventId: E2,
    });
    const res = await post(
      ID_A,
      makeEnvelope(
        SEED_A,
        E2,
        String(TS),
        v2Body(G, "remove", 2, 2, after, 0, [approval(SEED_A, ID_A, p2)]),
      ),
    );
    expect(res.status).toBe(403);
    expect(text(res)).toBe(
      `{"code":"group_roster_quorum_missing","error":"签名数不足门槛"}\n`,
    );
  });

  it("dissolve 发起段不足（成员但非治者签名）→ 403 group_proposal_proposer_missing", async () => {
    const G = "d3".repeat(16);
    const members = [ID_A, ID_B];
    const E1 = "c5".repeat(16);
    const p1 = rosterPayload({
      groupId: G,
      sub: "rename",
      epoch: 1,
      rosterRev: 1,
      memberIds: members,
      encrypted: 0,
      eventId: E1,
    });
    const create = await post(
      ID_A,
      makeEnvelope(
        SEED_A,
        E1,
        String(TS),
        v2Body(G, "rename", 1, 1, members, 0, [approval(SEED_A, ID_A, p1)]),
      ),
    );
    expect(create.status).toBe(200);

    const E2 = "c6".repeat(16);
    const p2 = rosterPayload({
      groupId: G,
      sub: "dissolve",
      epoch: 2,
      rosterRev: 2,
      memberIds: [],
      encrypted: 0,
      eventId: E2,
    });
    const res = await post(
      ID_B,
      makeEnvelope(
        SEED_B,
        E2,
        String(TS),
        v2Body(G, "dissolve", 2, 2, [], 0, [approval(SEED_B, ID_B, p2)]),
      ),
    );
    expect(res.status).toBe(403);
    expect(text(res)).toBe(
      `{"code":"group_proposal_proposer_missing","error":"解散圈子需治理者发起"}\n`,
    );
  });

  it("join 封闭圈 → 403 group_invite_required", async () => {
    const G = "d4".repeat(16);
    const E1 = "c7".repeat(16);
    const p1 = rosterPayload({
      groupId: G,
      sub: "rename",
      epoch: 1,
      rosterRev: 1,
      memberIds: [ID_A],
      encrypted: 1,
      eventId: E1,
    });
    const create = await post(
      ID_A,
      makeEnvelope(
        SEED_A,
        E1,
        String(TS),
        v2Body(G, "rename", 1, 1, [ID_A], 1, [approval(SEED_A, ID_A, p1)]),
      ),
    );
    expect(create.status).toBe(200);

    const E2 = "c8".repeat(16);
    const p2 = rosterPayload({
      groupId: G,
      sub: "join",
      epoch: 2,
      rosterRev: 2,
      memberIds: [ID_A, ID_B],
      encrypted: 0,
      eventId: E2,
    });
    const res = await post(
      ID_B,
      makeEnvelope(
        SEED_B,
        E2,
        String(TS),
        v2Body(G, "join", 2, 2, [ID_A, ID_B], 0, [approval(SEED_B, ID_B, p2)]),
      ),
    );
    expect(res.status).toBe(403);
    expect(text(res)).toBe(
      `{"code":"group_invite_required","error":"该圈子仅接受邀请码加入"}\n`,
    );
  });

  it("join 开放圈 且签名者恰为 {自己} → 200", async () => {
    const G = "d5".repeat(16);
    const E1 = "c9".repeat(16);
    const p1 = rosterPayload({
      groupId: G,
      sub: "rename",
      epoch: 1,
      rosterRev: 1,
      memberIds: [ID_A],
      encrypted: 0,
      eventId: E1,
    });
    const create = await post(
      ID_A,
      makeEnvelope(
        SEED_A,
        E1,
        String(TS),
        v2Body(G, "rename", 1, 1, [ID_A], 0, [approval(SEED_A, ID_A, p1)]),
      ),
    );
    expect(create.status).toBe(200);

    const E2 = "ca".repeat(16);
    const p2 = rosterPayload({
      groupId: G,
      sub: "join",
      epoch: 2,
      rosterRev: 2,
      memberIds: [ID_A, ID_B],
      encrypted: 0,
      eventId: E2,
    });
    const res = await post(
      ID_B,
      makeEnvelope(
        SEED_B,
        E2,
        String(TS),
        v2Body(G, "join", 2, 2, [ID_A, ID_B], 0, [approval(SEED_B, ID_B, p2)]),
      ),
    );
    expect(res.status).toBe(200);
    const g = groupsRow(G);
    expect(Number(g?.roster_rev)).toBe(2);
    expect(String(g?.member_ids_json)).toBe(JSON.stringify([ID_A, ID_B]));
  });
});

describe("group.v1 回归：非法 body 不再落 putBareEvent", () => {
  it("非法 group.v1 body → 400 event_param_invalid，events 表不新增行", async () => {
    const before = Number(db.select(`SELECT COUNT(*) AS n FROM events`)[0].n);
    const res = await post(
      ID_A,
      rawEnvelope("f9".repeat(16), String(TS), JSON.stringify({ action: "msg" })),
    );
    expect(res.status).toBe(400);
    expect(text(res)).toBe(BAD_PARAM);
    const after = Number(db.select(`SELECT COUNT(*) AS n FROM events`)[0].n);
    expect(after).toBe(before);
  });
});
// 真签真验：直接驱动 eventPostHandler 的 govern.v1 分支，覆盖 body 校验、投影与生效判定。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerRequest, ServerResponse } from "@base/core-ts";
import {
  canonicalize,
  deriveIdentityId,
  keyPairFromSeed,
  sign,
  utf8,
  type Json,
} from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { directoryProposalItemId, IpLimiter, normalizeTermKey } from "./derived";
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
  `CREATE TABLE govern_proposals(
    proposal_id       INTEGER PRIMARY KEY,
    action            TEXT    NOT NULL,
    item_id           TEXT    NOT NULL,
    proposer_id       TEXT    NOT NULL,
    reason            TEXT    NOT NULL DEFAULT '',
    title             TEXT    NOT NULL DEFAULT '',
    body_md           TEXT    NOT NULL DEFAULT '',
    links_json        TEXT    NOT NULL DEFAULT '',
    base_content_hash TEXT    NOT NULL,
    created_at        INTEGER NOT NULL,
    executed_at       INTEGER NOT NULL DEFAULT 0,
    voided_at         INTEGER NOT NULL DEFAULT 0,
    executed_result   TEXT    NOT NULL DEFAULT '',
    source_event_id   TEXT,
    content_version   INTEGER NOT NULL DEFAULT 0,
    revoked_rev       INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE govern_votes(
    proposal_id     INTEGER NOT NULL,
    voter_id        TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    source_event_id TEXT,
    PRIMARY KEY(proposal_id, voter_id)
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
  `CREATE TABLE articles(
    item_id      TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    digest       TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    tags_json    TEXT NOT NULL DEFAULT '[]',
    body_md      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_rev   TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE segments(
    item_id      TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    kind         TEXT NOT NULL DEFAULT '',
    text         TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY(item_id, seq)
  )`,
  `CREATE TABLE tag_links(
    tag_id     TEXT NOT NULL,
    target_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tag_id, target_id)
  )`,
  `CREATE TABLE tombstones(
    item_id     TEXT PRIMARY KEY,
    revoked_rev INTEGER NOT NULL
  )`,
  `CREATE TABLE progress(
    id         TEXT    NOT NULL,
    item_id    TEXT    NOT NULL,
    position   INTEGER NOT NULL,
    done       INTEGER NOT NULL,
    day        TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    event_id   TEXT    NOT NULL,
    dirty      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(id, item_id)
  )`,
  `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE directory_terms(
    kind            TEXT NOT NULL,
    term_key        TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    state           TEXT NOT NULL,
    first_author_id TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY(kind, term_key)
  )`,
];

const SEED_A = "a1".repeat(32);
const SEED_B = "b2".repeat(32);
const ID_A = deriveIdentityId(keyPairFromSeed(SEED_A).pubHex);
const ID_B = deriveIdentityId(keyPairFromSeed(SEED_B).pubHex);

const TS = 1_700_000_000_000;
const CONTENT_HASH = "ab".repeat(32);
const STORE_KEY = new Uint8Array(32).fill(7);

let dir: string;
let db: Db;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "base-node-govern-"));
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
          type: "govern.v1",
          created_at: Number(createdAtRaw),
          body: bodyObj as Json,
        }),
      ),
    );
  return `{"event_id":"${eventId}","type":"govern.v1","created_at":${createdAtRaw},"body":${bodyPart},"sig":"${sig}"}`;
}

/** 每次调用给全新的令牌桶，避免共享桶干扰；请求头留空（绕过 requireAuth，只测 govern 分支）。 */
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

function proposalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "proposal",
    proposal_id: "1001",
    target_item_id: "article/x",
    verb: "edit",
    content_hash: CONTENT_HASH,
    content_version: 0,
    revoked_rev: 0,
    ...overrides,
  };
}

function voteBody(proposalId: string, choice: string): Record<string, unknown> {
  return { action: "vote", proposal_id: proposalId, choice };
}

describe("govern.v1 proposal", () => {
  it("直角 200：提案行 + 提案人第 1 票 + 事件行存客户端原始字节", async () => {
    const E = "a0".repeat(16);
    const bodyObj = proposalBody();
    const res = await post(ID_A, makeEnvelope(SEED_A, E, String(TS), bodyObj));
    expect(res.status).toBe(200);
    const parsed = jsonOf(res);
    expect(Object.keys(parsed)).toEqual(["conflict", "event_id", "received_at"]);
    expect(parsed.conflict).toBe(false);
    expect(parsed.event_id).toBe(E);

    const p = db.select(`SELECT * FROM govern_proposals WHERE proposal_id=?`, [1001]);
    expect(p.length).toBe(1);
    expect(String(p[0].action)).toBe("edit");
    expect(String(p[0].item_id)).toBe("article/x");
    expect(String(p[0].proposer_id)).toBe(ID_A);
    expect(String(p[0].base_content_hash)).toBe(CONTENT_HASH);
    expect(Number(p[0].created_at)).toBe(TS);
    expect(Number(p[0].content_version)).toBe(0);
    expect(Number(p[0].revoked_rev)).toBe(0);
    expect(String(p[0].source_event_id)).toBe(E);

    const v = db.select(`SELECT * FROM govern_votes WHERE proposal_id=? AND voter_id=?`, [
      1001,
      ID_A,
    ]);
    expect(v.length).toBe(1);
    expect(Number(v[0].created_at)).toBe(TS);
    expect(String(v[0].source_event_id)).toBe(E);

    const ev = db.select(`SELECT * FROM events WHERE event_id=?`, [E]);
    expect(String(ev[0].body_json)).toBe(JSON.stringify(bodyObj));
    expect(String(ev[0].target_id)).toBe("");
    expect(String(ev[0].payload_cid)).toBe("");
    expect(String(ev[0].reply_to)).toBe("");
  });

  it("未知键 → 400 event_param_invalid", async () => {
    const res = await post(
      ID_A,
      makeEnvelope(SEED_A, "a1".repeat(16), String(TS), proposalBody({ extra: 1 })),
    );
    expect(res.status).toBe(400);
    expect(text(res)).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("缺 content_version → 400", async () => {
    const { content_version: _cv, ...rest } = proposalBody();
    const res = await post(ID_A, makeEnvelope(SEED_A, "a2".repeat(16), String(TS), rest));
    expect(res.status).toBe(400);
    expect(text(res)).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("verb 非法 → 400", async () => {
    const res = await post(
      ID_A,
      makeEnvelope(SEED_A, "a3".repeat(16), String(TS), proposalBody({ verb: "frob" })),
    );
    expect(res.status).toBe(400);
    expect(text(res)).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("content_hash 非偶数 hex → 400", async () => {
    const res = await post(
      ID_A,
      makeEnvelope(SEED_A, "a4".repeat(16), String(TS), proposalBody({ content_hash: "abc" })),
    );
    expect(res.status).toBe(400);
    expect(text(res)).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("reason 存在但不合规（空串）→ 400", async () => {
    const res = await post(
      ID_A,
      makeEnvelope(SEED_A, "a5".repeat(16), String(TS), proposalBody({ reason: "" })),
    );
    expect(res.status).toBe(400);
    expect(text(res)).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("sig 错（合法 64hex 但不匹配）→ 403 event_sig_invalid", async () => {
    const res = await post(
      ID_A,
      makeEnvelope(SEED_A, "a6".repeat(16), String(TS), proposalBody(), "00".repeat(32)),
    );
    expect(res.status).toBe(403);
    expect(text(res)).toBe(`{"code":"event_sig_invalid","error":"事件内容签名验证失败"}\n`);
  });

  it("同 proposal_id 两个 proposal 事件：后者 conflict:true 且事件行照落、提案行收敛为首个", async () => {
    const P = "1010";
    const E1 = "b0".repeat(16);
    const E2 = "b1".repeat(16);
    const first = await post(
      ID_A,
      makeEnvelope(SEED_A, E1, String(TS), proposalBody({ proposal_id: P })),
    );
    expect(jsonOf(first).conflict).toBe(false);
    const second = await post(
      ID_A,
      makeEnvelope(SEED_A, E2, String(TS + 5), proposalBody({ proposal_id: P })),
    );
    expect(second.status).toBe(200);
    expect(jsonOf(second).conflict).toBe(true);

    // 事件是权威：冲突事件行照落。
    expect(db.select(`SELECT 1 FROM events WHERE event_id=?`, [E2]).length).toBe(1);
    const p = db.select(`SELECT * FROM govern_proposals WHERE proposal_id=?`, [P]);
    expect(Number(p[0].created_at)).toBe(TS);
    expect(String(p[0].source_event_id)).toBe(E1);
  });
});

describe("govern.v1 vote", () => {
  it("直角 200：投票行落库、事件行存原始字节", async () => {
    const EP = "a7".repeat(16);
    await post(
      ID_A,
      makeEnvelope(SEED_A, EP, String(TS), proposalBody({ proposal_id: "1002" })),
    );
    const EV = "a8".repeat(16);
    const bodyObj = voteBody("1002", "yes");
    const res = await post(ID_B, makeEnvelope(SEED_B, EV, String(TS + 1), bodyObj));
    expect(res.status).toBe(200);
    expect(jsonOf(res).conflict).toBe(false);

    const v = db.select(`SELECT * FROM govern_votes WHERE proposal_id=? AND voter_id=?`, [
      1002,
      ID_B,
    ]);
    expect(v.length).toBe(1);
    expect(Number(v[0].created_at)).toBe(TS + 1);
    expect(String(v[0].source_event_id)).toBe(EV);
    const ev = db.select(`SELECT * FROM events WHERE event_id=?`, [EV]);
    expect(String(ev[0].body_json)).toBe(JSON.stringify(bodyObj));
    expect(String(ev[0].target_id)).toBe("");
  });

  it("choice 超 16 字节 → 400", async () => {
    const res = await post(
      ID_A,
      makeEnvelope(SEED_A, "a9".repeat(16), String(TS), voteBody("1002", "x".repeat(17))),
    );
    expect(res.status).toBe(400);
    expect(text(res)).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("choice 含非 ASCII → 400", async () => {
    for (const choice of ["猫", "a猫"]) {
      const res = await post(
        ID_A,
        makeEnvelope(SEED_A, "aa".repeat(16), String(TS), voteBody("1002", choice)),
      );
      expect(res.status, choice).toBe(400);
      expect(text(res)).toBe(`{"error":"event_param_invalid"}\n`);
    }
  });

  it("同 voter 重复投票静默：只留首条、source_event_id 不变、响应 conflict:false", async () => {
    const P = "1011";
    await post(
      ID_A,
      makeEnvelope(SEED_A, "b2".repeat(16), String(TS), proposalBody({ proposal_id: P })),
    );
    const V1 = "b3".repeat(16);
    const V2 = "b4".repeat(16);
    await post(ID_B, makeEnvelope(SEED_B, V1, String(TS + 1), voteBody(P, "yes")));
    const r2 = await post(ID_B, makeEnvelope(SEED_B, V2, String(TS + 100), voteBody(P, "yes")));
    expect(r2.status).toBe(200);
    expect(jsonOf(r2).conflict).toBe(false);
    const v = db.select(`SELECT * FROM govern_votes WHERE proposal_id=? AND voter_id=?`, [
      P,
      ID_B,
    ]);
    expect(v.length).toBe(1);
    expect(String(v[0].source_event_id)).toBe(V1);
  });
});

describe("govern.v1 directory_add", () => {
  const KIND = "category";
  const DISPLAY = "Cats";

  function dirBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const tk = normalizeTermKey(DISPLAY) as string;
    return {
      action: "proposal",
      proposal_id: "1020",
      target_item_id: directoryProposalItemId(KIND, tk),
      verb: "directory_add",
      content_hash: CONTENT_HASH,
      content_version: 0,
      revoked_rev: 0,
      directory_kind: KIND,
      directory_term_key: tk,
      directory_display_name: DISPLAY,
      ...overrides,
    };
  }

  it("三键缺失 → 400", async () => {
    const { directory_kind: _k, directory_term_key: _t, directory_display_name: _d, ...rest } = dirBody();
    const res = await post(ID_A, makeEnvelope(SEED_A, "c1".repeat(16), String(TS), rest));
    expect(res.status).toBe(400);
    expect(text(res)).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("NormalizeTermKey(d) !== tk → 400", async () => {
    const tk = normalizeTermKey(DISPLAY) as string;
    const res = await post(
      ID_A,
      makeEnvelope(
        SEED_A,
        "c2".repeat(16),
        String(TS),
        dirBody({ directory_term_key: "wrong", target_item_id: directoryProposalItemId(KIND, "wrong") }),
      ),
    );
    expect(res.status).toBe(400);
    expect(text(res)).toBe(`{"error":"event_param_invalid"}\n`);
    expect(tk).toBe("cats");
  });

  it("target_item_id 不符 → 400", async () => {
    const res = await post(
      ID_A,
      makeEnvelope(SEED_A, "c3".repeat(16), String(TS), dirBody({ target_item_id: "dir/category/deadbeefdeadbeef" })),
    );
    expect(res.status).toBe(400);
    expect(text(res)).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("带 title → 400", async () => {
    const res = await post(
      ID_A,
      makeEnvelope(SEED_A, "c4".repeat(16), String(TS), dirBody({ title: "x" })),
    );
    expect(res.status).toBe(400);
    expect(text(res)).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("小节点豁免：提交即生效，且重复 settle 不改 executed_at", async () => {
    const P = "1030";
    const E = "c5".repeat(16);
    const tk = normalizeTermKey(DISPLAY) as string;
    const body = dirBody({ proposal_id: P });
    const res = await post(ID_A, makeEnvelope(SEED_A, E, String(TS), body));
    expect(res.status).toBe(200);
    expect(jsonOf(res).conflict).toBe(false);

    const p = db.select(`SELECT * FROM govern_proposals WHERE proposal_id=?`, [P]);
    expect(Number(p[0].executed_at)).not.toBe(0);
    expect(String(p[0].executed_result)).toBe("directory_approved");
    const executedAt = Number(p[0].executed_at);

    const dt = db.select(`SELECT * FROM directory_terms WHERE kind=? AND term_key=?`, [KIND, tk]);
    expect(dt.length).toBe(1);
    expect(String(dt[0].display_name)).toBe(DISPLAY);
    expect(String(dt[0].state)).toBe("approved");
    expect(String(dt[0].first_author_id)).toBe(ID_A);
    expect(db.select(`SELECT value FROM meta WHERE key='directory_version'`)[0].value).toBe("1");

    // 同 event_id 重发：投影幂等 + settle 因 executed_at 非 0 直接返回。
    const again = await post(ID_A, makeEnvelope(SEED_A, E, String(TS), body));
    expect(again.status).toBe(200);
    expect(jsonOf(again).conflict).toBe(false);
    const p2 = db.select(`SELECT * FROM govern_proposals WHERE proposal_id=?`, [P]);
    expect(Number(p2[0].executed_at)).toBe(executedAt);
    expect(db.select(`SELECT value FROM meta WHERE key='directory_version'`)[0].value).toBe("1");
  });
});
// 对拍级用例：直接驱动 proposalPostHandler / proposalVoteHandler / proposalListHandler，
// 覆盖三条签名治理路由的直角、错误码与目录三分支；断言响应体的逐字节文本。
// 另覆盖 decode.ts 的 opt 指针三态（键缺失 / null / 正确类型 / 错误类型）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerRequest, ServerResponse } from "@base/core-ts";
import { openDb, type Db } from "../db";
import type { AuthedHandler } from "./authmw";
import {
  decodeStrict,
  listOf,
  opt,
  type StrictResult,
  type StrictSpec,
} from "./decode";
import {
  directoryProposalItemId,
  GOVERN_BURST_PER_IP,
  GOVERN_PER_MINUTE_PER_IP,
  IpLimiter,
  normalizeTermKey,
  PROPOSAL_BURST_PER_ID,
  PROPOSAL_PER_MINUTE_PER_ID,
  VOTE_BURST_PER_ID,
  VOTE_PER_MINUTE_PER_ID,
} from "./derived";
import { proposalListHandler, proposalPostHandler, proposalVoteHandler } from "./proposal";

const ITEMS_DDL = `CREATE TABLE items(
	item_id      TEXT PRIMARY KEY,
	source       TEXT NOT NULL,
	type         TEXT NOT NULL,
	title        TEXT NOT NULL DEFAULT '',
	source_rev   TEXT NOT NULL DEFAULT '',
	content_hash TEXT NOT NULL,
	sqlite_table TEXT NOT NULL,
	dist_class   TEXT NOT NULL DEFAULT 'public',
	instructor   TEXT NOT NULL DEFAULT '',
	state              TEXT    NOT NULL DEFAULT 'active',
	pin_level          INTEGER NOT NULL DEFAULT 0,
	pinned_at          INTEGER,
	highlight_until    INTEGER,
	tags_json          TEXT    NOT NULL DEFAULT '[]',
	updated_at         TEXT    NOT NULL,
	author_id    TEXT NOT NULL DEFAULT '',
	author_sig   TEXT NOT NULL DEFAULT ''
)`;
const ARTICLES_DDL = `CREATE TABLE articles(
	item_id      TEXT PRIMARY KEY,
	title        TEXT NOT NULL DEFAULT '',
	digest       TEXT NOT NULL DEFAULT '',
	published_at TEXT NOT NULL DEFAULT '',
	tags_json    TEXT NOT NULL DEFAULT '[]',
	body_md      TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	source_rev   TEXT NOT NULL DEFAULT ''
)`;
const QUIZZES_DDL = `CREATE TABLE quizzes(
	item_id       TEXT PRIMARY KEY,
	question_json TEXT NOT NULL,
	content_hash  TEXT NOT NULL
)`;
const MEDIA_DDL = `CREATE TABLE media_meta(
	item_id           TEXT PRIMARY KEY,
	mime              TEXT NOT NULL DEFAULT '',
	size              INTEGER NOT NULL DEFAULT 0,
	duration          INTEGER NOT NULL DEFAULT 0,
	chunk_size        INTEGER NOT NULL DEFAULT 0,
	chunk_hashes_json TEXT NOT NULL DEFAULT '[]'
)`;
const META_DDL = `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
const TOMBSTONES_DDL = `CREATE TABLE tombstones(item_id TEXT PRIMARY KEY, revoked_rev INTEGER NOT NULL)`;
const DIRECTORY_DDL = `CREATE TABLE directory_terms(
	kind            TEXT NOT NULL,
	term_key        TEXT NOT NULL,
	display_name    TEXT NOT NULL,
	state           TEXT NOT NULL,
	first_author_id TEXT NOT NULL DEFAULT '',
	created_at      TEXT NOT NULL,
	updated_at      TEXT NOT NULL,
	PRIMARY KEY(kind, term_key)
)`;
const PROPOSALS_DDL = `CREATE TABLE govern_proposals(
	proposal_id       INTEGER PRIMARY KEY,
	action            TEXT    NOT NULL,
	item_id           TEXT    NOT NULL,
	proposer_id       TEXT    NOT NULL,
	reason            TEXT    NOT NULL DEFAULT '',
	title             TEXT    NOT NULL DEFAULT '',
	body_md           TEXT    NOT NULL DEFAULT '',
	links_json        TEXT    NOT NULL DEFAULT '',
	tags_json         TEXT    NOT NULL DEFAULT '',
	dist_class        TEXT    NOT NULL DEFAULT '',
	instructor        TEXT    NOT NULL DEFAULT '',
	base_content_hash TEXT    NOT NULL,
	created_at        INTEGER NOT NULL,
	executed_at       INTEGER NOT NULL DEFAULT 0,
	voided_at         INTEGER NOT NULL DEFAULT 0,
	executed_result   TEXT    NOT NULL DEFAULT '',
	source_event_id   TEXT,
	governance_level  TEXT    NOT NULL DEFAULT 'base',
	category          TEXT,
	circle_id         TEXT,
	content_version   INTEGER NOT NULL DEFAULT 0,
	revoked_rev       INTEGER NOT NULL DEFAULT 0
)`;
const VOTES_DDL = `CREATE TABLE govern_votes(
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	proposal_id INTEGER NOT NULL,
	voter_id    TEXT    NOT NULL,
	vote_weight INTEGER NOT NULL DEFAULT 1,
	vote_type   TEXT    NOT NULL DEFAULT 'approve',
	date        TEXT    NOT NULL DEFAULT '',
	created_at  INTEGER NOT NULL,
	source_event_id TEXT
)`;
const SEGMENTS_DDL = `CREATE TABLE segments(
	item_id      TEXT NOT NULL,
	seq          INTEGER NOT NULL,
	kind         TEXT NOT NULL DEFAULT '',
	text         TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	PRIMARY KEY(item_id, seq)
)`;
const TAG_LINKS_DDL = `CREATE TABLE tag_links(
	tag_id     TEXT NOT NULL,
	target_id  TEXT NOT NULL,
	kind       TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (tag_id, target_id)
)`;
const PROGRESS_DDL = `CREATE TABLE progress(
	id          TEXT NOT NULL,
	item_id     TEXT NOT NULL,
	updated_at  TEXT NOT NULL DEFAULT '',
	PRIMARY KEY(id, item_id)
)`;
const FAVORITES_DDL = `CREATE TABLE favorites(
	id       TEXT NOT NULL,
	item_id  TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY(id, item_id)
)`;
const IDENTITIES_DDL = `CREATE TABLE identities(
	id           TEXT PRIMARY KEY,
	alg          TEXT NOT NULL,
	pubkey       TEXT NOT NULL,
	created_at   INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL DEFAULT 0
)`;

const TABLES = [
  ITEMS_DDL,
  ARTICLES_DDL,
  QUIZZES_DDL,
  MEDIA_DDL,
  META_DDL,
  TOMBSTONES_DDL,
  DIRECTORY_DDL,
  PROPOSALS_DDL,
  VOTES_DDL,
  SEGMENTS_DDL,
  TAG_LINKS_DDL,
  PROGRESS_DDL,
  FAVORITES_DDL,
  IDENTITIES_DDL,
];

const GA = "aa".repeat(16);
const GB = "bb".repeat(16);
const GC = "cc".repeat(16);
const OUTSIDER = "ee".repeat(16);
const GHOST = "ff".repeat(16);

let dir: string;
let db: Db;

function insertItem(
  itemId: string,
  type: string,
  state: string,
  authorId: string,
  contentHash: string,
): void {
  db.execute(
    `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [itemId, "src", type, itemId, "", contentHash, "articles", "public", state, "2024-01-01T00:00:00Z", authorId, ""],
  );
}

/** 给治理者一条达标 article（≥200 rune），使其进入名册。 */
function addGovernor(id: string, itemId: string): void {
  insertItem(itemId, "article", "active", id, "h" + id);
  db.execute(
    `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev) VALUES(?,?,?,?,?,?,?,?)`,
    [itemId, itemId, "", "", "[]", "x".repeat(200), "h" + id, ""],
  );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "base-node-proposal-"));
  db = openDb(join(dir, "base.db"));
  for (const stmt of TABLES) db.execute(stmt);

  // V2 需要 identities 表算 m（7 天活跃）；插 3 个让 m=3 → threshold=11, quorum=3。
  const nowMs = Date.now();
  for (const id of [GA, GB, GC]) {
    db.execute(
      `INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
      [id, "ed25519", id, nowMs, nowMs],
    );
  }

  // 名册 = {GA,GB,GC}（3 < 10 ⇒ 目录小节点豁免成立）。
  addGovernor(GA, "article/gov-a");
  addGovernor(GB, "article/gov-b");
  addGovernor(GC, "article/gov-c");

  // 治理目标：victim 归他人所有；mine 归 GA 所有（self_owned）；t1..t3 供投票用例。
  insertItem("article/victim", "article", "active", OUTSIDER, "hv");
  insertItem("article/mine", "article", "active", GA, "hm");
  insertItem("article/t1", "article", "active", OUTSIDER, "h1");
  insertItem("article/t2", "article", "active", OUTSIDER, "h2");
  insertItem("article/t3", "article", "active", OUTSIDER, "h3");

  // 目录：tag/golang 已 approved（供短路分支）。
  db.execute(
    `INSERT INTO directory_terms(kind,term_key,display_name,state,first_author_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`,
    ["tag", "golang", "Golang", "approved", "", "t", "t"],
  );
  // 目录：tag/mergekey 已有未定案提案 + GA 的一票（供同键归并分支）。
  const mergeItem = directoryProposalItemId("tag", "mergekey");
  db.execute(
    `INSERT INTO govern_proposals(proposal_id,action,item_id,proposer_id,reason,title,body_md,links_json,tags_json,dist_class,instructor,base_content_hash,created_at,executed_at,voided_at,executed_result,source_event_id,governance_level,category,circle_id,content_version,revoked_rev)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [100, "directory_add", mergeItem, GA, "", "Mergekey", "mergekey", "", "", "", "", "h", 500, 0, 0, "", null, "base", "", "", 0, 0],
  );
  db.execute(
    `INSERT INTO govern_votes(proposal_id,voter_id,vote_weight,vote_type,date,created_at,source_event_id) VALUES(?,?,?,?,?,?,?)`,
    [100, GA, 1, "approve", "1970-01-01", 501, null],
  );
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function text(res: ServerResponse): string {
  return Buffer.from(res.body ?? new Uint8Array()).toString("utf8");
}

function jsonOf(res: ServerResponse): Record<string, unknown> {
  const raw = text(res);
  // strip trailing \n if present
  return JSON.parse(raw.endsWith("\n") ? raw.slice(0, -1) : raw);
}

function makePostHandler(byID?: IpLimiter, byIP?: IpLimiter): AuthedHandler {
  return proposalPostHandler({
    db,
    storeKey: null,
    byID: byID ?? new IpLimiter(PROPOSAL_PER_MINUTE_PER_ID, PROPOSAL_BURST_PER_ID),
    byIP: byIP ?? new IpLimiter(GOVERN_PER_MINUTE_PER_IP, GOVERN_BURST_PER_IP),
  });
}

async function post(
  actor: string,
  body: Record<string, unknown>,
  handler?: AuthedHandler,
): Promise<ServerResponse> {
  const h = handler ?? makePostHandler();
  const req = {
    method: "POST",
    path: "/v1/proposal",
    params: {},
    query: {},
    headers: {},
    body: new Uint8Array(Buffer.from(JSON.stringify(body), "utf8")),
  } as ServerRequest;
  return h(req, actor);
}

function makeVoteHandler(byID?: IpLimiter, byIP?: IpLimiter): AuthedHandler {
  return proposalVoteHandler({
    db,
    storeKey: null,
    byID: byID ?? new IpLimiter(VOTE_PER_MINUTE_PER_ID, VOTE_BURST_PER_ID),
    byIP: byIP ?? new IpLimiter(GOVERN_PER_MINUTE_PER_IP, GOVERN_BURST_PER_IP),
  });
}

async function vote(pid: string, actor: string, rawBody = ""): Promise<ServerResponse> {
  const req = {
    method: "POST",
    path: `/v1/proposal/${pid}/vote`,
    params: { proposal_id: pid },
    query: {},
    headers: {},
    body: new Uint8Array(Buffer.from(rawBody, "utf8")),
  } as ServerRequest;
  return makeVoteHandler()(req, actor);
}

/** 由 GA 发起一条 remove 提案，返回其 proposal_id（字符串）。 */
async function createRemoveProposal(itemId: string, actor = GA): Promise<string> {
  const res = await post(actor, { action: "remove", item_id: itemId });
  expect(res.status).toBe(201);
  const pid = (JSON.parse(text(res)) as { proposal_id: string }).proposal_id;
  return pid;
}

describe("POST /v1/proposal", () => {
  it("proposer_id / author_id 出现即禁止 → 400 author_id_forbidden", async () => {
    for (const body of [
      { action: "remove", item_id: "article/victim", proposer_id: null },
      { action: "remove", item_id: "article/victim", author_id: "" },
    ]) {
      const res = await post(GA, body);
      expect(res.status).toBe(400);
      expect(text(res)).toBe(
        `{"code":"author_id_forbidden","error":"请求体不得携带身份字段（author_id / proposer_id / id 等）"}\n`,
      );
    }
  });

  it("action 非法 → 400 proposal_action_unsupported", async () => {
    const res = await post(GA, { action: "bogus", item_id: "article/victim" });
    expect(res.status).toBe(400);
    expect(text(res)).toBe(
      `{"code":"proposal_action_unsupported","error":"action 只能是 remove / edit / revive / directory_add"}\n`,
    );
  });

  it("reason 已给定但不合规 → 400 proposal_reason_invalid", async () => {
    const res = await post(GA, { action: "remove", item_id: "article/victim", reason: "   " });
    expect(res.status).toBe(400);
    expect(text(res)).toBe(
      `{"code":"proposal_reason_invalid","error":"reason 必须是去首尾空白后 1..200 个字符，且不含控制字符"}\n`,
    );
  });

  it("edit 动作缺 edit 载荷 → 400 proposal_edit_invalid", async () => {
    const res = await post(GA, { action: "edit", item_id: "article/victim" });
    expect(res.status).toBe(400);
    expect(text(res)).toBe(
      `{"code":"proposal_edit_invalid","error":"edit 载荷不合法：title 须为去首尾空白后 1..200 个字符且不含控制字符，body_md 必填，且目标必须是 article 载体"}\n`,
    );
  });

  it("目标不存在 → 404 item_not_found", async () => {
    const res = await post(GA, { action: "remove", item_id: "article/nope" });
    expect(res.status).toBe(404);
    expect(text(res)).toBe(`{"code":"item_not_found","error":"目标 item_id 不存在"}\n`);
  });

  it("目标归自己所有 → 403 item_self_owned", async () => {
    const res = await post(GA, { action: "remove", item_id: "article/mine" });
    expect(res.status).toBe(403);
    expect(text(res)).toBe(
      `{"code":"item_self_owned","error":"不能治理自己的条目，请改用 POST /v1/submit"}\n`,
    );
  });

  it("动作与目标 state 不匹配 → 400 item_state_mismatch", async () => {
    const res = await post(GA, { action: "revive", item_id: "article/victim" });
    expect(res.status).toBe(400);
    expect(text(res)).toBe(`{"code":"item_state_mismatch","error":"动作与目标当前 state 不匹配"}\n`);
  });

  it("提案人不在名册内 → 403 proposer_not_governor", async () => {
    const res = await post(GHOST, { action: "remove", item_id: "article/victim" });
    expect(res.status).toBe(403);
    expect(text(res)).toBe(`{"code":"proposer_not_governor","error":"提案人不在本节点名册内"}\n`);
  });

  it("remove 直角 201：键序与值逐字节", async () => {
    const res = await post(GA, { action: "remove", item_id: "article/victim" });
    expect(res.status).toBe(201);
    const row = db.select(
      `SELECT proposal_id FROM govern_proposals WHERE item_id=? ORDER BY proposal_id DESC LIMIT 1`,
      ["article/victim"],
    );
    const pid = String(row[0].proposal_id);
    expect(text(res)).toBe(
      `{"action":"remove","item_id":"article/victim","proposal_id":"${pid}","status":"pending","threshold":3,"vote_count":1}\n`,
    );
  });

  it("edit（article）直角 201：threshold 2", async () => {
    const res = await post(GA, {
      action: "edit",
      item_id: "article/victim",
      edit: { title: "New Title", body_md: "new body" },
    });
    expect(res.status).toBe(201);
    const row = db.select(
      `SELECT proposal_id,title,body_md FROM govern_proposals WHERE item_id=? ORDER BY proposal_id DESC LIMIT 1`,
      ["article/victim"],
    );
    const pid = String(row[0].proposal_id);
    expect(String(row[0].title)).toBe("New Title");
    expect(String(row[0].body_md)).toBe("new body");
    expect(text(res)).toBe(
      `{"action":"edit","item_id":"article/victim","proposal_id":"${pid}","status":"pending","threshold":2,"vote_count":1}\n`,
    );
  });

  it("title+body_md 超过 32768 字节 → 413 proposal_too_large", async () => {
    const res = await post(GA, {
      action: "edit",
      item_id: "article/victim",
      edit: { title: "T", body_md: "a".repeat(32768) },
    });
    expect(res.status).toBe(413);
    expect(text(res)).toBe(
      `{"code":"proposal_too_large","error":"title 与 body_md 的字节之和超过 32768"}\n`,
    );
  });
});

describe("POST /v1/proposal directory_add", () => {
  it("载荷非法（edit 同现 / kind 非法 / term_key 不符）→ 400 proposal_directory_invalid", async () => {
    const cases: Record<string, unknown>[] = [
      {
        action: "directory_add",
        directory: { kind: "tag", term_key: "golang", display_name: "Golang" },
        edit: { title: "x" },
      },
      { action: "directory_add", directory: { kind: "bogus", term_key: "x", display_name: "X" } },
      { action: "directory_add", directory: { kind: "tag", term_key: "wrong", display_name: "Golang" } },
    ];
    for (const body of cases) {
      const res = await post(GA, body);
      expect(res.status).toBe(400);
      expect(text(res)).toBe(
        `{"code":"proposal_directory_invalid","error":"directory 载荷不合法：kind 须为 category/instructor/tag，display_name 规范化后须与 term_key 一致"}\n`,
      );
    }
  });

  it("同键已 approved → 200 短路 merged/effective", async () => {
    const res = await post(GA, {
      action: "directory_add",
      directory: { kind: "tag", term_key: "golang", display_name: "Golang" },
    });
    expect(res.status).toBe(200);
    const itemId = directoryProposalItemId("tag", "golang");
    expect(text(res)).toBe(
      `{"action":"directory_add","item_id":"${itemId}","merged":true,"status":"effective"}\n`,
    );
    const rows = db.select(`SELECT 1 FROM govern_proposals WHERE item_id=?`, [itemId]);
    expect(rows.length).toBe(0);
  });

  it("同键已有 pending 提案 → 200 归并，返回既有 proposal_id 与有效票", async () => {
    const res = await post(GA, {
      action: "directory_add",
      directory: { kind: "tag", term_key: "mergekey", display_name: "Mergekey" },
    });
    expect(res.status).toBe(200);
    const itemId = directoryProposalItemId("tag", "mergekey");
    expect(text(res)).toBe(
      `{"action":"directory_add","item_id":"${itemId}","merged":true,"proposal_id":"100","status":"pending","threshold":1,"vote_count":1}\n`,
    );
  });

  it("小节点（名册 3 < 10）自动批准 → 201 effective、threshold 1", async () => {
    const res = await post(GA, {
      action: "directory_add",
      directory: { kind: "tag", term_key: "autokey", display_name: "Autokey" },
    });
    expect(res.status).toBe(201);
    const itemId = directoryProposalItemId("tag", "autokey");
    const row = db.select(
      `SELECT proposal_id FROM govern_proposals WHERE item_id=? ORDER BY proposal_id DESC LIMIT 1`,
      [itemId],
    );
    const pid = String(row[0].proposal_id);
    expect(text(res)).toBe(
      `{"action":"directory_add","item_id":"${itemId}","proposal_id":"${pid}","status":"effective","threshold":1,"vote_count":1}\n`,
    );
    // 自动批准同时写 directory_terms（state=approved）。
    const term = db.select(`SELECT state FROM directory_terms WHERE kind=? AND term_key=?`, ["tag", "autokey"]);
    expect(String(term[0].state)).toBe("approved");
  });

  it("normalizeTermKey 全角折半角后与 term_key 一致方可放行", async () => {
    expect(normalizeTermKey("ＧＯＬＡＮＧ")).toBe("golang");
    const res = await post(GA, {
      action: "directory_add",
      directory: { kind: "tag", term_key: "golang", display_name: "ＧＯＬＡＮＧ" },
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/proposal/{id}/vote", () => {
  let pA = "";
  let pB = "";

  it("空体放行 → 200 pending（未达门槛）", async () => {
    pA = await createRemoveProposal("article/t1");
    const res = await vote(pA, GB, "");
    expect(res.status).toBe(200);
    const j = jsonOf(res);
    expect(j.status).toBe("pending");
    expect(Number(j.quorum)).toBe(3); // m=3, threshold=11 → quorum=min(11,3)=3
    expect(Number(j.voter_count)).toBe(2); // 自投 + GB
  });

  it("{} 放行 → 200", async () => {
    pB = await createRemoveProposal("article/t2");
    const res = await vote(pB, GB, "{}");
    expect(res.status).toBe(200);
    const j = jsonOf(res);
    expect(j.status).toBe("pending");
    expect(Number(j.voter_count)).toBe(2);
  });

  it("null 放行 → 200", async () => {
    const pC = await createRemoveProposal("article/t3");
    const res = await vote(pC, GB, "null");
    expect(res.status).toBe(200);
    const j = jsonOf(res);
    expect(j.status).toBe("pending");
    expect(Number(j.voter_count)).toBe(2);
  });

  it("携带 id 字段 → 400 author_id_forbidden", async () => {
    const res = await vote(pA, GB, '{"id":1}');
    expect(res.status).toBe(400);
    expect(text(res)).toBe(
      `{"code":"author_id_forbidden","error":"请求体不得携带身份字段（author_id / proposer_id / id 等）"}\n`,
    );
  });

  it("proposal_id 非法 → 404 proposal_not_found", async () => {
    const res = await vote("abc", GB, "");
    expect(res.status).toBe(404);
    expect(text(res)).toBe(`{"code":"proposal_not_found","error":"提案不存在"}\n`);
  });

  it("提案不存在 → 404 proposal_not_found", async () => {
    const res = await vote("999999", GB, "");
    expect(res.status).toBe(404);
    expect(text(res)).toBe(`{"code":"proposal_not_found","error":"提案不存在"}\n`);
  });

  it("投票人不在名册内 → 403 voter_not_governor", async () => {
    const res = await vote(pA, GHOST, "");
    expect(res.status).toBe(403);
    expect(text(res)).toBe(`{"code":"voter_not_governor","error":"投票人不在本节点名册内"}\n`);
  });

  it("V2 允许同 voter 多次投 → 200", async () => {
    // V2 主键自增不再拒绝同 voter 重投（可反悔 vote_type）
    const res = await vote(pA, GA, '{"vote_type":"reject"}');
    expect(res.status).toBe(200);
    const j = jsonOf(res);
    // GA 自投(approve)+GA 重投(reject)+GB(approve) → voter_count=2（distinct），approve=2, reject=1
    expect(Number(j.voter_count)).toBe(2);
    expect(Number(j.approve_weight)).toBe(2);
    expect(Number(j.reject_weight)).toBe(1);
    expect(Number(j.net_weight)).toBe(1);
  });

  it("达到 quorum + net>0 → 200 effective", async () => {
    const res = await vote(pB, GC, "");
    expect(res.status).toBe(200);
    const j = jsonOf(res);
    expect(j.status).toBe("effective");
    expect(Number(j.voter_count)).toBe(3);
    expect(Number(j.net_weight)).toBe(3);
    // 生效动作已执行：目标条目 state=removed、墓碑落库。
    const it0 = db.select(`SELECT state FROM items WHERE item_id=?`, ["article/t2"]);
    expect(String(it0[0].state)).toBe("removed");
    expect(db.select(`SELECT 1 FROM tombstones WHERE item_id=?`, ["article/t2"]).length).toBe(1);
  });
});

describe("GET /v1/proposal", () => {
  let dir2: string;
  let db2: Db;

  beforeAll(() => {
    dir2 = mkdtempSync(join(tmpdir(), "base-node-proposallist-"));
    db2 = openDb(join(dir2, "base.db"));
    for (const stmt of TABLES) db2.execute(stmt);
    // 名册 = {G}（给一条达标 article）。
    const G = "a1".repeat(16);
    db2.execute(
      `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["article/gov", "src", "article", "article/gov", "", "hg", "articles", "public", "active", "t", G, ""],
    );
    db2.execute(
      `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev) VALUES(?,?,?,?,?,?,?,?)`,
      ["article/gov", "T", "", "", "[]", "x".repeat(200), "hg", ""],
    );
  });

  afterAll(() => {
    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  function list(): Promise<ServerResponse> {
    const req = {
      method: "GET",
      path: "/v1/proposal",
      params: {},
      query: {},
      headers: {},
      body: new Uint8Array(0),
    } as ServerRequest;
    return proposalListHandler({ db: db2, storeKey: null })(req);
  }

  it("空列表 → {\"proposals\":[]}", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(text(res)).toBe(`{"proposals":[]}\n`);
  });

  it("多提案：proposalDTO 字段全量 + 键序逐字节", async () => {
    const G = "a1".repeat(16);
    db2.execute(
      `INSERT INTO govern_proposals(proposal_id,action,item_id,proposer_id,reason,title,body_md,links_json,base_content_hash,created_at,executed_at,voided_at,executed_result,source_event_id,content_version,revoked_rev)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [1, "remove", "article/x", "p1", "r1", "T1", "", "", "hb", 1000, 0, 0, "", null, 7, 0],
    );
    db2.execute(`INSERT INTO govern_votes(proposal_id,voter_id,created_at,source_event_id) VALUES(?,?,?,?)`, [
      1,
      G,
      1001,
      null,
    ]);
    db2.execute(
      `INSERT INTO govern_proposals(proposal_id,action,item_id,proposer_id,reason,title,body_md,links_json,base_content_hash,created_at,executed_at,voided_at,executed_result,source_event_id,content_version,revoked_rev)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [2, "directory_add", "dir/tag/0000000000000000", "p2", "", "T2", "", "", "hc", 2000, 0, 0, "", null, 0, 0],
    );

    const res = await list();
    expect(res.status).toBe(200);
    expect(text(res)).toBe(
      `{"proposals":[` +
        `{"proposal_id":"1","action":"remove","item_id":"article/x","proposer_id":"p1","reason":"r1","title":"T1","body_md":"","status":"pending","votes":["${G}"],"vote_count":1,"threshold":3,"created_at":1000,"executed_at":0,"voided_at":0,"content_version":7,"revoked_rev":0},` +
        `{"proposal_id":"2","action":"directory_add","item_id":"dir/tag/0000000000000000","proposer_id":"p2","reason":"","title":"T2","body_md":"","status":"pending","votes":[],"vote_count":0,"threshold":2,"created_at":2000,"executed_at":0,"voided_at":0,"content_version":0,"revoked_rev":0}` +
        `]}\n`,
    );
  });
});

describe("decode.ts opt 指针三态", () => {
  const SPEC: StrictSpec = {
    edit: opt({ title: "string", body_md: opt("string"), links: listOf({ target_id: "string" }) }),
  };

  function dec(bodyText: string): StrictResult {
    const req = {
      method: "POST",
      path: "/x",
      params: {},
      query: {},
      headers: {},
      body: new Uint8Array(Buffer.from(bodyText, "utf8")),
    } as ServerRequest;
    return decodeStrict(req, SPEC);
  }

  function editOf(res: StrictResult): Record<string, unknown> {
    if (!res.ok) throw new Error("expected ok");
    return res.value.edit as Record<string, unknown>;
  }

  it("键缺失 → edit = null（Go nil 指针）", () => {
    expect(editOf(dec("{}"))).toBe(null);
  });

  it("显式 null → edit = null", () => {
    expect(editOf(dec(`{"edit":null}`))).toBe(null);
  });

  it("对象 → 逐字段解码；body_md 缺失 → null", () => {
    const e = editOf(dec(`{"edit":{"title":"x"}}`));
    expect(e.title).toBe("x");
    expect(e.body_md).toBe(null);
  });

  it("对象含 body_md 字符串 → 保留值", () => {
    const e = editOf(dec(`{"edit":{"title":"x","body_md":"y"}}`));
    expect(e.body_md).toBe("y");
  });

  it("edit 为字符串（类型不符）→ 400 bad_json", () => {
    const res = dec(`{"edit":"s"}`);
    expect(res.ok).toBe(false);
    expect(text((res as { resp: ServerResponse }).resp)).toBe(`{"error":"bad_json"}\n`);
  });

  it("body_md 为数字（类型不符）→ 400 bad_json", () => {
    const res = dec(`{"edit":{"title":"x","body_md":123}}`);
    expect(res.ok).toBe(false);
    expect(text((res as { resp: ServerResponse }).resp)).toBe(`{"error":"bad_json"}\n`);
  });
});
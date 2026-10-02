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

const ITEMS_DDL = `CREATE TABLE items(
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
	base_content_hash TEXT    NOT NULL,
	created_at        INTEGER NOT NULL,
	executed_at       INTEGER NOT NULL DEFAULT 0,
	voided_at         INTEGER NOT NULL DEFAULT 0,
	executed_result   TEXT    NOT NULL DEFAULT '',
	source_event_id   TEXT,
	content_version   INTEGER NOT NULL DEFAULT 0,
	revoked_rev       INTEGER NOT NULL DEFAULT 0
)`;
const VOTES_DDL = `CREATE TABLE govern_votes(
	proposal_id INTEGER NOT NULL,
	voter_id    TEXT    NOT NULL,
	created_at  INTEGER NOT NULL,
	source_event_id TEXT,
	PRIMARY KEY(proposal_id, voter_id)
)`;

const V = "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv";
const DIR_ITEM = "dir/tag/0123456789abcdef";

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
  dir = mkdtempSync(join(tmpdir(), "base-node-directory-"));
  db = openDb(join(dir, "base.db"));
  db.execute(ITEMS_DDL);
  db.execute(ARTICLES_DDL);
  db.execute(QUIZZES_DDL);
  db.execute(MEDIA_DDL);
  db.execute(META_DDL);
  db.execute(TOMBSTONES_DDL);
  db.execute(DIRECTORY_DDL);
  db.execute(PROPOSALS_DDL);
  db.execute(VOTES_DDL);

  // 名册：给投票人 V 一条达标 article，使 roster={V}、rosterOK=true。
  db.execute(
    `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ["art-v", "src", "article", "T", "r", "h", "articles", "public", "active", "2024-01-01T00:00:00Z", V, ""],
  );
  db.execute(
    `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev) VALUES(?,?,?,?,?,?,?,?)`,
    ["art-v", "T", "", "", "[]", "x".repeat(200), "h", "r"],
  );

  // 目录版本 5；approved 一行 + 一行 pending（pending 态词条不得出现在 approved）。
  db.execute(`INSERT INTO meta(key,value) VALUES(?,?)`, ["directory_version", "5"]);
  db.execute(
    `INSERT INTO directory_terms(kind,term_key,display_name,state,first_author_id,created_at,updated_at)
			VALUES(?,?,?,?,?,?,?)`,
    ["category", "go", "Go", "approved", "", "t", "t"],
  );
  db.execute(
    `INSERT INTO directory_terms(kind,term_key,display_name,state,first_author_id,created_at,updated_at)
			VALUES(?,?,?,?,?,?,?)`,
    ["tag", "zzz", "Zzz", "pending", "", "t", "t"],
  );

  // 未定案 directory_add 提案（pending）+ 名册内的一票。
  db.execute(
    `INSERT INTO govern_proposals(proposal_id,action,item_id,proposer_id,reason,title,body_md,links_json,base_content_hash,created_at,executed_at,voided_at,executed_result,source_event_id,content_version,revoked_rev)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [1, "directory_add", DIR_ITEM, V, "", "Golang", "golang", "", "h", 1000, 0, 0, "", null, 0, 0],
  );
  db.execute(`INSERT INTO govern_votes(proposal_id,voter_id,created_at,source_event_id) VALUES(?,?,?,?)`, [
    1,
    V,
    1001,
    null,
  ]);

  listener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0, dataDir: dir });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /v1/directory", () => {
  it("version 未变 → 短路 {unchanged,version}", async () => {
    const res = await request(`${base}/v1/directory?version=5`);
    const body = `{"unchanged":true,"version":5}\n`;
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("version 不等 → 全量 approved + pending", async () => {
    const res = await request(`${base}/v1/directory?version=4`);
    const body =
      `{"version":5,"approved":[{"kind":"category","term_key":"go","display_name":"Go"}],` +
      `"pending":[{"kind":"tag","term_key":"golang","display_name":"Golang","votes":1,"threshold":1}]}\n`;
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("无 version → 全量", async () => {
    const res = await request(`${base}/v1/directory`);
    const body =
      `{"version":5,"approved":[{"kind":"category","term_key":"go","display_name":"Go"}],` +
      `"pending":[{"kind":"tag","term_key":"golang","display_name":"Golang","votes":1,"threshold":1}]}\n`;
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(body);
  });
});

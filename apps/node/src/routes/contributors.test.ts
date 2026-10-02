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
const PROFILES_DDL = `CREATE TABLE profiles(
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	updated_at INTEGER NOT NULL
)`;

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "cccccccccccccccccccccccccccccccc";
const D = "dddddddddddddddddddddddddddddddd";
const E = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const F = "ffffffffffffffffffffffffffffffff";

const BODY_200 = "x".repeat(200);
const BODY_199 = "y".repeat(199);

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

function itemRow(db: Db, id: string, type: string, author: string, state = "active"): void {
  db.execute(
    `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, "src", type, "T", "r", "h", type, "public", state, "2024-01-01T00:00:00Z", author, ""],
  );
}

let dir: string;
let emptyDir: string;
let db: Db;
let emptyDb: Db;
let listener: Listener;
let emptyListener: Listener;
let base: string;
let emptyBase: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-contributors-"));
  db = openDb(join(dir, "base.db"));
  db.execute(ITEMS_DDL);
  db.execute(ARTICLES_DDL);
  db.execute(QUIZZES_DDL);
  db.execute(MEDIA_DDL);
  db.execute(PROFILES_DDL);

  // A：article 恰好 200 非空白 rune（过门槛）→ count 1。
  itemRow(db, "art-ok", "article", A);
  db.execute(
    `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev) VALUES(?,?,?,?,?,?,?,?)`,
    ["art-ok", "T", "", "", "[]", BODY_200, "h", "r"],
  );
  // B：article 仅 199 非空白 rune（差 1 未达门槛）→ 不计。
  itemRow(db, "art-no", "article", B);
  db.execute(
    `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev) VALUES(?,?,?,?,?,?,?,?)`,
    ["art-no", "T", "", "", "[]", BODY_199, "h", "r"],
  );
  // C：video duration = 60（过门槛）→ count 1。
  itemRow(db, "vid-ok", "video", C);
  db.execute(
    `INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json) VALUES(?,?,?,?,?,?)`,
    ["vid-ok", "video/mp4", 1, 60, 1, "[]"],
  );
  // D：video duration = 59（未达门槛）→ 不计。
  itemRow(db, "vid-no", "video", D);
  db.execute(
    `INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json) VALUES(?,?,?,?,?,?)`,
    ["vid-no", "video/mp4", 1, 59, 1, "[]"],
  );
  // E：quiz 3 题（过门槛）→ count 1。
  itemRow(db, "quiz-ok", "quiz", E);
  db.execute(`INSERT INTO quizzes(item_id,question_json,content_hash) VALUES(?,?,?)`, [
    "quiz-ok",
    `{"questions":[{},{},{}]}`,
    "h",
  ]);
  // F：quiz 2 题（未达门槛）→ 不计。
  itemRow(db, "quiz-no", "quiz", F);
  db.execute(`INSERT INTO quizzes(item_id,question_json,content_hash) VALUES(?,?,?)`, [
    "quiz-no",
    `{"questions":[{},{}]}`,
    "h",
  ]);
  // 仅 A 有昵称；其余回退 id 前 8 位。
  db.execute(`INSERT INTO profiles(id,name,updated_at) VALUES(?,?,?)`, [A, "Alice", 1]);

  emptyDir = mkdtempSync(join(tmpdir(), "base-node-contributors-empty-"));
  emptyDb = openDb(join(emptyDir, "base.db"));
  emptyDb.execute(ITEMS_DDL);
  emptyDb.execute(ARTICLES_DDL);
  emptyDb.execute(QUIZZES_DDL);
  emptyDb.execute(MEDIA_DDL);
  emptyDb.execute(PROFILES_DDL);

  listener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0, dataDir: dir });
  emptyListener = await startServer(adapters(), emptyDb, {
    host: "127.0.0.1",
    port: 0,
    dataDir: emptyDir,
  });
  base = `http://${listener.addr()}`;
  emptyBase = `http://${emptyListener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  await emptyListener.close();
  db.close();
  emptyDb.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("GET /v1/contributors", () => {
  it("空名册 → {\"contributors\":[]}", async () => {
    const res = await request(`${emptyBase}/v1/contributors`);
    const body = `{"contributors":[]}\n`;
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("过门槛的三条（article/video/quiz）按 id 升序 + 昵称回退", async () => {
    const res = await request(`${base}/v1/contributors`);
    const body =
      `{"contributors":[` +
      `{"id":"${A}","count":1,"name":"Alice"},` +
      `{"id":"${C}","count":1,"name":"${C.slice(0, 8)}"},` +
      `{"id":"${E}","count":1,"name":"${E.slice(0, 8)}"}` +
      `]}\n`;
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.toString("utf8")).toBe(body);
  });
});

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Listener, ServerAdapters } from "@base/core-ts";
import { openDb, type Db } from "./db";
import { createHttpServerAdapter } from "./host/http";
import { createTlsAdapter } from "./host/tls";
import { createSchedulerAdapter } from "./host/scheduler";
import { createCliHost } from "./host/cli";
import { createLifecycleAdapter } from "./host/lifecycle";
import { startServer } from "./serve";

// 列取自 internal/store/schema.go 的 items（含迁移补的 author_id/author_sig）与 packs。
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

const PACKS_DDL = `CREATE TABLE packs(
	pack_id         TEXT PRIMARY KEY,
	content_version INTEGER NOT NULL,
	dir             TEXT NOT NULL,
	merkle_root     TEXT NOT NULL,
	signature       TEXT NOT NULL,
	issued_at       TEXT NOT NULL,
	item_count      INTEGER NOT NULL,
	created_at      TEXT NOT NULL
)`;

// events 表：#79 §5.2 起 catalog 每页要按页聚合 like_count（store/like.ts），库内须有此表。
const EVENTS_DDL = `CREATE TABLE events(
	event_id    TEXT PRIMARY KEY,
	id          TEXT NOT NULL,
	type        TEXT NOT NULL,
	body_json   TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	received_at INTEGER NOT NULL,
	target_id   TEXT,
	payload_cid TEXT,
	reply_to    TEXT
)`;

interface HttpResponse {
  status: number;
  contentType: string | undefined;
  body: string;
}

function get(url: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      })
      .on("error", reject);
  });
}

let dir: string;
let db: Db;
let listener: Listener;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-"));
  db = openDb(join(dir, "base.db"));
  db.execute(ITEMS_DDL);
  db.execute(PACKS_DDL);
  db.execute(EVENTS_DDL);

  const adapters: ServerAdapters = {
    http: createHttpServerAdapter(),
    tls: createTlsAdapter(),
    scheduler: createSchedulerAdapter(),
    cli: createCliHost(),
    lifecycle: createLifecycleAdapter(),
  };
  listener = await startServer(adapters, db, { host: "127.0.0.1", port: 0 });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("冒烟：真实 listen + HTTP 请求", () => {
  it("GET /healthz", async () => {
    const res = await get(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/json; charset=utf-8");
    expect(res.body).toBe(`{"ok":true,"version":"0.1.0"}\n`);
  });

  it("空库 GET /v1/catalog", async () => {
    const res = await get(`${base}/v1/catalog`);
    expect(res.status).toBe(200);
    expect(res.body).toBe(`{"pack_id":"","content_version":0,"items":[],"next_cursor":null}\n`);
  });

  it("未知路由 → 404", async () => {
    const res = await get(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(res.body).toBe("404 page not found\n");
  });

  it("插入后只返回 active+public，版本取自 packs", async () => {
    db.execute(
      `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        "a-1",
        "src",
        "article",
        "A",
        "r1",
        "h1",
        "articles",
        "public",
        "active",
        "2024-01-01T00:00:00Z",
        "",
        "",
      ],
    );
    db.execute(
      `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        "b-1",
        "src",
        "article",
        "B",
        "r2",
        "h2",
        "articles",
        "public",
        "tombstone",
        "2024-01-01T00:00:00Z",
        "",
        "",
      ],
    );
    db.execute(
      `INSERT INTO packs(pack_id,content_version,dir,merkle_root,signature,issued_at,item_count,created_at)
			VALUES(?,?,?,?,?,?,?,?)`,
      ["pack-7", 7, "d", "m", "s", "2024-01-02T00:00:00Z", 1, "2024-01-02T00:00:00Z"],
    );

    const res = await get(`${base}/v1/catalog`);
    expect(res.status).toBe(200);
    expect(res.body).toBe(
      `{"pack_id":"pack-7","content_version":7,"items":[{"item_id":"a-1","source":"src","type":"article","title":"A","content_hash":"h1","source_rev":"r1","like_count":0}],"next_cursor":null}\n`,
    );
  });

  it("since 已最新 → 短路空响应", async () => {
    const res = await get(`${base}/v1/catalog?since=7`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { items: unknown[]; next_cursor: unknown };
    expect(body.items).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("条目对象内联 like_count：有赞=实际数、unlike 后回落 0（#79 §5.2）", async () => {
    const insertItem = (itemId: string, title: string, hash: string, rev: string): void => {
      db.execute(
        `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
				VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [itemId, "src", "article", title, rev, hash, "articles", "public", "active", "2024-01-03T00:00:00Z", "", ""],
      );
    };
    const insertLike = (eventId: string, actor: string, target: string, action: string, at: number): void => {
      db.execute(
        `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
				VALUES(?,?,?,?,?,?,?,?,?)`,
        [eventId, actor, "like.v1", `{"action":"${action}","target_id":"${target}","sig":"00"}`, at, at, target, "", null],
      );
    };
    // a-2：A、B 各赞 → 2；a-3：A 赞后 unlike → 0（§4.1 LWW）。已墓碑的 b-1 不进可见集也不聚合。
    insertItem("a-2", "C", "h3", "r3");
    insertItem("a-3", "D", "h4", "r4");
    insertLike("1".repeat(32), "A", "a-2", "like", 2000);
    insertLike("2".repeat(32), "B", "a-2", "like", 2001);
    insertLike("3".repeat(32), "A", "a-3", "like", 2002);
    insertLike("4".repeat(32), "A", "a-3", "unlike", 2003);

    const res = await get(`${base}/v1/catalog`);
    expect(res.status).toBe(200);
    expect(res.body).toBe(
      `{"pack_id":"pack-7","content_version":7,"items":[` +
        `{"item_id":"a-1","source":"src","type":"article","title":"A","content_hash":"h1","source_rev":"r1","like_count":0},` +
        `{"item_id":"a-2","source":"src","type":"article","title":"C","content_hash":"h3","source_rev":"r3","like_count":2},` +
        `{"item_id":"a-3","source":"src","type":"article","title":"D","content_hash":"h4","source_rev":"r4","like_count":0}` +
        `],"next_cursor":null}\n`,
    );
    // 条目行键集恰为七个，零 report / likers 键（§5.4）。
    const parsed = JSON.parse(res.body) as { items: Array<Record<string, unknown>> };
    for (const row of parsed.items) {
      expect(Object.keys(row).sort()).toEqual([
        "content_hash",
        "item_id",
        "like_count",
        "source",
        "source_rev",
        "title",
        "type",
      ]);
    }
  });
});

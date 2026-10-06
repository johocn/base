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
const TOMBSTONE_DDL = `CREATE TABLE comment_tombstone(
	event_id    TEXT PRIMARY KEY,
	payload_cid TEXT NOT NULL,
	reason      TEXT,
	at          INTEGER NOT NULL,
	received_at INTEGER NOT NULL
)`;

const A = "11111111111111111111111111111111";
const B = "22222222222222222222222222222222";
const C = "33333333333333333333333333333333";

const ROW_A = `{"event_id":"${A}","actor":"actorA","target_id":"t1","payload_cid":"pA","reply_to":null,"created_at":300,"like_count":0}`;
const ROW_B = `{"event_id":"${B}","actor":"actorB","target_id":"t1","payload_cid":"pB","reply_to":"r1","created_at":200,"like_count":0}`;
const ROW_C = `{"event_id":"${C}","actor":"actorC","target_id":"t1","payload_cid":"pC","reply_to":null,"created_at":100,"like_count":0}`;

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
  dir = mkdtempSync(join(tmpdir(), "base-node-comment-"));
  db = openDb(join(dir, "base.db"));
  db.execute(EVENTS_DDL);
  db.execute(TOMBSTONE_DDL);

  db.execute(
    `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
			VALUES(?,?,?,?,?,?,?,?,?)`,
    [A, "actorA", "comment.v1", "{}", 300, 300, "t1", "pA", null],
  );
  db.execute(
    `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
			VALUES(?,?,?,?,?,?,?,?,?)`,
    [B, "actorB", "comment.v1", "{}", 200, 200, "t1", "pB", "r1"],
  );
  // 空串 reply_to 与 NULL 同口径 → 输出 null。
  db.execute(
    `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
			VALUES(?,?,?,?,?,?,?,?,?)`,
    [C, "actorC", "comment.v1", "{}", 100, 100, "t1", "pC", ""],
  );

  listener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0, dataDir: dir });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /v1/comment", () => {
  it("默认 limit=30：倒序全量，不满页 next_cursor 为 null", async () => {
    const res = await request(`${base}/v1/comment`);
    const body = `{"comments":[${ROW_A},${ROW_B},${ROW_C}],"next_cursor":null}\n`;
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("limit=2：满页给游标", async () => {
    const res = await request(`${base}/v1/comment?limit=2`);
    const body = `{"comments":[${ROW_A},${ROW_B}],"next_cursor":"200_${B}"}\n`;
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("游标往返：带上页末条游标 → 取更旧的行", async () => {
    const res = await request(`${base}/v1/comment?limit=2&cursor=200_${B}`);
    const body = `{"comments":[${ROW_C}],"next_cursor":null}\n`;
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("非法/越界/非正的 limit 一律回落默认 30", async () => {
    const expected = `{"comments":[${ROW_A},${ROW_B},${ROW_C}],"next_cursor":null}\n`;
    for (const q of ["limit=0", "limit=-3", "limit=abc", "limit=101"]) {
      const res = await request(`${base}/v1/comment?${q}`);
      expect(res.status).toBe(200);
      expect(res.body.toString("utf8")).toBe(expected);
    }
  });

  it("非法游标按首页处理", async () => {
    const res = await request(`${base}/v1/comment?cursor=not-a-cursor`);
    const body = `{"comments":[${ROW_A},${ROW_B},${ROW_C}],"next_cursor":null}\n`;
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(body);
  });
});

// ---------- #79 §5.1：comment 读面内联 like_count（对齐 Go TestCommentListInlineLikeCount） ----------
describe("GET /v1/comment 内联 like_count", () => {
  // 独立库：上方用例是字节级 golden，这里另起一套种子避免串扰。
  const C1 = "a".repeat(32);
  const C2 = "b".repeat(32);
  let likeDir: string;
  let likeDb: Db;
  let likeListener: Listener;
  let likeBase: string;

  beforeAll(async () => {
    likeDir = mkdtempSync(join(tmpdir(), "base-node-comment-like-"));
    likeDb = openDb(join(likeDir, "base.db"));
    likeDb.execute(EVENTS_DDL);
    likeDb.execute(TOMBSTONE_DDL);

    const insert = (
      eventId: string,
      actor: string,
      type: string,
      body: string,
      createdAt: number,
      target: string,
    ): void => {
      likeDb.execute(
        `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
					VALUES(?,?,?,?,?,?,?,?,?)`,
        [eventId, actor, type, body, createdAt, createdAt, target, "", null],
      );
    };
    insert(C1, "actorA", "comment.v1", "{}", 300, "article/a");
    insert(C2, "actorB", "comment.v1", "{}", 200, "article/a");
    // A、B 各赞 c1 → 2；A 赞 c2 后 unlike → 0（§4.1 LWW）。
    insert("1".repeat(32), "A", "like.v1", `{"action":"like","target_id":"${C1}","sig":"00"}`, 1000, C1);
    insert("2".repeat(32), "B", "like.v1", `{"action":"like","target_id":"${C1}","sig":"00"}`, 1001, C1);
    insert("3".repeat(32), "A", "like.v1", `{"action":"like","target_id":"${C2}","sig":"00"}`, 1002, C2);
    insert("4".repeat(32), "A", "like.v1", `{"action":"unlike","target_id":"${C2}","sig":"00"}`, 1003, C2);
    // 举报事件在库，但公开读面绝不能出现任何 report 痕迹（§5.4）。
    insert("5".repeat(32), "C", "report.v1", `{"reason":"spam","target_id":"${C1}","sig":"00"}`, 1004, C1);

    likeListener = await startServer(adapters(), likeDb, { host: "127.0.0.1", port: 0, dataDir: likeDir });
    likeBase = `http://${likeListener.addr()}`;
  });

  afterAll(async () => {
    await likeListener.close();
    likeDb.close();
    rmSync(likeDir, { recursive: true, force: true });
  });

  it("有赞=实际数、unlike 后回落 0；公开行零 report 字段/零点赞者名单", async () => {
    const res = await request(`${likeBase}/v1/comment?target_id=article/a`);
    expect(res.status).toBe(200);
    const body =
      `{"comments":[` +
      `{"event_id":"${C1}","actor":"actorA","target_id":"article/a","payload_cid":"","reply_to":null,"created_at":300,"like_count":2},` +
      `{"event_id":"${C2}","actor":"actorB","target_id":"article/a","payload_cid":"","reply_to":null,"created_at":200,"like_count":0}` +
      `],"next_cursor":null}\n`;
    expect(res.body.toString("utf8")).toBe(body);
    // §5.4：公开行键集恰为七个，零 report / likers 键。
    const parsed = JSON.parse(res.body.toString("utf8")) as {
      comments: Array<Record<string, unknown>>;
    };
    for (const row of parsed.comments) {
      expect(Object.keys(row).sort()).toEqual([
        "actor",
        "created_at",
        "event_id",
        "like_count",
        "payload_cid",
        "reply_to",
        "target_id",
      ]);
    }
  });
});

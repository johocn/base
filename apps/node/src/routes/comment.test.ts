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

const ROW_A = `{"event_id":"${A}","actor":"actorA","target_id":"t1","payload_cid":"pA","reply_to":null,"created_at":300}`;
const ROW_B = `{"event_id":"${B}","actor":"actorB","target_id":"t1","payload_cid":"pB","reply_to":"r1","created_at":200}`;
const ROW_C = `{"event_id":"${C}","actor":"actorC","target_id":"t1","payload_cid":"pC","reply_to":null,"created_at":100}`;

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

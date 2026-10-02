// 审核面等价（批 G）：对齐 internal/httpapi/comment_test.go 的验收 9/10/11。
// 用真 startServer（真路由 + 真库 + 真块文件），逐字节比对状态与 JSON 体。
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Listener, ServerAdapters } from "@base/core-ts";
import { blobId } from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { loadStoreKey } from "../host/storekey";
import { createHttpServerAdapter } from "../host/http";
import { createTlsAdapter } from "../host/tls";
import { createSchedulerAdapter } from "../host/scheduler";
import { createCliHost } from "../host/cli";
import { createLifecycleAdapter } from "../host/lifecycle";
import { putBlob } from "../store/events";
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
const BLOBS_DDL = `CREATE TABLE blobs(
	blob_id    TEXT PRIMARY KEY,
	size       INTEGER NOT NULL,
	item_id    TEXT NOT NULL,
	seq        INTEGER NOT NULL,
	created_at TEXT NOT NULL
)`;

const REVIEW_KEY = "review-key";
const EV_OK = "1".repeat(32);
const EV_NO_PAYLOAD = "2".repeat(32);
const MISSING_CID = "0".repeat(32);

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end(body);
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
let withKey: string;
let noKey: string;
let cid: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-review-"));
  db = openDb(join(dir, "base.db"));
  db.execute(EVENTS_DDL);
  db.execute(TOMBSTONE_DDL);
  db.execute(BLOBS_DDL);

  const storeKey = loadStoreKey(dir, {}).key;
  const text = Buffer.from("待审正文", "utf8");
  cid = blobId(new Uint8Array(text));
  putBlob(db, dir, storeKey, cid, new Uint8Array(text), "comment:" + EV_OK, 0);

  const insertEvent = (id: string, payload: string): void => {
    db.execute(
      `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
				VALUES(?,?,?,?,?,?,?,?,?)`,
      [id, "actorA", "comment.v1", "{}", 300, 300, "t1", payload, null],
    );
  };
  insertEvent(EV_OK, cid);
  insertEvent(EV_NO_PAYLOAD, "");

  const l1: Listener = await startServer(adapters(), db, {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    reviewKey: REVIEW_KEY,
  });
  withKey = `http://${l1.addr()}`;
  const l2: Listener = await startServer(adapters(), db, {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
  });
  noKey = `http://${l2.addr()}`;
  listeners.push(l1, l2);
});

const listeners: Listener[] = [];

afterAll(async () => {
  for (const l of listeners) await l.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const HDR = { "X-Base-Review-Key": REVIEW_KEY };

describe("审核路由不存在 / 密钥不符", () => {
  it("未配置 reviewKey：两条路由均 404", async () => {
    const f = await post(`${noKey}/v1/admin/review/fetch`, `{"payload_cid":"${MISSING_CID}"}`);
    expect(f.status).toBe(404);
    const r = await post(`${noKey}/v1/admin/review/reject`, `{"event_id":"${EV_OK}"}`);
    expect(r.status).toBe(404);
  });

  it("密钥不符：404 {\"error\":\"not_found\"}（不暴露存在性）", async () => {
    const body = `{"error":"not_found"}\n`;
    for (const path of ["fetch", "reject"]) {
      const res = await post(`${withKey}/v1/admin/review/${path}`, "{}", {
        "X-Base-Review-Key": "wrong",
      });
      expect(res.status).toBe(404);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.toString("utf8")).toBe(body);
    }
  });
});

describe("POST /v1/admin/review/fetch", () => {
  it("取正文明文", async () => {
    const res = await post(`${withKey}/v1/admin/review/fetch`, `{"payload_cid":"${cid}"}`, HDR);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.body.toString("utf8")).toBe(`{"payload_cid":"${cid}","text":"待审正文"}\n`);
  });

  it("非法 payload_cid → 400 event_param_invalid", async () => {
    const res = await post(`${withKey}/v1/admin/review/fetch`, `{"payload_cid":"zz"}`, HDR);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("块不存在 → 404 blob_not_found", async () => {
    const res = await post(
      `${withKey}/v1/admin/review/fetch`,
      `{"payload_cid":"${MISSING_CID}"}`,
      HDR,
    );
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"blob_not_found"}\n`);
  });

  it("非法 JSON → 400 bad_json", async () => {
    const res = await post(`${withKey}/v1/admin/review/fetch`, "{", HDR);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"bad_json"}\n`);
  });
});

describe("POST /v1/admin/review/reject", () => {
  it("非法 event_id → 400 event_param_invalid", async () => {
    const res = await post(`${withKey}/v1/admin/review/reject`, `{"event_id":"zz"}`, HDR);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("未知 event_id → 404 event_not_found", async () => {
    const res = await post(`${withKey}/v1/admin/review/reject`, `{"event_id":"${MISSING_CID}"}`, HDR);
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_not_found"}\n`);
  });

  it("事件无 payload_cid → 404 event_not_found", async () => {
    const res = await post(
      `${withKey}/v1/admin/review/reject`,
      `{"event_id":"${EV_NO_PAYLOAD}"}`,
      HDR,
    );
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_not_found"}\n`);
  });

  it("审核删：写墓碑 + 删块 + 返回 echo", async () => {
    const res = await post(
      `${withKey}/v1/admin/review/reject`,
      `{"event_id":"${EV_OK}","reason":"违规"}`,
      HDR,
    );
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(`{"event_id":"${EV_OK}","payload_cid":"${cid}"}\n`);

    // 墓碑已写，received_at 为墙钟（非 0）。
    const rows = db.select(
      `SELECT event_id,payload_cid,reason,received_at FROM comment_tombstone WHERE event_id=?`,
      [EV_OK],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].payload_cid).toBe(cid);
    expect(rows[0].reason).toBe("违规");
    expect(Number(rows[0].received_at)).toBeGreaterThan(0);

    // 块已删：blobs 行没了，取正文 404、取块 404。
    expect(db.select(`SELECT 1 FROM blobs WHERE blob_id=?`, [cid]).length).toBe(0);
    const fetch = await post(`${withKey}/v1/admin/review/fetch`, `{"payload_cid":"${cid}"}`, HDR);
    expect(fetch.status).toBe(404);
    const blob = await new Promise<Res>((resolve, reject) => {
      http
        .get(`${withKey}/v1/blob/${cid}`, (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }),
          );
        })
        .on("error", reject);
    });
    expect(blob.status).toBe(404);
  });

  it("审核删后 GET /v1/comment 不再返回该条", async () => {
    const res = await new Promise<Res>((resolve, reject) => {
      http
        .get(`${withKey}/v1/comment`, (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }),
          );
        })
        .on("error", reject);
    });
    expect(res.status).toBe(200);
    // 被审核删的 EV_OK 已从列表消失，仅剩另一条种子（无 payload_cid 的那条）。
    expect(res.body.toString("utf8")).toBe(
      `{"comments":[{"event_id":"${EV_NO_PAYLOAD}","actor":"actorA","target_id":"t1",` +
        `"payload_cid":"","reply_to":null,"created_at":300}],"next_cursor":null}\n`,
    );
  });
});
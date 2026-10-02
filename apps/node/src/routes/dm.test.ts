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

const PEER = "dddddddddddddddddddddddddddddddd";
const OTHER = "99999999999999999999999999999999";
const EMPTY_PEER = "77777777777777777777777777777777";
const D1 = "44444444444444444444444444444444";
const D2 = "55555555555555555555555555555555";

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
  dir = mkdtempSync(join(tmpdir(), "base-node-dm-"));
  db = openDb(join(dir, "base.db"));
  db.execute(EVENTS_DDL);

  db.execute(
    `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
			VALUES(?,?,?,?,?,?,?,?,?)`,
    [D1, "actorD1", "dm.v1", "{}", 500, 500, "dm/" + PEER, "pc1", null],
  );
  db.execute(
    `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
			VALUES(?,?,?,?,?,?,?,?,?)`,
    [D2, "actorD2", "dm.v1", "{}", 400, 400, "dm/" + PEER, "pc2", null],
  );
  // 干扰项：发给别的 peer 的事件不得出现。
  db.execute(
    `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
			VALUES(?,?,?,?,?,?,?,?,?)`,
    ["66666666666666666666666666666666", "actorX", "dm.v1", "{}", 900, 900, "dm/" + OTHER, "pcX", null],
  );

  listener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0, dataDir: dir });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /v1/dm/{peer_id}", () => {
  it("非法 peer_id → 400 event_param_invalid", async () => {
    const res = await request(`${base}/v1/dm/zz`);
    const body = `{"error":"event_param_invalid"}\n`;
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("31 字符（非 16 字节 hex）→ 400", async () => {
    const res = await request(`${base}/v1/dm/${PEER.slice(0, 31)}`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("查无即空数组（无 404 分支）", async () => {
    const res = await request(`${base}/v1/dm/${EMPTY_PEER}`);
    const body = `{"events":[],"next_cursor":null}\n`;
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("默认 limit=30：倒序全量", async () => {
    const res = await request(`${base}/v1/dm/${PEER}`);
    const body =
      `{"events":[` +
      `{"event_id":"${D1}","actor":"actorD1","created_at":500,"payload_cid":"pc1"},` +
      `{"event_id":"${D2}","actor":"actorD2","created_at":400,"payload_cid":"pc2"}` +
      `],"next_cursor":null}\n`;
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("limit=1 满页给游标；带游标取更旧的一页", async () => {
    const first = await request(`${base}/v1/dm/${PEER}?limit=1`);
    const firstBody = `{"events":[{"event_id":"${D1}","actor":"actorD1","created_at":500,"payload_cid":"pc1"}],"next_cursor":"500_${D1}"}\n`;
    expect(first.status).toBe(200);
    expect(first.body.toString("utf8")).toBe(firstBody);

    const second = await request(`${base}/v1/dm/${PEER}?limit=1&cursor=500_${D1}`);
    const secondBody = `{"events":[{"event_id":"${D2}","actor":"actorD2","created_at":400,"payload_cid":"pc2"}],"next_cursor":"400_${D2}"}\n`;
    expect(second.status).toBe(200);
    expect(second.body.toString("utf8")).toBe(secondBody);
  });
});

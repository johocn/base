// G3 双端对拍（#79 Task 11）：与 internal/httpapi/golden_like_test.go 共享同一份
// golden fixture（docs/superpowers/plans/fixtures/like-golden.json），
// 同数据集下 comment / catalog / reported 三读面 JSON 逐字段一致（JSON.parse 后 toEqual）。
// 固定数据集与 Go 侧逐字一致：pack v1 + 条目 article/a1 + 评论 c1/c2 + like/report 事件行
// （事件行直接 putEvent，读面不验签）。
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Listener, ServerAdapters } from "@base/core-ts";
import { openHostDb, type HostDb } from "./host/sqlite";
import { createHttpServerAdapter } from "./host/http";
import { createTlsAdapter } from "./host/tls";
import { createSchedulerAdapter } from "./host/scheduler";
import { createCliHost } from "./host/cli";
import { createLifecycleAdapter } from "./host/lifecycle";
import { putEvent } from "./store/events";
import { hostDbAsDb } from "./store/peersync";
import { migrate, schemaStatements } from "./store/schema";
import { startServer } from "./serve";

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../docs/superpowers/plans/fixtures/like-golden.json", import.meta.url)),
    "utf8",
  ),
) as { comment: unknown; catalog: unknown; reported: unknown };

const REVIEW_KEY = "review-key";
const ITEM = "article/a1";
const BODY_MD = "甲正文\n";
const CONTENT_HASH = createHash("sha256").update(BODY_MD).digest("hex");

/** 对齐 Go eventIDOf：%032x。 */
const h = (n: number): string => n.toString(16).padStart(32, "0");
const C1 = h(1);
const C2 = h(2);
const CID1 = "b".repeat(32);
const CID2 = "d".repeat(32);

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function get(url: string): Promise<Res> {
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
let host: HostDb;
let listener: Listener;
let base: string;

function seedEvent(
  eventId: string,
  id: string,
  type: string,
  body: string,
  createdAt: number,
  target: string,
  payloadCid = "",
  replyTo = "",
): void {
  putEvent(hostDbAsDb(host), {
    eventId,
    id,
    type,
    bodyJson: body,
    createdAt,
    receivedAt: createdAt,
    targetId: target,
    payloadCid,
    replyTo,
  });
}

const likeBody = (target: string, action: string): string =>
  `{"action":"${action}","sig":"00","target_id":"${target}"}`;
const reportBody = (target: string): string => `{"reason":"spam","sig":"00","target_id":"${target}"}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-golden-like-"));
  host = openHostDb(join(dir, "base.db"));
  for (const stmt of schemaStatements) host.exec(stmt);
  migrate(host);
  const db = hostDbAsDb(host);

  // 固定数据集：pack v1 + 条目 article/a1（active/public）。
  db.execute(
    `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [ITEM, "article", "article", "甲", "rev-1", CONTENT_HASH, "articles", "public", "active", "2026-01-02T00:00:00Z"],
  );
  db.execute(
    `INSERT INTO packs(pack_id,content_version,dir,merkle_root,signature,issued_at,item_count,created_at)
			VALUES(?,?,?,?,?,?,?,?)`,
    ["pack-golden-0001", 1, "packs/pack-golden-0001", "0".repeat(64), "golden", "2026-01-03T00:00:00Z", 1, "2026-01-03T00:00:00Z"],
  );

  // 评论两条：c1（300，2 赞 2 举报人）、c2（200，like+unlike 归零、1 举报）。
  seedEvent(C1, "actorA", "comment.v1", `{"sig":"00","target_id":"${ITEM}","text":"评论一"}`, 300, ITEM, CID1);
  seedEvent(C2, "actorB", "comment.v1", `{"sig":"00","target_id":"${ITEM}","text":"评论二"}`, 200, ITEM, CID2);
  // c1：A、B 各一赞 → 2；c2：A 赞后 unlike 取消 → 0（§4.1 LWW）。
  seedEvent(h(11), "A", "like.v1", likeBody(C1, "like"), 1000, C1);
  seedEvent(h(12), "B", "like.v1", likeBody(C1, "like"), 1001, C1);
  seedEvent(h(13), "A", "like.v1", likeBody(C2, "like"), 1002, C2);
  seedEvent(h(14), "A", "like.v1", likeBody(C2, "unlike"), 1003, C2);
  // 条目自身：A、B 各一赞 → catalog like_count=2。
  seedEvent(h(15), "A", "like.v1", likeBody(ITEM, "like"), 1004, ITEM);
  seedEvent(h(16), "B", "like.v1", likeBody(ITEM, "like"), 1005, ITEM);
  // c1 被 R1、R2 两人举报；c2 被 R3 举报 → reported 面 report_count 降序 c1 在前。
  seedEvent(h(21), "R1", "report.v1", reportBody(C1), 1006, C1);
  seedEvent(h(22), "R2", "report.v1", reportBody(C1), 1007, C1);
  seedEvent(h(23), "R3", "report.v1", reportBody(C2), 1008, C2);

  listener = await startServer(adapters(), db, {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    reviewKey: REVIEW_KEY,
  });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("G3 双端对拍：三读面与 golden 一致", () => {
  it("GET /v1/comment：like_count 内联（2 / 0），公开行零 report 痕迹", async () => {
    const res = await get(`${base}/v1/comment?target_id=${ITEM}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString("utf8"))).toEqual(GOLDEN.comment);
  });

  it("GET /v1/catalog：pack v1 + 条目 like_count=2", async () => {
    const res = await get(`${base}/v1/catalog`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString("utf8"))).toEqual(GOLDEN.catalog);
  });

  it("POST /v1/admin/review/reported：report_count 降序 + reporters 去重", async () => {
    const res = await post(`${base}/v1/admin/review/reported`, "{}", {
      "X-Base-Review-Key": REVIEW_KEY,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString("utf8"))).toEqual(GOLDEN.reported);
  });
});

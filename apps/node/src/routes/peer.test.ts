// routes/peer.ts 单测：逐条对齐 internal/httpapi/peer.go 的五路由语义。
// 建库风格参照 store/peersync.test.ts（临时目录 + schemaStatements + migrate）。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpServerAdapter, ServerRequest, ServerResponse } from "@base/core-ts";
import { blobId, merkleRoot, readBlobFrame } from "@base/protocol-ts";
import { encrypt } from "../host/aesgcm";
import { openHostDb, type HostDb } from "../host/sqlite";
import { parseStoreKey } from "../host/storekey";
import { putBlob } from "../store/events";
import {
  hostDbAsDb,
  listAllBlobIDs,
  putCommentTombstone,
} from "../store/peersync";
import { migrate, schemaStatements } from "../store/schema";
import {
  eventSyncHandler,
  fetchHandler,
  inventoryHandler,
  mountPeerRoutes,
  scrubHandler,
  syncHandler,
  type PeerDeps,
} from "./peer";

const KEY = parseStoreKey("a".repeat(64));

const B1 = "11".repeat(16);
const B2 = "22".repeat(16);
const B3 = "33".repeat(16);
const B_MISSING = "44".repeat(16); // 合法 id，但库/盘都没有

const opened: { db: HostDb; dir: string }[] = [];

function newEnv(): { db: HostDb; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "base-node-peer-"));
  const db = openHostDb(join(dir, "base.db"));
  for (const stmt of schemaStatements) db.exec(stmt);
  migrate(db);
  opened.push({ db, dir });
  return { db, dir };
}

afterEach(() => {
  while (opened.length > 0) {
    const { db, dir } = opened.pop() as { db: HostDb; dir: string };
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄释放竞态，忽略 */
    }
  }
});

function depsOf(db: HostDb, dir: string, fetchMaxBlobs = 64): PeerDeps {
  return { db, dataDir: dir, storeKey: KEY, fetchMaxBlobs };
}

function putBlobRow(db: HostDb, id: string, size: number, seq = 0): void {
  db.run(`INSERT INTO blobs(blob_id,size,item_id,seq,created_at) VALUES(?,?,?,?,?)`, [
    id,
    size,
    "item",
    seq,
    "2026-01-01T00:00:00Z",
  ]);
}

function blobFile(dir: string, id: string): string {
  return join(dir, "blobs", id.slice(0, 2), id.slice(2, 4), id);
}

function makeReq(opts: {
  method?: string;
  query?: Record<string, string>;
  body?: string | Uint8Array;
}): ServerRequest {
  const body =
    typeof opts.body === "string" ? new Uint8Array(Buffer.from(opts.body, "utf8")) : (opts.body ?? new Uint8Array(0));
  return {
    method: opts.method ?? "POST",
    path: "/",
    params: {},
    query: opts.query ?? {},
    headers: {},
    body,
  };
}

function jsonBody(res: ServerResponse): Record<string, unknown> {
  return JSON.parse(Buffer.from(res.body ?? new Uint8Array(0)).toString("utf8")) as Record<
    string,
    unknown
  >;
}

interface EventOpts {
  id?: string;
  type?: string;
}
function insertEvent(db: HostDb, eventId: string, receivedAt: number, o: EventOpts = {}): void {
  db.run(
    `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    [eventId, o.id ?? "u1", o.type ?? "comment.v1", "{}", receivedAt, receivedAt, null, null, null],
  );
}

// ==================== GET /v1/inventory ====================

describe("inventory", () => {
  it("分页翻页：limit 生效、next_cursor 推进、末页 null", async () => {
    const { db, dir } = newEnv();
    putBlobRow(db, B3, 30, 2);
    putBlobRow(db, B1, 10, 0);
    putBlobRow(db, B2, 20, 1);
    const h = inventoryHandler(depsOf(db, dir));

    const p1 = await h(makeReq({ method: "GET", query: { limit: "2" } }));
    expect(p1.status).toBe(200);
    expect(jsonBody(p1)).toEqual({
      content_version: 0,
      merkle_root: merkleRoot([B1, B2, B3]),
      blobs: [
        { blob_id: B1, size: 10 },
        { blob_id: B2, size: 20 },
      ],
      next_cursor: B2,
    });

    const p2 = await h(makeReq({ method: "GET", query: { limit: "2", cursor: B2 } }));
    expect(jsonBody(p2)).toEqual({
      content_version: 0,
      merkle_root: merkleRoot([B1, B2, B3]),
      blobs: [{ blob_id: B3, size: 30 }],
      next_cursor: null,
    });
  });

  it("since >= version 快路径：空 blobs 但带 merkle_root", async () => {
    const { db, dir } = newEnv();
    putBlobRow(db, B1, 10);
    putBlobRow(db, B2, 20);
    db.run(`INSERT INTO meta(key,value) VALUES('content_version','5')`);
    const h = inventoryHandler(depsOf(db, dir));

    const res = await h(makeReq({ method: "GET", query: { since: "5" } }));
    expect(res.status).toBe(200);
    expect(jsonBody(res)).toEqual({
      content_version: 5,
      merkle_root: merkleRoot([B1, B2]),
      blobs: [],
      next_cursor: null,
    });

    // since < version：正常分页
    const low = await h(makeReq({ method: "GET", query: { since: "4" } }));
    expect((jsonBody(low).blobs as unknown[]).length).toBe(2);
  });

  it("非法 limit 回落 500；limit=0 亦回落", async () => {
    const { db, dir } = newEnv();
    putBlobRow(db, B1, 1);
    putBlobRow(db, B2, 2);
    const h = inventoryHandler(depsOf(db, dir));
    for (const limit of ["abc", "0", "-1", "2001"]) {
      const res = await h(makeReq({ method: "GET", query: { limit } }));
      expect((jsonBody(res).blobs as unknown[]).length).toBe(2);
      expect(jsonBody(res).next_cursor).toBeNull();
    }
  });
});

// ==================== POST /v1/sync ====================

describe("sync", () => {
  it("equal true / false 两态", async () => {
    const { db, dir } = newEnv();
    putBlobRow(db, B1, 1);
    putBlobRow(db, B2, 2);
    const h = syncHandler(depsOf(db, dir));
    const root = merkleRoot([B1, B2]);

    const same = await h(
      makeReq({ body: JSON.stringify({ content_version: 9, merkle_root: root }) }),
    );
    expect(same.status).toBe(200);
    expect(jsonBody(same)).toEqual({ equal: true });

    const diff = await h(makeReq({ body: JSON.stringify({ merkle_root: "deadbeef" }) }));
    expect(jsonBody(diff)).toEqual({ equal: false });
  });

  it("非法 JSON → 400；裸 Decode 只解首值、不拒尾随（顶层 null 是 no-op）", async () => {
    const { db, dir } = newEnv();
    putBlobRow(db, B1, 1);
    const h = syncHandler(depsOf(db, dir));
    const root = merkleRoot([B1]);

    const bad = await h(makeReq({ body: "{" }));
    expect(bad.status).toBe(400);
    expect(jsonBody(bad)).toEqual({ error: "请求体不是合法 JSON" });

    // 尾随内容：Go Decoder 只解首值
    const trailing = await h(
      makeReq({ body: `{"merkle_root":"${root}"} trailing-garbage` }),
    );
    expect(trailing.status).toBe(200);
    expect(jsonBody(trailing)).toEqual({ equal: true });

    // 顶层 null：no-op 零值 → merkle_root "" ≠ root
    const nul = await h(makeReq({ body: "null" }));
    expect(jsonBody(nul)).toEqual({ equal: false });

    // 顶层数组 → 400
    const arr = await h(makeReq({ body: "[]" }));
    expect(arr.status).toBe(400);

    // 字段类型不符（字符串 → int64）→ 400
    const badType = await h(
      makeReq({ body: JSON.stringify({ content_version: "5", merkle_root: root }) }),
    );
    expect(badType.status).toBe(400);
  });
});

// ==================== POST /v1/fetch ====================

describe("fetch", () => {
  it("正常多块：逐帧 id/内容一致", async () => {
    const { db, dir } = newEnv();
    const d1 = new Uint8Array([1, 2, 3, 4, 5]);
    const d2 = new Uint8Array([9, 8, 7, 6]);
    const id1 = blobId(d1);
    const id2 = blobId(d2);
    const adb = hostDbAsDb(db);
    putBlob(adb, dir, KEY, id1, d1, "item", 0);
    putBlob(adb, dir, KEY, id2, d2, "item", 1);

    const res = await fetchHandler(depsOf(db, dir))(
      makeReq({ body: JSON.stringify({ blob_ids: [id1, id2] }) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("application/x-base-blobpack");
    expect(res.headers?.["Cache-Control"]).toBe("no-store");

    const body = res.body as Uint8Array;
    const frames: { blobId: string; payload: Uint8Array }[] = [];
    let off = 0;
    for (;;) {
      const f = readBlobFrame(body, off);
      if (f === null) break;
      frames.push({ blobId: f.blobId, payload: f.payload });
      off = f.next;
    }
    expect(frames.map((f) => f.blobId)).toEqual([id1, id2]);
    expect(Array.from(frames[0].payload)).toEqual(Array.from(d1));
    expect(Array.from(frames[1].payload)).toEqual(Array.from(d2));
  });

  it("本节点没有的块整帧跳过；已撤销块不返回", async () => {
    const { db, dir } = newEnv();
    const d1 = new Uint8Array([5, 6, 7]);
    const d2 = new Uint8Array([8, 9, 10]);
    const keep = blobId(d1);
    const dead = blobId(d2);
    const adb = hostDbAsDb(db);
    putBlob(adb, dir, KEY, keep, d1, "item", 0);
    putBlob(adb, dir, KEY, dead, d2, "item", 1);
    putCommentTombstone(db, { eventId: "e1", payloadCid: dead, reason: "spam", at: 0, receivedAt: 1 });

    // 缺块（B_MISSING）+ 已撤销（dead）+ 正常（keep）
    const res = await fetchHandler(depsOf(db, dir))(
      makeReq({ body: JSON.stringify({ blob_ids: [B_MISSING, dead, keep] }) }),
    );
    expect(res.status).toBe(200);
    const body = res.body as Uint8Array;
    const f = readBlobFrame(body, 0);
    expect(f?.blobId).toBe(keep);
    expect(readBlobFrame(body, f?.next ?? 0)).toBeNull();

    // 只剩已撤销块 → 一帧都没有
    const onlyDead = await fetchHandler(depsOf(db, dir))(
      makeReq({ body: JSON.stringify({ blob_ids: [dead] }) }),
    );
    expect(onlyDead.status).toBe(200);
    expect((onlyDead.body as Uint8Array).byteLength).toBe(0);
  });

  it("空数组 400 / 非法 id 400 / 超块数上限 413", async () => {
    const { db, dir } = newEnv();
    const h = fetchHandler(depsOf(db, dir, 1));

    const empty = await h(makeReq({ body: JSON.stringify({ blob_ids: [] }) }));
    expect(empty.status).toBe(400);
    expect(jsonBody(empty)).toEqual({ error: "blob_ids 不能为空" });

    const illegal = await h(makeReq({ body: JSON.stringify({ blob_ids: ["not-a-blob-id"] }) }));
    expect(illegal.status).toBe(400);
    expect(jsonBody(illegal)).toEqual({ error: "非法 blob_id: not-a-blob-id" });

    const tooMany = await h(makeReq({ body: JSON.stringify({ blob_ids: [B1, B2] }) }));
    expect(tooMany.status).toBe(413);
    expect(jsonBody(tooMany)).toEqual({ error: "单请求块数超过上限 1" });

    // 解码失败 → 400
    const bad = await h(makeReq({ body: "{" }));
    expect(bad.status).toBe(400);
    expect(jsonBody(bad)).toEqual({ error: "请求体不是合法 JSON" });
  });

  it("总字节超限 413", async () => {
    const { db, dir } = newEnv();
    const data = new Uint8Array([1, 2, 3]);
    const id = blobId(data);
    putBlob(hostDbAsDb(db), dir, KEY, id, data, "item", 0);
    // HasBlob 的 size 取自 blobs 表；改大即可触发总字节护栏（64 MiB）。
    db.run(`UPDATE blobs SET size=? WHERE blob_id=?`, [70_000_000, id]);

    const res = await fetchHandler(depsOf(db, dir))(makeReq({ body: JSON.stringify({ blob_ids: [id] }) }));
    expect(res.status).toBe(413);
    expect(jsonBody(res)).toEqual({ error: `单请求总字节超过上限 ${64 << 20}` });
  });
});

// ==================== POST /v1/event-sync ====================

describe("event-sync", () => {
  it("event 增量 + 游标严格大于 + next 满页语义", async () => {
    const { db, dir } = newEnv();
    insertEvent(db, "a", 1);
    insertEvent(db, "b", 2);
    const h = eventSyncHandler(depsOf(db, dir));

    // 未满页：items 两条，next null
    const all = await h(makeReq({ body: JSON.stringify({ kind: "event", limit: 10 }) }));
    expect(all.status).toBe(200);
    expect(jsonBody(all)).toEqual({
      items: [
        {
          event_id: "a",
          id: "u1",
          type: "comment.v1",
          body_json: "{}",
          created_at: 1,
          received_at: 1,
        },
        {
          event_id: "b",
          id: "u1",
          type: "comment.v1",
          body_json: "{}",
          created_at: 2,
          received_at: 2,
        },
      ],
      next: null,
    });

    // 满页：limit=1 → 仅 a，next={ts:1,id:"a"}
    const page = await h(makeReq({ body: JSON.stringify({ kind: "event", limit: 1 }) }));
    expect(jsonBody(page)).toEqual({
      items: [
        { event_id: "a", id: "u1", type: "comment.v1", body_json: "{}", created_at: 1, received_at: 1 },
      ],
      next: { ts: 1, id: "a" },
    });

    // 用末条游标续拉：严格大于 → 仅 b
    const after = await h(
      makeReq({ body: JSON.stringify({ kind: "event", after: { ts: 1, id: "a" }, limit: 10 }) }),
    );
    expect((jsonBody(after).items as { event_id: string }[]).map((i) => i.event_id)).toEqual(["b"]);
  });

  it("tombstone 增量 + limit<=0 取默认 200", async () => {
    const { db, dir } = newEnv();
    putCommentTombstone(db, { eventId: "a", payloadCid: B1, reason: "r", at: 0, receivedAt: 1 });
    putCommentTombstone(db, { eventId: "b", payloadCid: B2, reason: "", at: 0, receivedAt: 2 });
    const h = eventSyncHandler(depsOf(db, dir));

    const res = await h(makeReq({ body: JSON.stringify({ kind: "tombstone", limit: 0 }) }));
    expect(res.status).toBe(200);
    expect(jsonBody(res)).toEqual({
      items: [
        { event_id: "a", payload_cid: B1, reason: "r", at: 0, received_at: 1 },
        { event_id: "b", payload_cid: B2, reason: "", at: 0, received_at: 2 },
      ],
      next: null,
    });

    // 增量：after a → 仅 b
    const after = await h(
      makeReq({ body: JSON.stringify({ kind: "tombstone", after: { ts: 1, id: "a" } }) }),
    );
    expect((jsonBody(after).items as { event_id: string }[]).map((i) => i.event_id)).toEqual(["b"]);
  });

  it("非法 kind → 400 event_param_invalid；坏 JSON → 400 bad_json", async () => {
    const { db, dir } = newEnv();
    const h = eventSyncHandler(depsOf(db, dir));

    const bad = await h(makeReq({ body: JSON.stringify({ kind: "nope" }) }));
    expect(bad.status).toBe(400);
    expect(jsonBody(bad)).toEqual({ error: "event_param_invalid" });

    const badJson = await h(makeReq({ body: "{" }));
    expect(badJson.status).toBe(400);
    expect(jsonBody(badJson)).toEqual({ error: "bad_json" });
  });
});

// ==================== POST /v1/scrub ====================

describe("scrub", () => {
  it("空 ids 全量：good 计数、missing/hash_mismatch 计 dropped、repaired 恒 0", async () => {
    const { db, dir } = newEnv();
    const g1 = new Uint8Array([1, 2, 3]);
    const g2 = new Uint8Array([4, 5, 6]);
    const id1 = blobId(g1);
    const id2 = blobId(g2);
    const adb = hostDbAsDb(db);
    putBlob(adb, dir, KEY, id1, g1, "item", 0);
    putBlob(adb, dir, KEY, id2, g2, "item", 1);
    // 有行无文件 → missing
    putBlobRow(db, B_MISSING, 5);
    // 文件内容与 id 不符 → hash_mismatch
    const mm = new Uint8Array([7, 7, 7]);
    const mmId = blobId(mm);
    putBlob(adb, dir, KEY, mmId, mm, "item", 2);
    writeFileSync(blobFile(dir, mmId), Buffer.from(encrypt(KEY, new Uint8Array([8, 8, 8]))));

    const res = await scrubHandler(depsOf(db, dir))(makeReq({ body: JSON.stringify({ blob_ids: [] }) }));
    expect(res.status).toBe(200);
    const out = jsonBody(res);
    // checked 计「文件存在」的块（含 hash_mismatch 那块），missing 不计。
    expect(out.checked).toBe(3);
    expect(out.repaired).toBe(0);
    expect(out.dropped).toBe(2);
    const bad = out.bad as { blob_id: string; reason: string }[];
    expect(bad.sort((a, b) => (a.blob_id < b.blob_id ? -1 : 1))).toEqual([
      { blob_id: B_MISSING, reason: "missing" },
      { blob_id: mmId, reason: "hash_mismatch" },
    ]);
    // bad 块被清理
    expect(listAllBlobIDs(db).sort()).toEqual([id1, id2].sort());
  });

  it("显式 ids 子集；顶层 null 是 no-op（等同全量）；空 body → 400", async () => {
    const { db, dir } = newEnv();
    const g1 = new Uint8Array([1, 2, 3]);
    const id1 = blobId(g1);
    putBlob(hostDbAsDb(db), dir, KEY, id1, g1, "item", 0);
    putBlobRow(db, B_MISSING, 5);
    const h = scrubHandler(depsOf(db, dir));

    const subset = await h(makeReq({ body: JSON.stringify({ blob_ids: [id1] }) }));
    expect((jsonBody(subset).bad as unknown[]).length).toBe(0);
    expect(jsonBody(subset).checked).toBe(1);
    expect(jsonBody(subset).dropped).toBe(0);

    const nul = await h(makeReq({ body: "null" }));
    expect(nul.status).toBe(200);
    expect(jsonBody(nul).checked).toBe(1); // 全量只剩 id1（B_MISSING 上一轮已被删）

    const empty = await h(makeReq({ body: "" }));
    expect(empty.status).toBe(400);
    expect(jsonBody(empty)).toEqual({ error: "请求体不是合法 JSON" });
  });
});

// ==================== mountPeerRoutes ====================

describe("mountPeerRoutes", () => {
  it("按五条内部 pattern 注册", () => {
    const { db, dir } = newEnv();
    const patterns: string[] = [];
    const fake = {
      handle: (pattern: string): void => {
        patterns.push(pattern);
      },
      listen: (): never => {
        throw new Error("not used");
      },
    } as unknown as HttpServerAdapter;

    mountPeerRoutes(fake, depsOf(db, dir));
    expect(patterns).toEqual([
      "GET /v1/inventory",
      "POST /v1/sync",
      "POST /v1/fetch",
      "POST /v1/scrub",
      "POST /v1/event-sync",
    ]);
  });
});
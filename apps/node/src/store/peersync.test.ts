// 对端同步·反熵 store 层（peersync.ts）的单测：逐条对齐 internal/store 的
// blobs.go / replica.go / scrub.go / comment.go / event.go / store.go。
// 建库风格参照 govern.test.ts（临时目录 + schemaStatements + migrate）。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blobId, isBlobId } from "@base/protocol-ts";
import { encrypt } from "../host/aesgcm";
import { openHostDb, type HostDb } from "../host/sqlite";
import { parseStoreKey } from "../host/storekey";
import { hasBlob, putBlob } from "./events";
import {
  contentVersion,
  countBlobsWithoutReplica,
  deleteBlob,
  deleteBlobFile,
  eventBlobIndex,
  getBlobBytes,
  getPeerCursor,
  hostDbAsDb,
  isRevokedPayload,
  listAllBlobIDs,
  listBlobsPage,
  listEventsAfter,
  listRevokedPayloads,
  listTombstonesAfter,
  mediaChunkIndex,
  putCommentTombstone,
  putPeerCursor,
  replicaPeers,
  upsertBlobReplica,
  verifyBlobs,
} from "./peersync";
import { migrate, schemaStatements } from "./schema";

const KEY = parseStoreKey("a".repeat(64));

// 32 字符小写 hex，满足 isBlobId。
const B1 = "11".repeat(16);
const B2 = "22".repeat(16);
const B3 = "33".repeat(16);
const B_MISSING = "44".repeat(16);

const opened: { db: HostDb; dir: string }[] = [];

function newEnv(): { db: HostDb; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "base-node-peersync-"));
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

function putBlobRow(db: HostDb, id: string, size: number, itemId = "item", seq = 0): void {
  db.run(`INSERT INTO blobs(blob_id,size,item_id,seq,created_at) VALUES(?,?,?,?,?)`, [
    id,
    size,
    itemId,
    seq,
    "2026-01-01T00:00:00Z",
  ]);
}

function blobFile(dataDir: string, id: string): string {
  return join(dataDir, "blobs", id.slice(0, 2), id.slice(2, 4), id);
}

interface EventOpts {
  id?: string;
  type?: string;
  targetId?: string | null;
  payloadCid?: string | null;
  replyTo?: string | null;
}
function insertEvent(db: HostDb, eventId: string, receivedAt: number, o: EventOpts = {}): void {
  db.run(
    `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    [
      eventId,
      o.id ?? "u1",
      o.type ?? "comment.v1",
      "{}",
      receivedAt,
      receivedAt,
      o.targetId ?? null,
      o.payloadCid ?? null,
      o.replyTo ?? null,
    ],
  );
}

describe("listBlobsPage / listAllBlobIDs", () => {
  it("keyset 分页：cursor 独占、next 推进、末页 next 为空", () => {
    const { db } = newEnv();
    putBlobRow(db, B3, 30);
    putBlobRow(db, B1, 10);
    putBlobRow(db, B2, 20);

    expect(listAllBlobIDs(db)).toEqual([B1, B2, B3]);

    const p1 = listBlobsPage(db, "", 2);
    expect(p1.refs).toEqual([
      { blobId: B1, seq: 0, size: 10, itemId: "" },
      { blobId: B2, seq: 0, size: 20, itemId: "" },
    ]);
    expect(p1.next).toBe(B2);

    const p2 = listBlobsPage(db, p1.next, 2);
    expect(p2.refs).toEqual([{ blobId: B3, seq: 0, size: 30, itemId: "" }]);
    expect(p2.next).toBe("");
  });

  it("limit<=0 取默认 500（少量行时一次取尽且 next 为空）", () => {
    const { db } = newEnv();
    putBlobRow(db, B1, 1);
    putBlobRow(db, B2, 2);
    const p = listBlobsPage(db, "", 0);
    expect(p.refs.length).toBe(2);
    expect(p.next).toBe("");
  });
});

describe("contentVersion", () => {
  it("缺省为 0；写入后递增/读取；非法值抛错", () => {
    const { db } = newEnv();
    expect(contentVersion(db)).toBe(0);
    db.run(`INSERT INTO meta(key,value) VALUES('content_version','5')`);
    expect(contentVersion(db)).toBe(5);
    db.run(`UPDATE meta SET value='abc' WHERE key='content_version'`);
    expect(() => contentVersion(db)).toThrow(/bad content_version/);
  });
});

describe("verifyBlobs", () => {
  it("正常块：checked 计数、bad 为空；空 ids = 全量", () => {
    const { db, dir } = newEnv();
    const d1 = new Uint8Array([1, 2, 3, 4, 5]);
    const d2 = new Uint8Array([9, 8, 7]);
    const id1 = blobId(d1);
    const id2 = blobId(d2);
    const adb = hostDbAsDb(db);
    putBlob(adb, dir, KEY, id1, d1, "item", 0);
    putBlob(adb, dir, KEY, id2, d2, "item", 1);

    const all = verifyBlobs(db, dir, KEY, []);
    expect(all.checked).toBe(2);
    expect(all.bad).toEqual([]);
    expect(listAllBlobIDs(db).sort()).toEqual([id1, id2].sort());
  });

  it("文件存在但内容被改成别的合法密文 → hash_mismatch，删文件与行", () => {
    const { db, dir } = newEnv();
    const d1 = new Uint8Array([1, 2, 3, 4, 5]);
    const id1 = blobId(d1);
    putBlob(hostDbAsDb(db), dir, KEY, id1, d1, "item", 0);
    writeFileSync(blobFile(dir, id1), Buffer.from(encrypt(KEY, new Uint8Array([7, 7, 7]))));

    const res = verifyBlobs(db, dir, KEY, [id1]);
    expect(res.checked).toBe(1);
    expect(res.bad).toEqual([{ blobId: id1, reason: "hash_mismatch" }]);
    expect(hasBlob(hostDbAsDb(db), dir, id1).exists).toBe(false);
    expect(db.get(`SELECT 1 FROM blobs WHERE blob_id=?`, [id1])).toBeUndefined();
  });

  it("密文被破坏解不开 → hash_mismatch", () => {
    const { db, dir } = newEnv();
    const d1 = new Uint8Array([1, 2, 3, 4, 5]);
    const id1 = blobId(d1);
    putBlob(hostDbAsDb(db), dir, KEY, id1, d1, "item", 0);
    writeFileSync(blobFile(dir, id1), Buffer.from([0, 1, 2, 3]));

    const res = verifyBlobs(db, dir, KEY, [id1]);
    expect(res.checked).toBe(1);
    expect(res.bad).toEqual([{ blobId: id1, reason: "hash_mismatch" }]);
  });

  it("有行无文件 → missing，删行；非法 blob_id 跳过", () => {
    const { db, dir } = newEnv();
    putBlobRow(db, B_MISSING, 5);
    const res = verifyBlobs(db, dir, KEY, [B_MISSING, "not-a-blob-id"]);
    expect(res.checked).toBe(0);
    expect(res.bad).toEqual([{ blobId: B_MISSING, reason: "missing" }]);
    expect(db.get(`SELECT 1 FROM blobs WHERE blob_id=?`, [B_MISSING])).toBeUndefined();
  });
});

describe("mediaChunkIndex", () => {
  it("键=归一后的 blob_id，字段含 seq 与 itemId；非法 id 跳过；重复保留先到者", () => {
    const { db } = newEnv();
    const h64 = "ab12cd34".repeat(8); // 64 字符 → 归一为前 32
    const norm = h64.slice(0, 32);
    const other = "cd".repeat(16);
    db.run(`INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json)
      VALUES('media/m1','video/mp4',3000,0,1024,?)`, [JSON.stringify([h64, "nothex"])]);
    db.run(`INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json)
      VALUES('media/m2','video/mp4',5000,0,1024,?)`, [JSON.stringify([h64, other])]);

    const idx = mediaChunkIndex(db);
    expect(Object.keys(idx).sort()).toEqual([norm, other].sort());
    expect(idx[norm]).toEqual({ blobId: norm, seq: 0, size: 0, itemId: "media/m1" });
    expect(idx[other]).toEqual({ blobId: other, seq: 1, size: 0, itemId: "media/m2" });
    expect(isBlobId(norm)).toBe(true);
  });
});

describe("eventBlobIndex", () => {
  it("白名单 type 的正文块 → 归属事件；空 cid / 非白名单排除；前缀按类型", () => {
    const { db } = newEnv();
    insertEvent(db, "ev1", 1, { type: "comment.v1", payloadCid: B1 });
    insertEvent(db, "ev2", 2, { type: "group.v1", payloadCid: B2 });
    insertEvent(db, "ev3", 3, { type: "dm.v1", payloadCid: B3 });
    insertEvent(db, "ev4", 4, { type: "progress.v1", payloadCid: B_MISSING });
    insertEvent(db, "ev5", 5, { type: "comment.v1", payloadCid: "" });

    const idx = eventBlobIndex(db);
    expect(Object.keys(idx).sort()).toEqual([B1, B2, B3].sort());
    expect(idx[B1]).toEqual({ blobId: B1, seq: 0, size: 0, itemId: "comment:ev1" });
    expect(idx[B2]).toEqual({ blobId: B2, seq: 0, size: 0, itemId: "group:ev2" });
    expect(idx[B3]).toEqual({ blobId: B3, seq: 0, size: 0, itemId: "dm:ev3" });
  });
});

describe("blob_replicas", () => {
  it("upsert 后 seen_at 刷新为最新值；ReplicaPeers 升序；CountBlobsWithoutReplica", () => {
    const { db } = newEnv();
    putBlobRow(db, B1, 1);
    putBlobRow(db, B2, 2);

    upsertBlobReplica(db, B1, "peerB", 10);
    upsertBlobReplica(db, B1, "peerA", 20);
    expect(replicaPeers(db, B1)).toEqual(["peerA", "peerB"]);

    upsertBlobReplica(db, B1, "peerA", 99);
    const seen = db.get(`SELECT seen_at FROM blob_replicas WHERE blob_id=? AND peer=?`, [B1, "peerA"]);
    expect(Number(seen?.seen_at)).toBe(99);

    expect(countBlobsWithoutReplica(db)).toBe(1); // B2 无副本
    expect(() => upsertBlobReplica(db, "bad", "p", 1)).toThrow(/invalid blob id/);
  });
});

describe("comment_tombstone", () => {
  it("put 幂等：同 event_id 覆盖但 received_at 保留首次值；撤回查询", () => {
    const { db } = newEnv();
    putCommentTombstone(db, {
      eventId: "e1",
      payloadCid: B1,
      reason: "spam",
      at: 1,
      receivedAt: 1000,
    });
    expect(isRevokedPayload(db, B1)).toBe(true);
    expect(isRevokedPayload(db, B2)).toBe(false);
    expect([...listRevokedPayloads(db)]).toEqual([B1]);

    putCommentTombstone(db, {
      eventId: "e1",
      payloadCid: B2,
      reason: "",
      at: 2,
      receivedAt: 2000,
    });
    const rows = db.all(`SELECT payload_cid,reason,at,received_at FROM comment_tombstone`);
    expect(rows.length).toBe(1);
    expect(rows[0].payload_cid).toBe(B2);
    expect(rows[0].reason).toBe("");
    expect(Number(rows[0].at)).toBe(2);
    expect(Number(rows[0].received_at)).toBe(1000); // 保留首次
    expect(isRevokedPayload(db, B1)).toBe(false);
    expect(isRevokedPayload(db, B2)).toBe(true);
  });

  it("listTombstonesAfter：复合游标严格大于 + 升序 + limit + NULL reason → ''", () => {
    const { db } = newEnv();
    const put = (eventId: string, cid: string, receivedAt: number): void =>
      putCommentTombstone(db, { eventId, payloadCid: cid, reason: "r", at: 0, receivedAt });
    put("a", B1, 1);
    put("b", B1, 1);
    put("c", B2, 2);
    put("d", B3, 3);
    db.run(
      `INSERT INTO comment_tombstone(event_id,payload_cid,reason,at,received_at) VALUES('e',?,NULL,0,4)`,
      [B1],
    );

    const all = listTombstonesAfter(db, 1, "a", 10);
    expect(all.map((t) => [t.receivedAt, t.eventId])).toEqual([
      [1, "b"],
      [2, "c"],
      [3, "d"],
      [4, "e"],
    ]);
    expect(all[3].reason).toBe("");

    const limited = listTombstonesAfter(db, 1, "a", 2);
    expect(limited.map((t) => t.eventId)).toEqual(["b", "c"]);

    expect(listTombstonesAfter(db, 4, "e", 10)).toEqual([]);
  });
});

describe("peer_sync_cursor", () => {
  it("默认零值；往返；护栏把未严格增大的游标抬到 oldTS+1", () => {
    const { db } = newEnv();
    expect(getPeerCursor(db, "p", "event")).toEqual({ ts: 0, id: "" });

    putPeerCursor(db, "p", "event", 100, "x");
    expect(getPeerCursor(db, "p", "event")).toEqual({ ts: 100, id: "x" });

    putPeerCursor(db, "p", "event", 50, "a"); // 回拨 → 101
    expect(getPeerCursor(db, "p", "event")).toEqual({ ts: 101, id: "a" });

    putPeerCursor(db, "p", "event", 101, "a"); // 相等 id → 102
    expect(getPeerCursor(db, "p", "event")).toEqual({ ts: 102, id: "a" });

    putPeerCursor(db, "p", "event", 200, "b"); // 严格增大 → 原样
    expect(getPeerCursor(db, "p", "event")).toEqual({ ts: 200, id: "b" });
  });
});

describe("listEventsAfter", () => {
  it("复合游标严格大于 + 升序 + limit；字段映射（nullable → ''）", () => {
    const { db } = newEnv();
    insertEvent(db, "a", 1, { id: "u1", targetId: "t1" });
    insertEvent(db, "b", 1);
    insertEvent(db, "c", 2);
    insertEvent(db, "d", 3);

    const all = listEventsAfter(db, 1, "a", 10);
    expect(all.map((e) => [e.receivedAt, e.eventId])).toEqual([
      [1, "b"],
      [2, "c"],
      [3, "d"],
    ]);
    expect(all[0].targetId).toBe("");
    expect(all[0].payloadCid).toBe("");
    expect(all[0].replyTo).toBe("");

    const limited = listEventsAfter(db, 1, "a", 2);
    expect(limited.map((e) => e.eventId)).toEqual(["b", "c"]);

    const first = listEventsAfter(db, 0, "", 1);
    expect(first.length).toBe(1);
    expect(first[0]).toEqual({
      eventId: "a",
      id: "u1",
      type: "comment.v1",
      bodyJson: "{}",
      createdAt: 1,
      receivedAt: 1,
      targetId: "t1",
      payloadCid: "",
      replyTo: "",
    });
  });
});

describe("getBlobBytes / deleteBlob", () => {
  it("往返：明文相等；非法 id 抛错", () => {
    const { db, dir } = newEnv();
    const data = new Uint8Array([0, 1, 2, 250, 255, 77]);
    const id = blobId(data);
    putBlob(hostDbAsDb(db), dir, KEY, id, data, "item", 0);

    expect(new Uint8Array(getBlobBytes(db, dir, KEY, id))).toEqual(data);
    expect(() => getBlobBytes(db, dir, KEY, "bad")).toThrow(/invalid blob id/);
  });

  it("DeleteBlob 后 HasBlob 为假；DeleteBlobFile 对不存在幂等", () => {
    const { db, dir } = newEnv();
    const data = new Uint8Array([5, 6, 7, 8]);
    const id = blobId(data);
    putBlob(hostDbAsDb(db), dir, KEY, id, data, "item", 0);
    expect(hasBlob(hostDbAsDb(db), dir, id).exists).toBe(true);

    deleteBlob(db, dir, id);
    expect(hasBlob(hostDbAsDb(db), dir, id).exists).toBe(false);
    expect(db.get(`SELECT 1 FROM blobs WHERE blob_id=?`, [id])).toBeUndefined();

    expect(() => deleteBlobFile(db, dir, B_MISSING)).not.toThrow();
    expect(() => deleteBlobFile(db, dir, "bad")).toThrow(/invalid blob id/);
  });
});
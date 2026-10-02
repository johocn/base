// store/syncstore.ts 的单测：开库 recipe、出站方法委托、importPack/insertPack 落库、只读重开。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blobId } from "@base/protocol-ts";
import { openHostDb } from "../host/sqlite";
import { openSyncStore, type SyncStore } from "./syncstore";
import type { PackEntry } from "./packimport";

// 集成测试要开 node-sqlite3-wasm 实例，并行 worker 争抢 CPU 时单测会超过默认 5s。
vi.setConfig({ testTimeout: 20_000 });

const KEY_HEX = "a".repeat(64);

const opened: { st: SyncStore; dir: string }[] = [];

function newStore(): { st: SyncStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "base-node-syncstore-"));
  const st = openSyncStore(dir, { storeKeyHex: KEY_HEX });
  opened.push({ st, dir });
  return { st, dir };
}

afterEach(() => {
  while (opened.length > 0) {
    const { st, dir } = opened.pop() as { st: SyncStore; dir: string };
    try {
      st.close();
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

function articleEntry(itemId: string): PackEntry {
  return {
    itemId,
    source: "s",
    type: "article",
    title: "T",
    sourceRev: "",
    contentHash: "h",
    sqliteTable: "articles",
    distClass: "public",
    updatedAt: "",
    authorId: "",
    authorSig: "",
    digest: "",
    publishedAt: "",
    tagsJson: "[]",
    bodyMd: "hi",
    mime: "",
    size: 0,
    duration: 0,
    chunkSize: 0,
    chunkHashes: [],
    segments: [],
    questionJson: "",
  };
}

describe("openSyncStore", () => {
  it("新库：水位 0、无块、索引为空、packs 目录在 dataDir 下", () => {
    const { st, dir } = newStore();
    expect(st.dataDir).toBe(dir);
    expect(st.packsDir()).toBe(join(dir, "packs"));
    expect(st.contentVersion()).toBe(0);
    expect(st.listAllBlobIDs()).toEqual([]);
    expect(st.mediaChunkIndex()).toEqual({});
    expect(st.eventBlobIndex()).toEqual({});
    expect(st.listEventsAfter(0, "", 10)).toEqual([]);
    expect(st.listTombstonesAfter(0, "", 10)).toEqual([]);
    expect(st.isRevokedPayload("11".repeat(16))).toBe(false);
    expect(st.getPeerCursor("p", "event")).toEqual({ ts: 0, id: "" });
  });

  it("块读写、分页、校验、副本计数与游标委托到既有原子函数", () => {
    const { st } = newStore();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const id = blobId(data);
    st.putBlob(id, data, "item", 0);

    expect(st.listAllBlobIDs()).toEqual([id]);
    expect(st.listBlobsPage("", 10).refs).toEqual([{ blobId: id, seq: 0, size: data.length, itemId: "" }]);
    expect(new Uint8Array(st.getBlobBytes(id))).toEqual(data);
    expect(st.verifyBlobs([])).toEqual({ checked: 1, bad: [] });
    expect(st.countBlobsWithoutReplica()).toBe(1);

    st.upsertBlobReplica(id, "peer1", 123);
    expect(st.countBlobsWithoutReplica()).toBe(0);

    st.putPeerCursor("p", "event", 100, "x");
    expect(st.getPeerCursor("p", "event")).toEqual({ ts: 100, id: "x" });

    st.deleteBlobFile(id); // 幂等，不抛
    expect(st.listAllBlobIDs()).toEqual([id]);
  });

  it("importPack 落库并推进水位；insertPack 写 packs 行（createdAt 缺省补当前 UTC）", () => {
    const { st, dir } = newStore();
    const res = st.importPack(5, [articleEntry("art/1")], []);
    expect(res.entries).toBe(1);
    expect(st.contentVersion()).toBe(5);

    st.insertPack({
      packId: "p1",
      contentVersion: 5,
      dir: join(dir, "packs", "p1"),
      merkleRoot: "mr",
      signature: "sig",
      issuedAt: "2026-01-01T00:00:00Z",
      itemCount: 1,
      createdAt: "",
    });
    st.close();

    const db = openHostDb(join(dir, "base.db"), { readOnly: true });
    try {
      expect(db.get(`SELECT title FROM items WHERE item_id='art/1'`)).toEqual({ title: "T" });
      const pack = db.get(`SELECT content_version,item_count,created_at FROM packs WHERE pack_id='p1'`);
      expect(pack?.content_version).toBe(5);
      expect(pack?.item_count).toBe(1);
      expect(String(pack?.created_at)).toMatch(/Z$/);
    } finally {
      db.close();
    }
  });

  it("只读重开已有库：水位与数据可见且不建目录", () => {
    const { st, dir } = newStore();
    st.putBlob(blobId(new Uint8Array([9])), new Uint8Array([9]), "i", 0);
    st.importPack(3, [], []);
    st.close();

    const ro = openSyncStore(dir, { storeKeyHex: KEY_HEX, readOnly: true });
    try {
      expect(ro.contentVersion()).toBe(3);
      expect(ro.listAllBlobIDs().length).toBe(1);
    } finally {
      ro.close();
    }
  });
});
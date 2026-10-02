// peersync/scrub.ts 的单测：ScrubResult.String、墓碑块直接删除且不计入 unrepaired、
// 坏块从 replica peer 拉回并计数 repaired、所有 peer 都拿不到 → unrepaired。
// 用注入 transport + 手写 stub SyncStore（scrub 是纯编排，不依赖真实 DB）。
import { describe, expect, it } from "vitest";
import { BLOB_PACK_CONTENT_TYPE, blobId, writeBlobFrame } from "@base/protocol-ts";
import type { BlobRef } from "../store/peersync";
import type { SyncStore } from "../store/syncstore";
import type { Config, Peer, PeerRequest, PeerResponse } from "./peer";
import { ScrubResult, scrubOnce } from "./scrub";

function cfg(route: (req: PeerRequest) => PeerResponse): { c: Config; calls: PeerRequest[] } {
  const calls: PeerRequest[] = [];
  const c: Config = {
    transportFor: () => async (req) => {
      calls.push(req);
      return route(req);
    },
  };
  return { c, calls };
}

/** scrubOnce 只用到这几个 SyncStore 方法；其余保持最小占位。 */
function stubStore(over: {
  revoked?: Set<string>;
  hasBlob?: (id: string) => { exists: boolean; size: number };
  deleteBlob?: (id: string) => void;
  verify?: (ids: readonly string[]) => { checked: number; bad: { blobId: string; reason: string }[] };
  replicaPeers?: (id: string) => string[];
  putBlob?: (id: string, data: Uint8Array, itemId: string, seq: number) => void;
  mediaChunkIndex?: () => Record<string, BlobRef>;
}): SyncStore {
  return {
    listRevokedPayloads: () => over.revoked ?? new Set<string>(),
    hasBlob: over.hasBlob ?? (() => ({ exists: false, size: 0 })),
    deleteBlob: over.deleteBlob ?? (() => {}),
    verifyBlobs: over.verify ?? (() => ({ checked: 0, bad: [] })),
    replicaPeers: over.replicaPeers ?? (() => []),
    putBlob: over.putBlob ?? (() => {}),
    mediaChunkIndex: over.mediaChunkIndex ?? (() => ({})),
    eventBlobIndex: () => ({}),
  } as unknown as SyncStore;
}

describe("ScrubResult", () => {
  it("String() 字段顺序与 Go 一致（unrepaired 打长度）", () => {
    const r = new ScrubResult();
    r.checked = 1;
    r.repaired = 2;
    r.dropped = 3;
    r.unrepaired = ["a", "b"];
    expect(r.String()).toBe("scrub checked=1 repaired=2 dropped=3 unrepaired=2");
    expect(new ScrubResult().String()).toBe("scrub checked=0 repaired=0 dropped=0 unrepaired=0");
  });
});

describe("scrubOnce", () => {
  it("墓碑块直接删除本地副本，不发起任何 fetch", async () => {
    const cid = "aa".repeat(16);
    const deleted: string[] = [];
    const st = stubStore({
      revoked: new Set([cid]),
      hasBlob: (id) => ({ exists: id === cid, size: 1 }),
      deleteBlob: (id) => deleted.push(id),
    });
    const { c, calls } = cfg(() => {
      throw new Error("should not fetch");
    });
    const res = await scrubOnce(c, undefined, st, [], []);
    expect(deleted).toEqual([cid]);
    expect(res.unrepaired).toEqual([]);
    expect(res.repaired).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("被撤销的坏块从校验结果里过滤掉，dropped 仍记原 bad 数（不补齐、不告警）", async () => {
    const cid = "bb".repeat(16);
    const st = stubStore({
      revoked: new Set([cid]),
      verify: () => ({ checked: 1, bad: [{ blobId: cid, reason: "hash_mismatch" }] }),
    });
    const { c, calls } = cfg(() => {
      throw new Error("should not fetch");
    });
    const res = await scrubOnce(c, undefined, st, [], []);
    expect(res.dropped).toBe(1);
    expect(res.unrepaired).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("坏块从 replica peer 拉回：计数 repaired，用 ownershipIndex 的归属落块", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const B = blobId(payload);
    const put: { id: string; itemId: string; seq: number }[] = [];
    const st = stubStore({
      verify: () => ({ checked: 1, bad: [{ blobId: B, reason: "hash_mismatch" }] }),
      replicaPeers: () => ["https://p1"],
      putBlob: (id, _data, itemId, seq) => put.push({ id, itemId, seq }),
      mediaChunkIndex: () => ({ [B]: { blobId: B, seq: 5, size: 0, itemId: "media/1" } }),
    });
    const { c, calls } = cfg((req) => {
      expect(new URL(req.url).pathname).toBe("/v1/fetch");
      return { status: 200, headers: { "content-type": BLOB_PACK_CONTENT_TYPE }, body: writeBlobFrame(B, payload) };
    });
    const res = await scrubOnce(c, undefined, st, [{ url: "https://p1", tlsFingerprint: "" }], []);
    expect(res.checked).toBe(1);
    expect(res.dropped).toBe(1);
    expect(res.repaired).toBe(1);
    expect(res.unrepaired).toEqual([]);
    expect(put).toEqual([{ id: B, itemId: "media/1", seq: 5 }]);
    expect(calls.length).toBe(1);
  });

  it("所有已知 peer 都拿不到 → 记入 unrepaired（逐个 url 试）", async () => {
    const payload = new Uint8Array([9, 8, 7]);
    const B = blobId(payload);
    const st = stubStore({
      verify: () => ({ checked: 1, bad: [{ blobId: B, reason: "missing" }] }),
      replicaPeers: () => ["https://p1", "https://p2"],
    });
    const { c, calls } = cfg(() => ({
      status: 200,
      headers: { "content-type": BLOB_PACK_CONTENT_TYPE },
      body: new Uint8Array(0),
    }));
    const res = await scrubOnce(c, undefined, st, [], []);
    expect(res.repaired).toBe(0);
    expect(res.unrepaired).toEqual([B]);
    expect(calls.length).toBe(2);
  });

  it("blobIds 原样透传给 verifyBlobs（空 = 由 store 展开为全量）", async () => {
    const seen: (readonly string[])[] = [];
    const st = stubStore({
      verify: (ids) => {
        seen.push(ids);
        return { checked: 0, bad: [] };
      },
    });
    const { c } = cfg(() => {
      throw new Error("should not fetch");
    });
    await scrubOnce(c, undefined, st, [], []);
    await scrubOnce(c, undefined, st, [], ["x", "y"]);
    expect(seen).toEqual([[], ["x", "y"]]);
  });

  it("ownershipIndex 缺归属时用零值 BlobRef 兜底（itemId 空、seq 0）", async () => {
    const payload = new Uint8Array([4, 4, 4]);
    const B = blobId(payload);
    const put: { id: string; itemId: string; seq: number }[] = [];
    const st = stubStore({
      verify: () => ({ checked: 1, bad: [{ blobId: B, reason: "hash_mismatch" }] }),
      replicaPeers: () => ["https://p1"],
      putBlob: (id, _data, itemId, seq) => put.push({ id, itemId, seq }),
    });
    const { c } = cfg(() => ({
      status: 200,
      headers: { "content-type": BLOB_PACK_CONTENT_TYPE },
      body: writeBlobFrame(B, payload),
    }));
    await scrubOnce(c, undefined, st, [], []);
    expect(put).toEqual([{ id: B, itemId: "", seq: 0 }]);
  });
});
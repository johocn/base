// peersync/sync.ts 的单测：RoundResult.String 等价、ownershipIndex 先到者优先、
// SyncPeer 的 equal 快路径与补齐路径。全程用注入 transport，不依赖真实网络。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOB_PACK_CONTENT_TYPE, blobId, writeBlobFrame } from "@base/protocol-ts";
import type { BlobRef } from "../store/peersync";
import { openSyncStore, type SyncStore } from "../store/syncstore";
import type { PackEntry } from "../store/packimport";
import { ownershipIndex, RoundResult, runForever, runOnce, syncPeer } from "./sync";
import type { Config, Peer, PeerRequest, PeerResponse } from "./peer";

// 集成测试要开 node-sqlite3-wasm 实例，并行 worker 争抢 CPU 时单测会超过默认 5s。
vi.setConfig({ testTimeout: 20_000 });

const PEER: Peer = { url: "https://peer1", tlsFingerprint: "" };

const opened: { st: SyncStore; dir: string }[] = [];
function newStore(): { st: SyncStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "base-node-sync-"));
  const st = openSyncStore(dir, { storeKeyHex: "a".repeat(64) });
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

function json(v: unknown, status = 200): PeerResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(v)),
  };
}

/** 注入式 transport：按请求路由应答，并记录全部出站请求。 */
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

function mediaEntry(itemId: string, chunkHashes: string[]): PackEntry {
  return {
    itemId,
    source: "s",
    type: "media",
    title: "M",
    sourceRev: "",
    contentHash: "h",
    sqliteTable: "media_meta",
    distClass: "public",
    updatedAt: "",
    authorId: "",
    authorSig: "",
    digest: "",
    publishedAt: "",
    tagsJson: "[]",
    bodyMd: "",
    mime: "video/mp4",
    size: 0,
    duration: 0,
    chunkSize: 1024,
    chunkHashes,
    segments: [],
    questionJson: "",
  };
}

describe("RoundResult", () => {
  it("String() 字段顺序与 Go 一致", () => {
    const r = new RoundResult("https://p");
    r.contentVersion = 7;
    r.packId = "pk";
    r.imported = true;
    r.equal = false;
    r.missing = 2;
    r.extra = 1;
    r.fetched = 3;
    r.badFrames = 4;
    r.noReplica = 5;
    expect(r.String()).toBe(
      "peer=https://p version=7 pack=pk imported=true equal=false missing=2 extra=1 fetched=3 bad_frames=4 no_replica=5",
    );
    expect(new RoundResult().peer).toBe("");
  });
});

describe("ownershipIndex", () => {
  it("媒体声明块 + 事件块合并，同块保留先到者（media 优先）", () => {
    const refA: BlobRef = { blobId: "a", seq: 0, size: 1, itemId: "media/1" };
    const refEvent: BlobRef = { blobId: "a", seq: 9, size: 9, itemId: "comment:e" };
    const refB: BlobRef = { blobId: "b", seq: 0, size: 0, itemId: "group:e" };
    const stub = {
      mediaChunkIndex: () => ({ a: refA }),
      eventBlobIndex: () => ({ a: refEvent, b: refB }),
    } as unknown as SyncStore;
    expect(ownershipIndex(stub)).toEqual({ a: refA, b: refB });
  });
});

describe("syncPeer", () => {
  it("对端判定 equal → 快路径：只发 catalog + sync，不拉 inventory", async () => {
    const { st } = newStore();
    const { c, calls } = cfg((req) => {
      if (req.method === "GET" && req.url.includes("/v1/catalog")) return json({ pack_id: "", content_version: 0 });
      if (req.method === "POST" && req.url.includes("/v1/sync")) return json({ equal: true });
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const res = await syncPeer(c, undefined, st, PEER, 1000);
    expect(res.peer).toBe("https://peer1");
    expect(res.imported).toBe(false);
    expect(res.equal).toBe(true);
    expect(res.missing).toBe(0);
    expect(res.fetched).toBe(0);
    expect(calls.map((x) => x.method + " " + new URL(x.url).pathname)).toEqual([
      "GET /v1/catalog",
      "POST /v1/sync",
    ]);
  });

  it("不等 → 拉 inventory：登记副本、补齐本地声明归属的缺失块、记录 extra", async () => {
    const { st } = newStore();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const B2 = blobId(payload); // 邻居持有、本地缺失、且在 media_meta 声明归属
    const B3 = "cc".repeat(16); // 邻居持有但本地不声明归属 → 不补
    const B1 = blobId(new Uint8Array([9, 9])); // 本地持有但邻居没有 → extra

    // 本地声明 B2 归属（media_meta 的块序列），并持有一个邻居没有的块 B1
    st.importPack(1, [mediaEntry("media/1", [B2])], []);
    st.putBlob(B1, new Uint8Array([9, 9]), "item", 0);

    const { c, calls } = cfg((req) => {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/v1/catalog") return json({ pack_id: "", content_version: 0 });
      if (req.method === "POST" && path === "/v1/sync") return json({ equal: false });
      if (req.method === "GET" && path === "/v1/inventory") {
        return json({
          content_version: 1,
          merkle_root: "root",
          blobs: [
            { blob_id: B2, size: payload.length },
            { blob_id: B3, size: 1 },
          ],
          next_cursor: null,
        });
      }
      if (req.method === "POST" && path === "/v1/fetch") {
        return { status: 200, headers: { "content-type": BLOB_PACK_CONTENT_TYPE }, body: writeBlobFrame(B2, payload) };
      }
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });

    const res = await syncPeer(c, undefined, st, PEER, 1000);
    expect(res.equal).toBe(false);
    expect(res.missing).toBe(1);
    expect(res.extra).toBe(1);
    expect(res.fetched).toBe(1);
    expect(res.badFrames).toBe(0);
    expect(res.noReplica).toBe(1); // B1 无副本

    expect(new Uint8Array(st.getBlobBytes(B2))).toEqual(payload);
    expect(st.listAllBlobIDs().sort()).toEqual([B1, B2].sort());
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual([
      "/v1/catalog",
      "/v1/sync",
      "/v1/inventory",
      "/v1/fetch",
    ]);
  });
});

describe("runOnce", () => {
  it("单 peer 失败只记日志并继续下一个（不终止）", async () => {
    const { st } = newStore();
    const P1: Peer = { url: "https://p1", tlsFingerprint: "" };
    const P2: Peer = { url: "https://p2", tlsFingerprint: "" };
    const { c } = cfg((req) => {
      if (req.url.startsWith("https://p1")) throw new Error("p1 down");
      if (req.method === "GET" && req.url.includes("/v1/catalog")) return json({ pack_id: "", content_version: 0 });
      if (req.method === "POST" && req.url.includes("/v1/sync")) return json({ equal: true });
      if (req.method === "POST" && req.url.includes("/v1/event-sync")) return json({ items: [], next: null });
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });
    const logs: string[] = [];
    const out = await runOnce(c, undefined, st, [P1, P2], (m) => logs.push(m));
    expect(out.length).toBe(1);
    expect(out[0].peer).toBe("https://p2");
    expect(out[0].equal).toBe(true);
    expect(logs.some((l) => l.includes("https://p1 事件同步失败"))).toBe(true);
    expect(logs.some((l) => l.includes("https://p1 本轮失败"))).toBe(true);
    expect(logs.some((l) => l.includes("peer=https://p2"))).toBe(true);
  });

  it("事件同步失败不影响块结果", async () => {
    const { st } = newStore();
    const { c } = cfg((req) => {
      if (req.method === "POST" && req.url.includes("/v1/event-sync")) throw new Error("ev down");
      if (req.method === "GET" && req.url.includes("/v1/catalog")) return json({ pack_id: "", content_version: 0 });
      if (req.method === "POST" && req.url.includes("/v1/sync")) return json({ equal: true });
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });
    const logs: string[] = [];
    const out = await runOnce(c, undefined, st, [PEER], (m) => logs.push(m));
    expect(out.length).toBe(1);
    expect(out[0].equal).toBe(true);
    expect(logs.some((l) => l.includes("事件同步失败"))).toBe(true);
  });

  it("ctx 已中止时不发起任何 peer 请求", async () => {
    const { st } = newStore();
    const { c, calls } = cfg(() => {
      throw new Error("no call");
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await runOnce(c, ctrl.signal, st, [PEER], () => {});
    expect(out).toEqual([]);
    expect(calls.length).toBe(0);
  });
});

describe("runForever", () => {
  it("peers 为空或 intervalMs<=0 时立即返回，不产生任何请求", async () => {
    const { st } = newStore();
    const { c, calls } = cfg(() => {
      throw new Error("no call");
    });
    const logs: string[] = [];
    runForever(c, undefined, st, [], 1000, (m) => logs.push(m));
    runForever(c, undefined, st, [PEER], 0, (m) => logs.push(m));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0);
    expect(logs.length).toBe(0);
  });
});
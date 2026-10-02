// remote.ts 的单测：分页 fetchInventory（推进/死循环/since 快路径）、fetchBlobs 切批
// （maxBlobs / FetchMaxBytes / TooLarge 摘除不死循环）、fetchBatch（BadFrames / Content-Type）、
// fetchPackTo（空文件拒绝）。全部用**注入 transport**，不依赖真实网络。
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BLOB_PACK_CONTENT_TYPE, blobId, FETCH_MAX_BYTES, writeBlobFrame } from "@base/protocol-ts";
import type { Config, Peer, PeerRequest, PeerResponse } from "./peer";
import {
  fetchBatch,
  fetchBlobs,
  fetchInventory,
  fetchPackTo,
  type FetchResult,
} from "./remote";

const PEER: Peer = { url: "https://peer.example", tlsFingerprint: "" };
const B1 = "11".repeat(16);
const B2 = "22".repeat(16);

function cfgWith(
  handler: (req: PeerRequest) => PeerResponse | Promise<PeerResponse>,
  extra: Partial<Config> = {},
): Config {
  return { transportFor: () => async (req) => handler(req), ...extra };
}

function jsonResp(obj: unknown): PeerResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(obj)),
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

describe("fetchInventory", () => {
  it("翻页：next_cursor 推进、拼接 blobs、末页结束", async () => {
    const pages: Record<string, unknown> = {
      "": { content_version: 3, merkle_root: "mr", blobs: [{ blob_id: B1, size: 1 }], next_cursor: "c1" },
      c1: { content_version: 3, merkle_root: "mr", blobs: [{ blob_id: B2, size: 2 }], next_cursor: null },
    };
    const urls: string[] = [];
    const cfg = cfgWith((req) => {
      urls.push(req.url);
      const cur = new URL(req.url).searchParams.get("cursor") ?? "";
      return jsonResp(pages[cur]);
    });
    const inv = await fetchInventory(cfg, undefined, PEER, 0);
    expect(inv.contentVersion).toBe(3);
    expect(inv.merkleRoot).toBe("mr");
    expect(inv.blobs.map((b) => b.blob_id)).toEqual([B1, B2]);
    expect(urls[0]).toBe("https://peer.example/v1/inventory?limit=2000");
    expect(urls[1]).toBe("https://peer.example/v1/inventory?limit=2000&cursor=c1");
  });

  it("next_cursor 不推进 → 拒绝死循环", async () => {
    const cfg = cfgWith(() => jsonResp({ content_version: 1, merkle_root: "", blobs: [], next_cursor: "c1" }));
    await expect(fetchInventory(cfg, undefined, PEER, 0)).rejects.toThrow(/分页未推进/);
  });

  it("since>0 → &since= 快路径", async () => {
    let seenUrl = "";
    const cfg = cfgWith((req) => {
      seenUrl = req.url;
      return jsonResp({ content_version: 1, merkle_root: "", blobs: [], next_cursor: null });
    });
    await fetchInventory(cfg, undefined, PEER, 9);
    expect(seenUrl).toBe("https://peer.example/v1/inventory?limit=2000&since=9");
  });
});

interface BatchEnv {
  cfg: Config;
  want: { blobId: string; size: number }[];
  ids: string[];
  calls: () => number;
  requestedIds: string[][];
}

function batchEnv(sizes: number[], extra: Partial<Config> = {}): BatchEnv {
  const payloads = new Map<string, Uint8Array>();
  const ids: string[] = [];
  sizes.forEach((_size, i) => {
    const data = new Uint8Array([i + 1]);
    const id = blobId(data);
    payloads.set(id, data);
    ids.push(id);
  });
  let calls = 0;
  const requestedIds: string[][] = [];
  const cfg = cfgWith(
    (req) => {
      calls++;
      const parsed = JSON.parse(new TextDecoder().decode(req.body ?? new Uint8Array())) as {
        blob_ids: string[];
      };
      requestedIds.push(parsed.blob_ids);
      const parts = parsed.blob_ids.map((id) => writeBlobFrame(id, payloads.get(id)!));
      return {
        status: 200,
        headers: { "content-type": BLOB_PACK_CONTENT_TYPE },
        body: concat(parts),
      };
    },
    extra,
  );
  const want = ids.map((id, i) => ({ blobId: id, size: sizes[i] }));
  return { cfg, want, ids, calls: () => calls, requestedIds };
}

describe("fetchBlobs 切批", () => {
  it("maxBlobs 限块数：5 块 / maxBlobs=2 → 3 批", async () => {
    const env = batchEnv([1, 1, 1, 1, 1], { fetchMaxBlobs: 2 });
    const got: string[] = [];
    const fr = await fetchBlobs(env.cfg, undefined, PEER, env.want, (id) => got.push(id));
    expect(env.calls()).toBe(3);
    expect(env.requestedIds.map((x) => x.length)).toEqual([2, 2, 1]);
    expect(fr.requested).toBe(5);
    expect(fr.fetched).toBe(5);
    expect(fr.badFrames).toBe(0);
    expect(fr.tooLarge).toEqual([]);
    expect(got.sort()).toEqual([...env.ids].sort());
  });

  it("累计 size ≤ FetchMaxBytes：3×40MiB → 每批 1 块", async () => {
    const big = 40 * (1 << 20);
    const env = batchEnv([big, big, big]);
    const fr = await fetchBlobs(env.cfg, undefined, PEER, env.want, () => {});
    expect(env.calls()).toBe(3);
    expect(env.requestedIds.every((x) => x.length === 1)).toBe(true);
    expect(fr.fetched).toBe(3);
  });

  it("TooLarge 摘除不死循环：超限块不发、其余照发", async () => {
    const env = batchEnv([FETCH_MAX_BYTES + 1, 1]);
    const fr = await fetchBlobs(env.cfg, undefined, PEER, env.want, () => {});
    expect(fr.tooLarge).toEqual([env.ids[0]]);
    expect(env.calls()).toBe(1);
    expect(env.requestedIds[0]).toEqual([env.ids[1]]);
    expect(fr.fetched).toBe(1);
  });

  it("全部超限：一次不发、正常结束", async () => {
    const env = batchEnv([FETCH_MAX_BYTES + 1]);
    const fr = await fetchBlobs(env.cfg, undefined, PEER, env.want, () => {});
    expect(fr.tooLarge).toEqual([env.ids[0]]);
    expect(env.calls()).toBe(0);
    expect(fr.requested).toBe(0);
  });
});

describe("fetchBatch", () => {
  it("Content-Type 不符 → 报错", async () => {
    const cfg = cfgWith(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new Uint8Array(),
    }));
    const out: FetchResult = { requested: 0, fetched: 0, badFrames: 0, tooLarge: [] };
    await expect(
      fetchBatch(cfg, undefined, PEER, [{ blobId: B1, size: 1 }], out, () => {}),
    ).rejects.toThrow(/Content-Type/);
  });

  it("BadFrames：哈希不符帧丢弃，合法帧交给 sink", async () => {
    const good = new Uint8Array([1, 2, 3]);
    const gid = blobId(good);
    const badHeader = "aa".repeat(16);
    const body = concat([writeBlobFrame(badHeader, new Uint8Array([9, 9, 9])), writeBlobFrame(gid, good)]);
    const cfg = cfgWith(() => ({
      status: 200,
      headers: { "content-type": BLOB_PACK_CONTENT_TYPE },
      body,
    }));
    const out: FetchResult = { requested: 0, fetched: 0, badFrames: 0, tooLarge: [] };
    const got: string[] = [];
    await fetchBatch(
      cfg,
      undefined,
      PEER,
      [
        { blobId: badHeader, size: 3 },
        { blobId: gid, size: 3 },
      ],
      out,
      (id, data) => {
        got.push(id);
        expect(Array.from(data)).toEqual([1, 2, 3]);
      },
    );
    expect(out.requested).toBe(2);
    expect(out.badFrames).toBe(1);
    expect(out.fetched).toBe(1);
    expect(got).toEqual([gid]);
  });
});

describe("fetchPackTo", () => {
  it("空文件拒绝：不落 pack.sqlite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-fetch-"));
    try {
      const cfg = cfgWith(() => ({ status: 200, headers: {}, body: new Uint8Array() }));
      await expect(fetchPackTo(cfg, undefined, PEER, "p1", dir)).rejects.toThrow(/为空文件/);
      expect(existsSync(join(dir, "pack.sqlite"))).toBe(false);
      expect(existsSync(join(dir, "pack.sqlite.tmp"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("成功：rename 落位 pack.sqlite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-fetch-"));
    try {
      const cfg = cfgWith(() => ({ status: 200, headers: {}, body: new Uint8Array([1, 2, 3]) }));
      const final = await fetchPackTo(cfg, undefined, PEER, "p1", dir);
      expect(final).toBe(join(dir, "pack.sqlite"));
      expect(Array.from(readFileSync(final))).toEqual([1, 2, 3]);
      expect(existsSync(final + ".tmp")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
import { describe, expect, it } from "vitest";
import { canonicalize, keyPairFromSeed, verifyManifest, type Json } from "@base/protocol-ts";

import { buildPack, type ExportInput } from "./packexport";
import type { MediaMeta, StoreArticle, StoreItem } from "./store/types";

const KEY = "11".repeat(32);
const ISSUED = "2026-01-01T00:00:00Z";

function item(over: Partial<StoreItem>): StoreItem {
  return {
    itemId: "article/a",
    source: "article",
    type: "article",
    title: "A",
    sourceRev: "rev-a",
    contentHash: "hash-a",
    sqliteTable: "articles",
    distClass: "public",
    state: "active",
    updatedAt: "2026-01-01T00:00:00Z",
    authorId: "",
    authorSig: "",
    ...over,
  };
}

function article(itemId: string, body: string): StoreArticle {
  return {
    itemId,
    title: "T",
    digest: "D",
    publishedAt: "2026-01-01T00:00:00Z",
    tagsJson: "[]",
    bodyMd: body,
    contentHash: "h",
    sourceRev: "r",
    updatedAt: "",
  };
}

function base(over: Partial<ExportInput>): ExportInput {
  return {
    issuer: "probe",
    signKeyHex: KEY,
    version: 1,
    issuedAt: ISSUED,
    items: [],
    articles: {},
    quizzes: {},
    segments: {},
    mediaMeta: {},
    identities: {},
    tombstones: [],
    ...over,
  };
}

describe("buildPack", () => {
  it("两篇文章：条目按 item_id 升序、manifest 可验签、meta 四行齐全", () => {
    const res = buildPack(
      base({
        items: [item({ itemId: "article/b", sourceRev: "rb" }), item({ itemId: "article/a" })],
        articles: { "article/a": article("article/a", "aaa"), "article/b": article("article/b", "bbb") },
      }),
    );
    expect(res.entries.map((e) => e.item_id)).toEqual(["article/a", "article/b"]);
    expect(res.contentVersion).toBe(1);
    expect(res.rows.meta.map(([k]) => k)).toEqual([
      "schema_version",
      "pack_id",
      "content_version",
      "merkle_root",
    ]);
    expect(res.rows.writes.map((w) => w.kind)).toEqual(["article", "article"]);
    expect(res.manifest.contributors).toBeUndefined();
    // 规范化身份可直接验签，且 pack_id / merkle 自洽
    const pub = keyPairFromSeed(KEY).pubHex;
    expect(verifyManifest(res.manifest, pub)).toBe(true);
    // 确定性：同输入二次装配字节相同
    const res2 = buildPack(
      base({
        items: [item({ itemId: "article/a" }), item({ itemId: "article/b", sourceRev: "rb" })],
        articles: { "article/a": article("article/a", "aaa"), "article/b": article("article/b", "bbb") },
      }),
    );
    expect(canonicalize(res2.manifest as unknown as Json)).toBe(
      canonicalize(res.manifest as unknown as Json),
    );
  });

  it("dist_class 非 public 即拒", () => {
    expect(() => buildPack(base({ items: [item({ distClass: "private" })] }))).toThrowError(
      /受控内容/,
    );
  });

  it("sqlite_table 不在白名单即拒", () => {
    expect(() => buildPack(base({ items: [item({ sqliteTable: "items" })] }))).toThrowError(
      /不在可导出白名单内/,
    );
  });

  it("article 行缺失即拒", () => {
    expect(() => buildPack(base({ items: [item({})] }))).toThrowError(/在 articles 表缺失/);
  });

  it("media_meta：chunks 以声明为准，空块即拒", () => {
    const blob = "ab12cd34".repeat(4);
    const meta: MediaMeta = {
      mime: "video/mp4",
      size: 1500,
      duration: 0,
      chunkSize: 1024,
      chunkHashes: [blob, blob],
    };
    const res = buildPack(
      base({
        items: [item({ itemId: "media/v", sqliteTable: "media_meta", contentHash: "mh" })],
        mediaMeta: { "media/v": meta },
      }),
    );
    expect(res.entries[0]?.chunks).toEqual([
      { blob_id: blob, size: 1024, seq: 0 },
      { blob_id: blob, size: 476, seq: 1 },
    ]);
    expect(res.rows.writes[0]?.kind).toBe("mediaMeta");

    const empty: MediaMeta = { ...meta, chunkHashes: [] };
    expect(() =>
      buildPack(
        base({
          items: [item({ itemId: "media/v", sqliteTable: "media_meta" })],
          mediaMeta: { "media/v": empty },
        }),
      ),
    ).toThrowError(/没有任何块文件/);
  });

  it("issuer / signKey 为空即拒", () => {
    expect(() => buildPack(base({ issuer: "" }))).toThrowError(/issuer 不能为空/);
    expect(() => buildPack(base({ signKeyHex: "" }))).toThrowError(/缺少签名私钥/);
  });
});

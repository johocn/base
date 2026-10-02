import { describe, expect, it } from "vitest";

import { declaredChunks, normalizeChunkID } from "./chunks";
import {
  articleFromRow,
  itemFromRow,
  listArticlesSql,
  listItemsSql,
  mediaMetaFromRow,
  placeholders,
  quizFromRow,
  segmentFromRow,
  tombstoneFromRow,
} from "./queries";
import type { MediaMeta } from "./types";

const BID_A = "a1b2c3d4".repeat(4); // 32 位 hex

describe("store 行映射（纯函数）", () => {
  it("itemFromRow 映射全部 12 列", () => {
    expect(
      itemFromRow({
        item_id: "article/x",
        source: "article",
        type: "article",
        title: "标题",
        source_rev: "r1",
        content_hash: "h",
        sqlite_table: "articles",
        dist_class: "public",
        state: "active",
        updated_at: "2026-01-01T00:00:00Z",
        author_id: "id1",
        author_sig: "sig1",
      }),
    ).toEqual({
      itemId: "article/x",
      source: "article",
      type: "article",
      title: "标题",
      sourceRev: "r1",
      contentHash: "h",
      sqliteTable: "articles",
      distClass: "public",
      state: "active",
      updatedAt: "2026-01-01T00:00:00Z",
      authorId: "id1",
      authorSig: "sig1",
    });
  });

  it("articleFromRow 映射 8 列且 updatedAt 为空串（读路径不取该列）", () => {
    expect(
      articleFromRow({
        item_id: "article/x",
        title: "t",
        digest: "d",
        published_at: "2026-01-01T00:00:00Z",
        tags_json: "[]",
        body_md: "enc:v1:AAAA",
        content_hash: "h",
        source_rev: "r",
      }),
    ).toEqual({
      itemId: "article/x",
      title: "t",
      digest: "d",
      publishedAt: "2026-01-01T00:00:00Z",
      tagsJson: "[]",
      bodyMd: "enc:v1:AAAA",
      contentHash: "h",
      sourceRev: "r",
      updatedAt: "",
    });
  });

  it("segmentFromRow / quizFromRow / tombstoneFromRow", () => {
    expect(
      segmentFromRow({ item_id: "c/1", seq: 2, kind: "lesson", text: "lesson/a", content_hash: "h" }),
    ).toEqual({ itemId: "c/1", seq: 2, kind: "lesson", text: "lesson/a", contentHash: "h" });
    expect(quizFromRow({ item_id: "q/1", question_json: "{}", content_hash: "h" })).toEqual({
      itemId: "q/1",
      questionJson: "{}",
      contentHash: "h",
    });
    expect(tombstoneFromRow({ item_id: "article/x", revoked_rev: 3 })).toEqual({
      item_id: "article/x",
      revoked_rev: 3,
    });
  });

  it("mediaMetaFromRow 解析 chunk_hashes_json；非法 JSON 抛错", () => {
    expect(
      mediaMetaFromRow({
        mime: "video/mp4",
        size: 2500,
        duration: 12,
        chunk_size: 1024,
        chunk_hashes_json: `["${BID_A}"]`,
      }),
    ).toEqual({ mime: "video/mp4", size: 2500, duration: 12, chunkSize: 1024, chunkHashes: [BID_A] });
    expect(() => mediaMetaFromRow({ chunk_hashes_json: "not json" })).toThrow();
  });
});

describe("SQL 文本构造（逐字对齐 Go）", () => {
  it("listItemsSql：空 state 与带 state", () => {
    expect(listItemsSql("")).toBe(
      "SELECT item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig FROM items ORDER BY item_id ASC",
    );
    expect(listItemsSql("active")).toBe(
      "SELECT item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig FROM items WHERE state=? ORDER BY item_id ASC",
    );
  });

  it("listArticlesSql：空 ids 与带 ids", () => {
    expect(listArticlesSql([])).toBe(
      "SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles",
    );
    expect(listArticlesSql(["a", "b"])).toBe(
      "SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles WHERE item_id IN (?,?)",
    );
  });

  it("placeholders", () => {
    expect(placeholders(1)).toBe("?");
    expect(placeholders(3)).toBe("?,?,?");
  });
});

describe("declaredChunks（64→32 归一 + 末块截断）", () => {
  it("normalizeChunkID：64 字符截前 32，其余原样", () => {
    expect(normalizeChunkID("f".repeat(64))).toBe("f".repeat(32));
    expect(normalizeChunkID(BID_A)).toBe(BID_A);
    expect(normalizeChunkID("short")).toBe("short");
  });

  it("声明的 64 字符全量被归一为 32 字符 blob_id", () => {
    const meta: MediaMeta = {
      mime: "",
      size: 100,
      duration: 0,
      chunkSize: 1024,
      chunkHashes: [`${BID_A}${"b".repeat(32)}`],
    };
    expect(declaredChunks("m/1", meta)).toEqual([{ blobId: BID_A, seq: 0, size: 100 }]);
  });

  it("末块按剩余字节截断；整除时保持整块", () => {
    const meta: MediaMeta = {
      mime: "video/mp4",
      size: 2500,
      duration: 0,
      chunkSize: 1024,
      chunkHashes: ["0".repeat(32), "1".repeat(32), "2".repeat(32)],
    };
    expect(declaredChunks("m/1", meta)).toEqual([
      { blobId: "0".repeat(32), seq: 0, size: 1024 },
      { blobId: "1".repeat(32), seq: 1, size: 1024 },
      { blobId: "2".repeat(32), seq: 2, size: 452 },
    ]);

    const even: MediaMeta = { ...meta, size: 2048, chunkHashes: ["0".repeat(32), "1".repeat(32)] };
    expect(declaredChunks("m/2", even)).toEqual([
      { blobId: "0".repeat(32), seq: 0, size: 1024 },
      { blobId: "1".repeat(32), seq: 1, size: 1024 },
    ]);
  });

  it("非法 blob_id 抛错", () => {
    const meta: MediaMeta = {
      mime: "",
      size: 1,
      duration: 0,
      chunkSize: 1024,
      chunkHashes: ["zzzz-not-hex"],
    };
    expect(() => declaredChunks("m/3", meta)).toThrow(/不是 blob_id/);
  });
});

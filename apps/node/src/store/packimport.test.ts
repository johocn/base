// store/packimport.ts 的单测：落库（items/articles/media_meta/quizzes/segments + tag 回填）、
// 防回卷 Rejected、dist_class!=public 的 Skipped、墓碑 RemovedBlobs、非法表名回滚。
// 建库风格参照 peersync.test.ts（临时目录 + schemaStatements + migrate）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, utf8, type Tombstone } from "@base/protocol-ts";
import { decText } from "../host/aesgcm";
import { openHostDb, type HostDb } from "../host/sqlite";
import { parseStoreKey } from "../host/storekey";
import { migrate, schemaStatements } from "./schema";
import { importPack, type PackEntry } from "./packimport";

// 集成测试要开 node-sqlite3-wasm 实例，并行 worker 争抢 CPU 时单测会超过默认 5s。
vi.setConfig({ testTimeout: 20_000 });

const KEY = parseStoreKey("a".repeat(64));

const opened: { db: HostDb; dir: string }[] = [];

function newEnv(): { db: HostDb; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "base-node-packimport-"));
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

/** 构造一条 PackEntry（只需在 o 里给出被测字段，其余取默认）。 */
function entry(o: Partial<PackEntry> & { itemId: string; sqliteTable: string }): PackEntry {
  return {
    source: "src",
    type: "article",
    title: "",
    sourceRev: "",
    contentHash: "",
    distClass: "public",
    updatedAt: "",
    authorId: "",
    authorSig: "",
    digest: "",
    publishedAt: "",
    tagsJson: "[]",
    bodyMd: "",
    mime: "",
    size: 0,
    duration: 0,
    chunkSize: 0,
    chunkHashes: [],
    segments: [],
    questionJson: "",
    ...o,
  };
}

describe("importPack 落库", () => {
  it("四族条目各写一行；正文加密；tag/ 条目回填 tag_links 与有序 segments；content_version 落 meta", () => {
    const { db, dir } = newEnv();
    const bodyMd = "# 你好\n正文";
    const entries: PackEntry[] = [
      entry({
        itemId: "art/1",
        sqliteTable: "articles",
        type: "article",
        title: "文章一",
        sourceRev: "r1",
        contentHash: "h-art",
        digest: "摘要",
        publishedAt: "2026-01-01T00:00:00Z",
        tagsJson: '["x"]',
        bodyMd,
      }),
      entry({
        itemId: "media/1",
        sqliteTable: "media_meta",
        type: "media",
        title: "媒体一",
        contentHash: "h-media",
        mime: "video/mp4",
        size: 100,
        duration: 5,
        chunkSize: 1024,
        chunkHashes: ["aa".repeat(16), "bb".repeat(16)],
      }),
      entry({
        itemId: "quiz/1",
        sqliteTable: "quizzes",
        type: "quiz",
        title: "题组一",
        contentHash: "h-quiz",
        questionJson: '{"q":"?"}',
      }),
      entry({
        itemId: "tag/t1",
        sqliteTable: "segments",
        type: "tag",
        title: "标签一",
        contentHash: "h-tag",
        segments: [
          { itemId: "tag/t1", seq: 1, kind: "article", text: "art/1", contentHash: "" },
          { itemId: "tag/t1", seq: 2, kind: "lesson", text: "lesson/1", contentHash: "" },
        ],
      }),
    ];

    const res = importPack(db, dir, KEY, 7, entries, []);
    expect(res).toEqual({ version: 7, entries: 4, skipped: 0, rejected: [], removedBlobs: [] });

    // items 四行，state=active，dist_class=public
    const items = db.all(`SELECT item_id,state,dist_class FROM items ORDER BY item_id ASC`);
    expect(items.map((r) => r.item_id)).toEqual(["art/1", "media/1", "quiz/1", "tag/t1"]);
    expect(items.every((r) => r.state === "active" && r.dist_class === "public")).toBe(true);

    // articles 正文为密文，可解回原文
    const art = db.get(`SELECT body_md,content_hash,title,digest FROM articles WHERE item_id='art/1'`);
    expect(art?.body_md).not.toBe(bodyMd);
    expect(decText(KEY, String(art?.body_md))).toBe(bodyMd);
    expect(art?.content_hash).toBe("h-art");

    // media_meta 行
    const media = db.get(
      `SELECT mime,size,duration,chunk_size,chunk_hashes_json FROM media_meta WHERE item_id='media/1'`,
    );
    expect(media).toEqual({
      mime: "video/mp4",
      size: 100,
      duration: 5,
      chunk_size: 1024,
      chunk_hashes_json: JSON.stringify(["aa".repeat(16), "bb".repeat(16)]),
    });

    // quizzes 行
    expect(db.get(`SELECT question_json FROM quizzes WHERE item_id='quiz/1'`)).toEqual({
      question_json: '{"q":"?"}',
    });

    // tag/t1 回填：kind 固定序（lesson 先于 article），content_hash = sha256(text)
    const segs = db.all(`SELECT seq,kind,text,content_hash FROM segments WHERE item_id='tag/t1' ORDER BY seq ASC`);
    expect(segs.map((r) => [r.seq, r.kind, r.text])).toEqual([
      [1, "lesson", "lesson/1"],
      [2, "article", "art/1"],
    ]);
    expect(segs.every((r) => r.content_hash === sha256Hex(utf8(String(r.text))))).toBe(true);

    const links = db.all(`SELECT tag_id,target_id,kind FROM tag_links ORDER BY target_id ASC`);
    expect(links).toEqual([
      { tag_id: "tag/t1", target_id: "art/1", kind: "article" },
      { tag_id: "tag/t1", target_id: "lesson/1", kind: "lesson" },
    ]);

    expect(db.get(`SELECT value FROM meta WHERE key='content_version'`)).toEqual({ value: "7" });
  });

  it("已存在同 item 时 upsert 覆盖（只增不减的幂等重放）", () => {
    const { db, dir } = newEnv();
    importPack(db, dir, KEY, 1, [entry({ itemId: "art/1", sqliteTable: "articles", title: "旧" })], []);
    importPack(db, dir, KEY, 2, [entry({ itemId: "art/1", sqliteTable: "articles", title: "新" })], []);
    expect(db.all(`SELECT item_id FROM items`).length).toBe(1);
    expect(db.get(`SELECT title FROM items WHERE item_id='art/1'`)).toEqual({ title: "新" });
  });
});

describe("importPack 跳过与防回卷", () => {
  it("dist_class != public → skipped；空串按 public 入库", () => {
    const { db, dir } = newEnv();
    const res = importPack(
      db,
      dir,
      KEY,
      3,
      [
        entry({ itemId: "art/secret", sqliteTable: "articles", distClass: "private" }),
        entry({ itemId: "art/blank", sqliteTable: "articles", distClass: "" }),
      ],
      [],
    );
    expect(res.entries).toBe(1);
    expect(res.skipped).toBe(1);
    expect(db.get(`SELECT 1 FROM items WHERE item_id='art/secret'`)).toBeUndefined();
    expect(db.get(`SELECT 1 FROM items WHERE item_id='art/blank'`)).toBeDefined();
  });

  it("墓碑 rev >= 版本 → rejected 且不写入；版本更高则不拒绝", () => {
    const { db, dir } = newEnv();
    const toms: Tombstone[] = [{ item_id: "art/1", revoked_rev: 2 }];
    const e = entry({ itemId: "art/1", sqliteTable: "articles", title: "x" });

    const low = importPack(db, dir, KEY, 2, [e], toms);
    expect(low.rejected).toEqual(["art/1"]);
    expect(low.entries).toBe(0);
    expect(db.get(`SELECT 1 FROM items WHERE item_id='art/1'`)).toBeUndefined();

    const high = importPack(db, dir, KEY, 3, [e], toms);
    expect(high.rejected).toEqual([]);
    expect(high.entries).toBe(1);
    expect(db.get(`SELECT 1 FROM items WHERE item_id='art/1'`)).toBeDefined();
  });
});

describe("importPack 墓碑清理", () => {
  it("应用墓碑：删 items/明细行并回报 removedBlobs（blob 文件由调用方删）", () => {
    const { db, dir } = newEnv();
    importPack(db, dir, KEY, 1, [entry({ itemId: "art/1", sqliteTable: "articles", bodyMd: "hi" })], []);
    db.run(`INSERT INTO blobs(blob_id,size,item_id,seq,created_at) VALUES(?,?,?,?,?)`, [
      "11".repeat(16),
      1,
      "art/1",
      0,
      "2026-01-01T00:00:00Z",
    ]);
    db.run(`INSERT INTO blobs(blob_id,size,item_id,seq,created_at) VALUES(?,?,?,?,?)`, [
      "22".repeat(16),
      2,
      "art/1",
      1,
      "2026-01-01T00:00:00Z",
    ]);
    db.run(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES('art/1',1,'article','t','h')`);

    const res = importPack(
      db,
      dir,
      KEY,
      2,
      [],
      [{ item_id: "art/1", revoked_rev: 2 }],
    );
    expect(res.removedBlobs.sort()).toEqual(["11".repeat(16), "22".repeat(16)].sort());
    expect(db.get(`SELECT 1 FROM items WHERE item_id='art/1'`)).toBeUndefined();
    expect(db.get(`SELECT 1 FROM articles WHERE item_id='art/1'`)).toBeUndefined();
    expect(db.get(`SELECT 1 FROM segments WHERE item_id='art/1'`)).toBeUndefined();
    expect(db.all(`SELECT blob_id FROM blobs WHERE item_id='art/1'`)).toEqual([]);
    expect(db.get(`SELECT revoked_rev FROM tombstones WHERE item_id='art/1'`)).toEqual({ revoked_rev: 2 });
  });
});

describe("importPack 错误路径", () => {
  it("不支持的 sqlite_table 抛错并整体回滚", () => {
    const { db, dir } = newEnv();
    expect(() =>
      importPack(db, dir, KEY, 1, [entry({ itemId: "x/1", sqliteTable: "unknown" })], []),
    ).toThrow(/sqlite_table=unknown 不支持入库/);
    expect(db.get(`SELECT 1 FROM items WHERE item_id='x/1'`)).toBeUndefined();
    expect(db.get(`SELECT value FROM meta WHERE key='content_version'`)).toBeUndefined();
  });
});

describe("importPack 融合钩子（轨道 B）", () => {
  it("有 authorId 的条目 → groups + circle_assignments 都写入，creator_id=authorId，origin=fusion", () => {
    const { db, dir } = newEnv();
    const authorId = "f78672b2f87ff80b248323a4be7c3da6";
    const itemId = "art/fusion";
    const body = "融合正文";

    importPack(
      db,
      dir,
      KEY,
      1,
      [
        entry({
          itemId,
          sqliteTable: "articles",
          title: "融合文",
          bodyMd: body,
          authorId,
          contentHash: sha256Hex(Buffer.from(body)),
        }),
      ],
      [],
    );

    const expectedCircleId = sha256Hex(utf8(itemId + ":circle")).slice(0, 16);

    const group = db.get(`SELECT * FROM groups WHERE group_id=?`, [expectedCircleId]);
    expect(group).toBeDefined();
    expect(group?.creator_id).toBe(authorId);
    expect(group?.epoch).toBe(1);
    expect(group?.roster_rev).toBe(0);
    expect(group?.encrypted).toBe(1);
    expect(group?.event_id).toBe(expectedCircleId);
    expect(group?.origin).toBe("fusion");
    const memberList = JSON.parse(String(group?.member_ids_json ?? "[]")) as string[];
    expect(memberList).toEqual([authorId]);

    const ca = db.get(
      `SELECT item_id,circle_id,origin FROM circle_assignments WHERE item_id=?`,
      [itemId],
    );
    expect(ca).toBeDefined();
    expect(ca?.item_id).toBe(itemId);
    expect(ca?.circle_id).toBe(expectedCircleId);
    expect(ca?.origin).toBe("fusion");
  });

  it("同条目重导入 → INSERT OR IGNORE 幂等，groups/circle_assignments 行数不增", () => {
    const { db, dir } = newEnv();
    const authorId = "f78672b2f87ff80b248323a4be7c3da6";
    const e = entry({
      itemId: "art/idem",
      sqliteTable: "articles",
      title: "幂等文",
      bodyMd: "幂等",
      authorId,
      contentHash: sha256Hex(Buffer.from("幂等")),
    });

    importPack(db, dir, KEY, 1, [e], []);
    const g1 = db.all(`SELECT 1 FROM groups`).length;
    const ca1 = db.all(`SELECT 1 FROM circle_assignments`).length;
    expect(g1).toBe(1);
    expect(ca1).toBe(1);

    importPack(db, dir, KEY, 2, [e], []);
    const g2 = db.all(`SELECT 1 FROM groups`).length;
    const ca2 = db.all(`SELECT 1 FROM circle_assignments`).length;
    expect(g2).toBe(g1);
    expect(ca2).toBe(ca1);
  });

  it("authorId 为空 → 不触发融合", () => {
    const { db, dir } = newEnv();
    importPack(
      db,
      dir,
      KEY,
      1,
      [
        entry({
          itemId: "art/no-author",
          sqliteTable: "articles",
          title: "无归属",
          bodyMd: "无归属",
          // authorId 默认 ""
        }),
      ],
      [],
    );
    expect(db.all(`SELECT 1 FROM groups`).length).toBe(0);
    expect(db.all(`SELECT 1 FROM circle_assignments`).length).toBe(0);
  });
});
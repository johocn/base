// peersync/packimport.ts 的单测：readAndVerifyPack 的 meta/行级/条目级校验各分支，
// 以及 resolveAuthor 的成功与三条降级路径。用 writePackSQLite 造真实 pack.sqlite，不依赖网络。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorSignBytes,
  deriveIdentityId,
  keyPairFromSeed,
  segmentsContentHash,
  sha256Hex,
  sign,
  utf8,
  type Entry,
  type Manifest,
} from "@base/protocol-ts";
import type { PackRows, PackWrite, StoreArticle } from "@base/core-ts";
import { writePackSQLite } from "../host/packsqlite";
import { readAndVerifyPack, resolveAuthor } from "./packimport";

// 集成测试要开 node-sqlite3-wasm 实例，并行 worker 争抢 CPU 时单测会超过默认 5s。
vi.setConfig({ testTimeout: 20_000 });

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "base-node-pkimport-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop() as string;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 句柄释放竞态，忽略 */
    }
  }
});

function mkManifest(entries: Entry[], over: Partial<Manifest> = {}): Manifest {
  return {
    pack_id: "p1",
    schema_version: 1,
    issuer: "iss",
    issued_at: "2026-01-01T00:00:00Z",
    content_version: 3,
    entries,
    tombstone: [],
    merkle_root: "mr",
    signature: "sig",
    ...over,
  };
}

function metaFor(man: Manifest, over: Record<string, string> = {}): [string, string][] {
  const m: Record<string, string> = {
    schema_version: "1",
    pack_id: man.pack_id,
    content_version: String(man.content_version),
    merkle_root: man.merkle_root,
    ...over,
  };
  return Object.entries(m) as [string, string][];
}

/** 写 pack.sqlite，返回路径。meta 默认与 man 一致。 */
function writePack(dir: string, man: Manifest, writes: PackWrite[], metaOver: Record<string, string> = {}): string {
  const rows: PackRows = { writes, meta: metaFor(man, metaOver) };
  const p = join(dir, "pack.sqlite");
  writePackSQLite(p, rows);
  return p;
}

const B0 = "aa".repeat(16);
const B1 = "bb".repeat(16);

function art(
  itemId: string,
  bodyMd: string,
  o: { entry?: Partial<Entry>; rowHash?: string; rowBody?: string } = {},
): { entry: Entry; write: PackWrite } {
  const hash = sha256Hex(utf8(bodyMd));
  const entry: Entry = {
    item_id: itemId,
    source: "s",
    type: "article",
    title: "T",
    source_rev: "r",
    content_hash: hash,
    sqlite_table: "articles",
    dist_class: "public",
    ...(o.entry ?? {}),
  };
  const row: StoreArticle = {
    itemId,
    title: "T",
    digest: "d",
    publishedAt: "2026",
    tagsJson: "[]",
    bodyMd: o.rowBody ?? bodyMd,
    contentHash: o.rowHash ?? hash,
    sourceRev: "r",
    updatedAt: "",
  };
  return { entry, write: { kind: "article", row } as PackWrite };
}

function media(
  itemId: string,
  chunks: { blob_id: string; size: number; seq: number }[],
  o: { entry?: Partial<Entry>; hashes?: string[]; size?: number; chunkJson?: string } = {},
): { entry: Entry; write: PackWrite } {
  const hashes = o.hashes ?? ["h0", "h1"].slice(0, chunks.length);
  const size = o.size ?? chunks.reduce((s, c) => s + c.size, 0);
  const entry: Entry = {
    item_id: itemId,
    source: "s",
    type: "media",
    title: "M",
    source_rev: "",
    content_hash: "h-media",
    sqlite_table: "media_meta",
    chunks,
    dist_class: "public",
    ...(o.entry ?? {}),
  };
  const write = {
    kind: "mediaMeta",
    row: {
      itemId,
      mime: "video/mp4",
      size,
      duration: 0,
      chunkSize: 1024,
      chunkHashesJson: o.chunkJson ?? JSON.stringify(hashes),
    },
  } as PackWrite;
  return { entry, write };
}

function quiz(
  itemId: string,
  questionJson: string,
  o: { entry?: Partial<Entry>; rowHash?: string; rowJson?: string } = {},
): { entry: Entry; write: PackWrite } {
  const hash = sha256Hex(utf8(questionJson));
  const entry: Entry = {
    item_id: itemId,
    source: "s",
    type: "quiz",
    title: "Q",
    source_rev: "",
    content_hash: hash,
    sqlite_table: "quizzes",
    dist_class: "public",
    ...(o.entry ?? {}),
  };
  const write = {
    kind: "quiz",
    row: { itemId, questionJson: o.rowJson ?? questionJson, contentHash: o.rowHash ?? hash },
  } as PackWrite;
  return { entry, write };
}

function segs(
  itemId: string,
  rowsIn: { seq: number; kind: string; text: string }[],
  o: { entry?: Partial<Entry>; rowHash?: (i: number) => string; entryHash?: string } = {},
): { entry: Entry; writes: PackWrite[] } {
  const entryHash = o.entryHash ?? segmentsContentHash(rowsIn);
  const entry: Entry = {
    item_id: itemId,
    source: "s",
    type: "tag",
    title: "T",
    source_rev: "",
    content_hash: entryHash,
    sqlite_table: "segments",
    dist_class: "public",
    ...(o.entry ?? {}),
  };
  const writes = rowsIn.map(
    (r, i) =>
      ({
        kind: "segment",
        row: {
          itemId,
          seq: r.seq,
          kind: r.kind,
          text: r.text,
          contentHash: o.rowHash ? o.rowHash(i) : sha256Hex(utf8(r.text)),
        },
      }) as PackWrite,
  );
  return { entry, writes };
}

describe("readAndVerifyPack 正常路径", () => {
  it("四族条目逐行比对通过并映射为 PackEntry", () => {
    const dir = newDir();
    const a = art("art/1", "# 正文");
    const m = media("media/1", [
      { blob_id: B0, size: 10, seq: 0 },
      { blob_id: B1, size: 20, seq: 1 },
    ]);
    const q = quiz("quiz/1", '{"q":1}');
    const s = segs("tag/t1", [
      { seq: 1, kind: "article", text: "art/1" },
      { seq: 2, kind: "lesson", text: "lesson/1" },
    ]);
    const man = mkManifest([a.entry, m.entry, q.entry, s.entry]);
    const pack = writePack(dir, man, [a.write, m.write, q.write, ...s.writes]);

    const out = readAndVerifyPack(pack, man);
    expect(out.map((e) => e.itemId)).toEqual(["art/1", "media/1", "quiz/1", "tag/t1"]);

    const ea = out[0];
    expect(ea.bodyMd).toBe("# 正文");
    expect(ea.title).toBe("T");
    expect(ea.digest).toBe("d");
    expect(ea.publishedAt).toBe("2026");
    expect(ea.tagsJson).toBe("[]");
    expect(ea.authorId).toBe("");
    expect(ea.authorSig).toBe("");

    const em = out[1];
    expect(em.mime).toBe("video/mp4");
    expect(em.size).toBe(30);
    expect(em.duration).toBe(0);
    expect(em.chunkSize).toBe(1024);
    expect(em.chunkHashes).toEqual(["h0", "h1"]);

    expect(out[2].questionJson).toBe('{"q":1}');

    const es = out[3];
    expect(es.segments.map((x) => [x.seq, x.kind, x.text])).toEqual([
      [1, "article", "art/1"],
      [2, "lesson", "lesson/1"],
    ]);
  });
});

describe("readAndVerifyPack meta 校验", () => {
  it("pack meta pack_id 与 manifest 不一致 → 抛错", () => {
    const dir = newDir();
    const a = art("art/1", "x");
    const man = mkManifest([a.entry]);
    const pack = writePack(dir, man, [a.write], { pack_id: "other" });
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack meta pack_id=.* 与 manifest/);
  });

  it("pack meta content_version 不一致 → 抛错", () => {
    const dir = newDir();
    const a = art("art/1", "x");
    const man = mkManifest([a.entry]);
    const pack = writePack(dir, man, [a.write], { content_version: "9" });
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack meta content_version=.* 与 manifest/);
  });

  it("pack meta merkle_root 不一致 → 抛错", () => {
    const dir = newDir();
    const a = art("art/1", "x");
    const man = mkManifest([a.entry]);
    const pack = writePack(dir, man, [a.write], { merkle_root: "deadbeef" });
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack meta merkle_root=.* 与 manifest/);
  });
});

describe("readAndVerifyPack 行级校验", () => {
  it("文章行缺失 → 抛错", () => {
    const dir = newDir();
    const a = art("art/1", "x");
    const man = mkManifest([a.entry]);
    const pack = writePack(dir, man, []);
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack 缺少 manifest 声明的文章行 art\/1/);
  });

  it("文章行级 hash 不符 → 抛错", () => {
    const dir = newDir();
    const a = art("art/1", "x", { rowHash: "other" });
    const man = mkManifest([a.entry]);
    const pack = writePack(dir, man, [a.write]);
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack 行级 hash 不符 art\/1/);
  });

  it("文章正文哈希与 manifest 不符 → 抛错", () => {
    const dir = newDir();
    const a = art("art/1", "x", { rowBody: "tampered" });
    const man = mkManifest([a.entry]);
    const pack = writePack(dir, man, [a.write]);
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack 正文哈希与 manifest 不符 art\/1/);
  });

  it("媒体块数与 manifest chunks 不符 → 抛错", () => {
    const dir = newDir();
    const m = media(
      "media/1",
      [
        { blob_id: B0, size: 10, seq: 0 },
        { blob_id: B1, size: 20, seq: 1 },
      ],
      { hashes: ["h0"] },
    );
    const man = mkManifest([m.entry]);
    const pack = writePack(dir, man, [m.write]);
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack 块数不符 media\/1: 1 != 2/);
  });

  it("媒体大小与 chunks 尺寸和不等 → 抛错", () => {
    const dir = newDir();
    const m = media("media/1", [{ blob_id: B0, size: 10, seq: 0 }], { size: 999 });
    const man = mkManifest([m.entry]);
    const pack = writePack(dir, man, [m.write]);
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack 媒体大小不符 media\/1: 999 != 10/);
  });

  it("题库行缺失 → 抛错", () => {
    const dir = newDir();
    const q = quiz("quiz/1", '{"q":1}');
    const man = mkManifest([q.entry]);
    const pack = writePack(dir, man, []);
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack 缺少 manifest 声明的题库行 quiz\/1/);
  });

  it("题库 question_json 与其 content_hash 不符 → 抛错", () => {
    const dir = newDir();
    const q = quiz("quiz/1", '{"q":1}', { rowJson: '{"q":2}' });
    const man = mkManifest([q.entry]);
    const pack = writePack(dir, man, [q.write]);
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack 行级 hash 不符 quiz\/1/);
  });

  it("segments 行缺失 → 抛错", () => {
    const dir = newDir();
    const s = segs("tag/t1", [{ seq: 1, kind: "article", text: "art/1" }]);
    const man = mkManifest([s.entry]);
    const pack = writePack(dir, man, []);
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack 缺少 manifest 声明的 segments 行 tag\/t1/);
  });

  it("segments 行级 hash 不符 → 抛错", () => {
    const dir = newDir();
    const s = segs("tag/t1", [{ seq: 1, kind: "article", text: "art/1" }], {
      rowHash: () => "bad",
    });
    const man = mkManifest([s.entry]);
    const pack = writePack(dir, man, s.writes);
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack segments 行级 hash 不符 tag\/t1 seq=1/);
  });

  it("segments 条目级 hash 与 manifest 不符 → 抛错", () => {
    const dir = newDir();
    const s = segs("tag/t1", [{ seq: 1, kind: "article", text: "art/1" }], {
      entryHash: "deadbeef",
    });
    const man = mkManifest([s.entry]);
    const pack = writePack(dir, man, s.writes);
    expect(() => readAndVerifyPack(pack, man)).toThrow(/pack segments 条目级 hash 与 manifest 不符 tag\/t1/);
  });

  it("manifest 声明的 sqlite_table 不支持 → 抛错", () => {
    const dir = newDir();
    const bad: Entry = {
      item_id: "x/1",
      source: "s",
      type: "t",
      title: "T",
      source_rev: "",
      content_hash: "h",
      sqlite_table: "unknown",
      dist_class: "public",
    };
    const man = mkManifest([bad]);
    const pack = writePack(dir, man, []);
    expect(() => readAndVerifyPack(pack, man)).toThrow(/sqlite_table="unknown" 不支持入库/);
  });
});

describe("resolveAuthor", () => {
  const kp = keyPairFromSeed("0".repeat(64));
  const pub = kp.pubHex;
  const authorId = deriveIdentityId(pub);

  function signedEntry(itemId: string, contentHash: string): Entry {
    const sig = sign(kp.seedHex, utf8(authorSignBytes(itemId, contentHash, authorId)));
    return {
      item_id: itemId,
      source: "s",
      type: "article",
      title: "T",
      source_rev: "",
      content_hash: contentHash,
      sqlite_table: "articles",
      dist_class: "public",
      author_id: authorId,
      author_sig: sig,
    };
  }

  it("contributors 命中且验签通过 → 返回归属", () => {
    const e = signedEntry("art/1", "hc");
    const man = mkManifest([e], { contributors: { [authorId]: pub } });
    expect(resolveAuthor(man, e)).toEqual([authorId, e.author_sig]);
  });

  it("author_id / author_sig 为空 → 无归属且不告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e: Entry = {
      item_id: "art/1",
      source: "s",
      type: "article",
      title: "T",
      source_rev: "",
      content_hash: "hc",
      sqlite_table: "articles",
      dist_class: "public",
    };
    expect(resolveAuthor(mkManifest([e]), e)).toEqual(["", ""]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("contributors 缺作者公钥 → 降级并告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = signedEntry("art/1", "hc");
    expect(resolveAuthor(mkManifest([e]), e)).toEqual(["", ""]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("归属公钥未随包提供"));
    warn.mockRestore();
  });

  it("公钥与 author_id 失配 → 降级并告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = { ...signedEntry("art/1", "hc"), author_id: "f".repeat(32) };
    const man = mkManifest([e], { contributors: { ["f".repeat(32)]: pub } });
    expect(resolveAuthor(man, e)).toEqual(["", ""]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("归属公钥与 author_id 失配"));
    warn.mockRestore();
  });

  it("归属验签失败 → 降级并告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = signedEntry("art/1", "hc");
    const badSig = sign(kp.seedHex, utf8(authorSignBytes("art/1", "other", authorId)));
    const man = mkManifest([{ ...e, author_sig: badSig }], { contributors: { [authorId]: pub } });
    expect(resolveAuthor(man, { ...e, author_sig: badSig })).toEqual(["", ""]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("归属验签失败"));
    warn.mockRestore();
  });
});
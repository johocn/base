// store/directory.ts 的单测：目录 seed 的三源登记、幂等短路、空库不落键、版本自增。
// 建库风格参照 packimport.test.ts（临时目录 + schemaStatements + migrate）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openHostDb, type HostDb } from "../host/sqlite";
import { seedDirectoryFromExisting } from "./directory";
import { migrate, schemaStatements } from "./schema";

// 集成测试要开 node-sqlite3-wasm 实例，并行 worker 争抢 CPU 时单测会超过默认 5s。
vi.setConfig({ testTimeout: 20_000 });

const opened: { db: HostDb; dir: string }[] = [];

function newDb(): HostDb {
  const dir = mkdtempSync(join(tmpdir(), "base-node-dirseed-"));
  const db = openHostDb(join(dir, "base.db"));
  for (const stmt of schemaStatements) db.exec(stmt);
  migrate(db);
  opened.push({ db, dir });
  return db;
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
      /* 忽略 */
    }
  }
});

function terms(db: HostDb): string[] {
  return db
    .all(`SELECT kind,term_key,display_name,state,first_author_id FROM directory_terms ORDER BY kind,term_key`)
    .map((r) => `${String(r.kind)}|${String(r.term_key)}|${String(r.display_name)}|${String(r.state)}|${String(r.first_author_id)}`);
}

function meta(db: HostDb, key: string): string | undefined {
  const row = db.get(`SELECT value FROM meta WHERE key=?`, [key]);
  return row === undefined ? undefined : String(row.value);
}

function seedItems(db: HostDb, ids: readonly [string, string][]): void {
  for (const [itemId, source] of ids) {
    db.run(
      `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [itemId, source, "tag", itemId, "", "", "segments", "public", "active", "2026-10-02T00:00:00Z"],
    );
  }
}

it("三源登记为 approved 词条，version 自增 1 并落 directory_seeded", () => {
  const db = newDb();
  seedItems(db, [
    ["tag/x", "tag"],
    ["tag/x/sub", "tag"],
    ["category/工具", "category"],
  ]);
  db.run(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`, [
    "course/c1",
    -1,
    "attr.category",
    "手工",
    "",
  ]);
  db.run(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`, [
    "course/c1",
    -2,
    "attr.instructor",
    "张三",
    "",
  ]);
  seedDirectoryFromExisting(db);
  expect(terms(db)).toEqual([
    // 排序按 (kind, term_key) 升序；UTF-8 字节序下 工具(E5B7A5) < 手工(E6898B)。
    "category|工具|工具|approved|",
    "category|手工|手工|approved|",
    "instructor|张三|张三|approved|",
    "tag|x|x|approved|",
  ]);
  expect(meta(db, "directory_version")).toBe("1");
  expect(meta(db, "directory_seeded")).toBe("1");
});

it("幂等：第二次调用短路，不重复写、不再 bump", () => {
  const db = newDb();
  seedItems(db, [["tag/x", "tag"]]);
  seedDirectoryFromExisting(db);
  seedDirectoryFromExisting(db);
  expect(terms(db)).toEqual(["tag|x|x|approved|"]);
  expect(meta(db, "directory_version")).toBe("1");
});

it("空库：不写词条、不 bump、不落短路键（后续补入的存量仍能被 seed）", () => {
  const db = newDb();
  seedDirectoryFromExisting(db);
  expect(terms(db)).toEqual([]);
  expect(meta(db, "directory_version")).toBeUndefined();
  expect(meta(db, "directory_seeded")).toBeUndefined();
});

it("已有 directory_version 时在其上自增", () => {
  const db = newDb();
  seedItems(db, [["tag/x", "tag"]]);
  db.run(`INSERT INTO meta(key,value) VALUES(?,?)`, ["directory_version", "4"]);
  seedDirectoryFromExisting(db);
  expect(meta(db, "directory_version")).toBe("5");
});

it("归一化非法与空名被丢弃；全角折叠后同名归并（先到先得保留原文）", () => {
  const db = newDb();
  seedItems(db, [
    ["category/", "category"],
    ["tag/", "tag"],
    ["tag", "tag"],
    ["category/ABC", "category"],
  ]);
  db.run(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`, [
    "course/c1",
    -1,
    "attr.category",
    "ＡＢＣ",
    "",
  ]);
  db.run(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`, [
    "course/c1",
    -2,
    "attr.category",
    "   ",
    "",
  ]);
  seedDirectoryFromExisting(db);
  // attr 源先于容器源 ⇒ 展示名取全角原文 ＡＢＣ。
  expect(terms(db)).toEqual(["category|abc|ＡＢＣ|approved|"]);
});
// schema.ts 的单测（T1 数据面三件）：circle_assignments 新表 + groups.origin 后加列。
// 建库风格参照 directory.test.ts（临时目录 + schemaStatements + migrate）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openHostDb, type HostDb } from "../host/sqlite";
import { migrate, schemaStatements } from "./schema";

vi.setConfig({ testTimeout: 20_000 });

const opened: { db: HostDb; dir: string }[] = [];

/** Go `store.Open` 引导段：schemaStatements → migrate。 */
function bootstrap(db: HostDb): void {
  for (const stmt of schemaStatements) db.exec(stmt);
  migrate(db);
}

function newDb(): HostDb {
  const dir = mkdtempSync(join(tmpdir(), "base-node-schema-"));
  const db = openHostDb(join(dir, "base.db"));
  bootstrap(db);
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

interface Col {
  name: string;
  type: string;
  notnull: number;
  dfltValue: string | null;
  pk: number;
}

function tableInfo(db: HostDb, table: string): Col[] {
  return db.all(`PRAGMA table_info(${table})`).map((r) => ({
    name: String(r.name),
    type: String(r.type),
    notnull: Number(r.notnull),
    dfltValue: r.dflt_value === null || r.dflt_value === undefined ? null : String(r.dflt_value),
    pk: Number(r.pk),
  }));
}

function tableSql(db: HostDb, table: string): string {
  const row = db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, [table]);
  return row === undefined ? "" : String(row.sql);
}

it("用例 1：circle_assignments 存在，列名/类型/主键与 DDL 一致", () => {
  const db = newDb();
  const cols = tableInfo(db, "circle_assignments");
  expect(cols.map((c) => c.name)).toEqual(["item_id", "circle_id", "origin", "created_at"]);
  expect(cols.map((c) => c.type)).toEqual(["TEXT", "TEXT", "TEXT", "INTEGER"]);
  expect(cols.map((c) => c.notnull)).toEqual([1, 1, 1, 1]);
  expect(cols.map((c) => c.pk)).toEqual([1, 2, 0, 0]);
  // origin 缺省须为 fusion（字符串字面量在 table_info 里带引号，故去引号比对）。
  expect((cols[2]?.dfltValue ?? "").replace(/^'|'$/g, "")).toBe("fusion");
  const sql = tableSql(db, "circle_assignments");
  expect(sql).toContain("PRIMARY KEY(item_id, circle_id)");
  expect(sql).toContain("DEFAULT 'fusion'");
});

it("用例 2：重复开库幂等（同库连开两次不报错、结构不变）", () => {
  const dir = mkdtempSync(join(tmpdir(), "base-node-schema-"));
  const db1 = openHostDb(join(dir, "base.db"));
  bootstrap(db1);
  const sql1 = tableSql(db1, "circle_assignments");
  const groups1 = tableInfo(db1, "groups");
  db1.close();

  const db2 = openHostDb(join(dir, "base.db"));
  bootstrap(db2); // 二次引导不应报错
  expect(tableSql(db2, "circle_assignments")).toBe(sql1);
  expect(tableInfo(db2, "groups")).toEqual(groups1);
  opened.push({ db: db2, dir });
});

it("用例 3：老库升级（groups 无 origin）后补列，存量行取 user", () => {
  const dir = mkdtempSync(join(tmpdir(), "base-node-schema-"));
  const db = openHostDb(join(dir, "base.db"));
  // 模拟 #33 之后、本册之前的 groups 表（有 roster_rev/encrypted/key_envelopes，无 origin）。
  db.exec(`CREATE TABLE groups(
\t\tgroup_id         TEXT PRIMARY KEY,
\t\tcreator_id       TEXT NOT NULL,
\t\tepoch            INTEGER NOT NULL,
\t\troster_rev       INTEGER NOT NULL DEFAULT 0,
\t\tencrypted        INTEGER NOT NULL DEFAULT 1,
\t\tmember_ids_json  TEXT NOT NULL,
\t\tkey_envelopes    TEXT NOT NULL DEFAULT '[]',
\t\tevent_id         TEXT NOT NULL,
\t\tupdated_at       INTEGER NOT NULL
\t)`);
  db.run(
    `INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    ["g-old", "id-a", 1, 1, 1, '["id-a"]', "[]", "e1", 1],
  );
  bootstrap(db); // 老库引导：schemaStatements 不重建 groups，migrate 补 origin
  const cols = tableInfo(db, "groups").map((c) => c.name);
  expect(cols).toContain("origin");
  const row = db.get(`SELECT origin FROM groups WHERE group_id=?`, ["g-old"]);
  expect(row === undefined ? undefined : String(row.origin)).toBe("user");
  opened.push({ db, dir });
});

it("用例 4：新建圈子 origin 默认 user", () => {
  const db = newDb();
  db.run(
    `INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    ["g-new", "id-a", 1, 1, 1, '["id-a"]', "[]", "e1", 1],
  );
  const row = db.get(`SELECT origin FROM groups WHERE group_id=?`, ["g-new"]);
  expect(row === undefined ? undefined : String(row.origin)).toBe("user");
});
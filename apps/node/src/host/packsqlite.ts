// pack.sqlite 的写出宿主（对齐 `internal/packexport/export.go:223-377`）：
// 先写 `path + ".tmp"`，再 `VACUUM INTO path` 产出紧凑可复现的最终文件，最后删 tmp。
// 表 DDL 文本与 `apps/node/src/store/schema.ts`（= Go store schema.go）逐字相同——
// DDL 会进 sqlite_master，字面差异直接改变包字节。
import { rmSync } from "node:fs";
import sqlite3 from "node-sqlite3-wasm";
import type { PackRows } from "@base/core-ts";

const PACK_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS articles(
\t\titem_id      TEXT PRIMARY KEY,
\t\ttitle        TEXT NOT NULL DEFAULT '',
\t\tdigest       TEXT NOT NULL DEFAULT '',
\t\tpublished_at TEXT NOT NULL DEFAULT '',
\t\ttags_json    TEXT NOT NULL DEFAULT '[]',
\t\tbody_md      TEXT NOT NULL,
\t\tcontent_hash TEXT NOT NULL,
\t\tsource_rev   TEXT NOT NULL DEFAULT ''
\t)`,
  `CREATE TABLE IF NOT EXISTS segments(
\t\titem_id      TEXT NOT NULL,
\t\tseq          INTEGER NOT NULL,
\t\tkind         TEXT NOT NULL DEFAULT '',
\t\ttext         TEXT NOT NULL,
\t\tcontent_hash TEXT NOT NULL,
\t\tPRIMARY KEY(item_id, seq)
\t)`,
  `CREATE TABLE IF NOT EXISTS quizzes(
\t\titem_id       TEXT PRIMARY KEY,
\t\tquestion_json TEXT NOT NULL,
\t\tcontent_hash  TEXT NOT NULL
\t)`,
  `CREATE TABLE IF NOT EXISTS media_meta(
\t\titem_id           TEXT PRIMARY KEY,
\t\tmime              TEXT NOT NULL DEFAULT '',
\t\tsize              INTEGER NOT NULL DEFAULT 0,
\t\tduration          INTEGER NOT NULL DEFAULT 0,
\t\tchunk_size        INTEGER NOT NULL DEFAULT 0,
\t\tchunk_hashes_json TEXT NOT NULL DEFAULT '[]'
\t)`,
];

const INSERT_ARTICLE = `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev) VALUES(?,?,?,?,?,?,?,?)`;
const INSERT_QUIZ = `INSERT INTO quizzes(item_id,question_json,content_hash) VALUES(?,?,?)`;
const INSERT_MEDIA = `INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json) VALUES(?,?,?,?,?,?)`;
const INSERT_SEGMENT = `INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`;
const INSERT_META = `INSERT INTO meta(key,value) VALUES(?,?)`;

/** 写出 pack.sqlite；path 为最终文件（内部另用 `path + ".tmp"`）。 */
export function writePackSQLite(path: string, rows: PackRows): void {
  const tmp = path + ".tmp";
  rmSync(tmp, { force: true });
  rmSync(path, { force: true });

  const db = new sqlite3.Database(tmp);
  try {
    db.exec("PRAGMA journal_mode=OFF");
    db.exec("PRAGMA synchronous=OFF");
    db.exec("PRAGMA page_size=4096");
    for (const stmt of PACK_DDL) db.exec(stmt);
    db.exec("BEGIN");
    try {
      for (const w of rows.writes) {
        switch (w.kind) {
          case "article":
            db.run(INSERT_ARTICLE, [
              w.row.itemId,
              w.row.title,
              w.row.digest,
              w.row.publishedAt,
              w.row.tagsJson,
              w.row.bodyMd,
              w.row.contentHash,
              w.row.sourceRev,
            ]);
            break;
          case "quiz":
            db.run(INSERT_QUIZ, [w.row.itemId, w.row.questionJson, w.row.contentHash]);
            break;
          case "mediaMeta":
            db.run(INSERT_MEDIA, [
              w.row.itemId,
              w.row.mime,
              w.row.size,
              w.row.duration,
              w.row.chunkSize,
              w.row.chunkHashesJson,
            ]);
            break;
          case "segment":
            db.run(INSERT_SEGMENT, [
              w.row.itemId,
              w.row.seq,
              w.row.kind,
              w.row.text,
              w.row.contentHash,
            ]);
            break;
        }
      }
      for (const [k, v] of rows.meta) db.run(INSERT_META, [k, v]);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.close();
  }

  // VACUUM INTO 不接受绑定参数，路径字面量转义后拼入；用正斜杠与 Go 的 filepath.ToSlash 一致。
  const vac = new sqlite3.Database(tmp);
  try {
    vac.exec("PRAGMA journal_mode=OFF");
    const target = path.replace(/\\/g, "/").replace(/'/g, "''");
    vac.exec("VACUUM INTO '" + target + "'");
  } finally {
    vac.close();
  }
  rmSync(tmp, { force: true });
}

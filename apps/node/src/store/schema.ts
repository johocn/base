// 内容库全量 DDL 与列迁移：**逐字**照抄 `internal/store/schema.go`。
// DDL 文本会进 sqlite_master，字面差异会直接改变后续内容包的字节，故不得改动空白/换行。
// 注意：pack.sqlite 只用其中 articles/segments/quizzes/media_meta/meta 五张表。
import type { HostDb } from "../host/sqlite";

export const schemaStatements: string[] = [
  `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS items(
\t\titem_id      TEXT PRIMARY KEY,
\t\tsource       TEXT NOT NULL,
\t\ttype         TEXT NOT NULL,
\t\ttitle        TEXT NOT NULL DEFAULT '',
\t\tsource_rev   TEXT NOT NULL DEFAULT '',
\t\tcontent_hash TEXT NOT NULL,
\t\tsqlite_table TEXT NOT NULL,
\t\tdist_class   TEXT NOT NULL DEFAULT 'public',
\t\tstate        TEXT NOT NULL DEFAULT 'active',
\t\tupdated_at   TEXT NOT NULL
\t)`,

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

  `CREATE TABLE IF NOT EXISTS blobs(
\t\tblob_id    TEXT PRIMARY KEY,
\t\tsize       INTEGER NOT NULL,
\t\titem_id    TEXT NOT NULL DEFAULT '',
\t\tseq        INTEGER NOT NULL DEFAULT 0,
\t\tcreated_at TEXT NOT NULL
\t)`,

  `CREATE TABLE IF NOT EXISTS packs(
\t\tpack_id         TEXT PRIMARY KEY,
\t\tcontent_version INTEGER NOT NULL,
\t\tdir             TEXT NOT NULL,
\t\tmerkle_root     TEXT NOT NULL,
\t\tsignature       TEXT NOT NULL,
\t\tissued_at       TEXT NOT NULL,
\t\titem_count      INTEGER NOT NULL,
\t\tcreated_at      TEXT NOT NULL
\t)`,

  `CREATE TABLE IF NOT EXISTS tombstones(
\t\titem_id     TEXT PRIMARY KEY,
\t\trevoked_rev INTEGER NOT NULL
\t)`,

  `CREATE TABLE IF NOT EXISTS identities(
\t\tid           TEXT PRIMARY KEY,
\t\talg          TEXT NOT NULL,
\t\tpubkey       TEXT NOT NULL,
\t\tcreated_at   INTEGER NOT NULL,
\t\tlast_seen_at INTEGER NOT NULL DEFAULT 0
\t)`,

  `CREATE TABLE IF NOT EXISTS escrow(
\t\tusername    TEXT PRIMARY KEY,
\t\tid          TEXT NOT NULL,
\t\talg         TEXT NOT NULL,
\t\tsalt        TEXT NOT NULL,
\t\tkdf_json    TEXT NOT NULL,
\t\tenc_nonce   TEXT NOT NULL,
\t\tpriv_cipher TEXT NOT NULL,
\t\tupdated_at  INTEGER NOT NULL
\t)`,

  `CREATE TABLE IF NOT EXISTS auth_nonces(
\t\tid      TEXT NOT NULL,
\t\tnonce   TEXT NOT NULL,
\t\tseen_at INTEGER NOT NULL,
\t\tPRIMARY KEY(id, nonce)
\t)`,

  `CREATE INDEX IF NOT EXISTS idx_auth_nonces_seen_at ON auth_nonces(seen_at)`,

  `CREATE TABLE IF NOT EXISTS events(
\t\tevent_id    TEXT PRIMARY KEY,
\t\tid          TEXT NOT NULL,
\t\ttype        TEXT NOT NULL,
\t\tbody_json   TEXT NOT NULL,
\t\tcreated_at  INTEGER NOT NULL,
\t\treceived_at INTEGER NOT NULL
\t)`,

  `CREATE TABLE IF NOT EXISTS blob_replicas(
\t\tblob_id TEXT NOT NULL,
\t\tpeer    TEXT NOT NULL,
\t\tseen_at INTEGER NOT NULL,
\t\tPRIMARY KEY(blob_id, peer)
\t)`,

  `CREATE TABLE IF NOT EXISTS comment_tombstone(
\t\tevent_id    TEXT PRIMARY KEY,
\t\tpayload_cid TEXT NOT NULL,
\t\treason      TEXT,
\t\tat          INTEGER NOT NULL,
\t\treceived_at INTEGER NOT NULL
\t)`,

  `CREATE INDEX IF NOT EXISTS idx_comment_tombstone_cid ON comment_tombstone(payload_cid)`,
  `CREATE INDEX IF NOT EXISTS idx_comment_tombstone_recv ON comment_tombstone(received_at, event_id)`,

  `CREATE TABLE IF NOT EXISTS peer_sync_cursor(
\t\tpeer       TEXT NOT NULL,
\t\tkind       TEXT NOT NULL,
\t\tcursor_ts  INTEGER NOT NULL,
\t\tcursor_id  TEXT NOT NULL,
\t\tupdated_at INTEGER NOT NULL,
\t\tPRIMARY KEY(peer, kind)
\t)`,

  `CREATE TABLE IF NOT EXISTS profiles(
\t\tid         TEXT PRIMARY KEY,
\t\tname       TEXT NOT NULL,
\t\tupdated_at INTEGER NOT NULL
\t)`,

  `CREATE TABLE IF NOT EXISTS groups(
\t\tgroup_id         TEXT PRIMARY KEY,
\t\tcreator_id       TEXT NOT NULL,
\t\tepoch            INTEGER NOT NULL,
\t\troster_rev       INTEGER NOT NULL DEFAULT 0,
\t\tencrypted        INTEGER NOT NULL DEFAULT 1,
\t\tmember_ids_json  TEXT NOT NULL,
\t\tkey_envelopes    TEXT NOT NULL DEFAULT '[]',
\t\tevent_id         TEXT NOT NULL,
\t\tupdated_at       INTEGER NOT NULL,
\t\torigin           TEXT NOT NULL DEFAULT 'user'
\t)`,

  `CREATE TABLE IF NOT EXISTS govern_proposals(
\t\tproposal_id       INTEGER PRIMARY KEY,
\t\taction            TEXT    NOT NULL,
\t\titem_id           TEXT    NOT NULL,
\t\tproposer_id       TEXT    NOT NULL,
\t\treason            TEXT    NOT NULL DEFAULT '',
\t\ttitle             TEXT    NOT NULL DEFAULT '',
\t\tbody_md           TEXT    NOT NULL DEFAULT '',
\t\tlinks_json        TEXT    NOT NULL DEFAULT '', -- #37 册子 §3.5：tag 型 edit 的载荷（links[] 的规范 JSON）
\t\tbase_content_hash TEXT    NOT NULL,
\t\tcreated_at        INTEGER NOT NULL,
\t\texecuted_at       INTEGER NOT NULL DEFAULT 0,
\t\tvoided_at         INTEGER NOT NULL DEFAULT 0,
\t\texecuted_result   TEXT    NOT NULL DEFAULT '',
\t\tsource_event_id   TEXT,
\t\tcontent_version   INTEGER NOT NULL DEFAULT 0,
\t\trevoked_rev       INTEGER NOT NULL DEFAULT 0
\t)`,

  `CREATE TABLE IF NOT EXISTS govern_votes(
\t\tproposal_id INTEGER NOT NULL,
\t\tvoter_id    TEXT    NOT NULL,
\t\tcreated_at  INTEGER NOT NULL,
\t\tsource_event_id TEXT,
\t\tPRIMARY KEY(proposal_id, voter_id)
\t)`,

  `CREATE INDEX IF NOT EXISTS idx_govern_proposals_item ON govern_proposals(item_id, action)`,

  `CREATE TABLE IF NOT EXISTS tag_links(
\t\ttag_id     TEXT NOT NULL,
\t\ttarget_id  TEXT NOT NULL,
\t\tkind       TEXT NOT NULL,
\t\tcreated_at TEXT NOT NULL,
\t\tPRIMARY KEY (tag_id, target_id)
\t)`,

  `CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_id)`,

  `CREATE TABLE IF NOT EXISTS progress(
\t\tid         TEXT    NOT NULL,
\t\titem_id    TEXT    NOT NULL,
\t\tposition   INTEGER NOT NULL,
\t\tdone       INTEGER NOT NULL,
\t\tday        TEXT    NOT NULL,
\t\tupdated_at INTEGER NOT NULL,
\t\tevent_id   TEXT    NOT NULL,
\t\tdirty      INTEGER NOT NULL DEFAULT 0,
\t\tPRIMARY KEY(id, item_id)
\t)`,

  `CREATE INDEX IF NOT EXISTS idx_progress_item ON progress(item_id)`,

  `CREATE TABLE IF NOT EXISTS checkin_days(
\t\tid             TEXT    NOT NULL,
\t\tday            TEXT    NOT NULL,
\t\tfirst_event_id TEXT    NOT NULL,
\t\tcreated_at     INTEGER NOT NULL,
\t\tPRIMARY KEY(id, day)
\t)`,

  `CREATE TABLE IF NOT EXISTS directory_terms(
\t\tkind            TEXT NOT NULL,
\t\tterm_key        TEXT NOT NULL,
\t\tdisplay_name    TEXT NOT NULL,
\t\tstate           TEXT NOT NULL,
\t\tfirst_author_id TEXT NOT NULL DEFAULT '',
\t\tcreated_at      TEXT NOT NULL,
\t\tupdated_at      TEXT NOT NULL,
\t\tPRIMARY KEY(kind, term_key)
\t)`,
  `CREATE INDEX IF NOT EXISTS idx_directory_terms_state ON directory_terms(kind, state)`,

  // circle_assignments：圆圈归属声明（融合治理册 §2.2）。**节点侧独立数据面**——
  // 不新增 items 行、不进 segments、不进内容包。主键 (item_id, circle_id)，**只插不删**（无删除路径）。
  // 新表（无存量列演进问题），故直接进 schemaStatements，不入 ColumnMigrations。
  `CREATE TABLE IF NOT EXISTS circle_assignments(
\t\titem_id    TEXT    NOT NULL,
\t\tcircle_id  TEXT    NOT NULL,
\t\torigin     TEXT    NOT NULL DEFAULT 'fusion', -- fusion | user
\t\tcreated_at INTEGER NOT NULL,
\t\tPRIMARY KEY(item_id, circle_id)
\t)`,
];

// events 表的后加列（B 阶段引入）。
export const eventColumnMigrations: { column: string; ddl: string }[] = [
  { column: "target_id", ddl: `ALTER TABLE events ADD COLUMN target_id TEXT` },
  { column: "payload_cid", ddl: `ALTER TABLE events ADD COLUMN payload_cid TEXT` },
  { column: "reply_to", ddl: `ALTER TABLE events ADD COLUMN reply_to TEXT` },
];

// items 表的后加列（治理册 §3.1 的归属缓存）。
export const itemColumnMigrations: { column: string; ddl: string }[] = [
  { column: "author_id", ddl: `ALTER TABLE items ADD COLUMN author_id TEXT NOT NULL DEFAULT ''` },
  { column: "author_sig", ddl: `ALTER TABLE items ADD COLUMN author_sig TEXT NOT NULL DEFAULT ''` },
];

// groups 表的后加列（#33 册子 §3.8）。
export const groupColumnMigrations: { column: string; ddl: string }[] = [
  { column: "roster_rev", ddl: `ALTER TABLE groups ADD COLUMN roster_rev INTEGER NOT NULL DEFAULT 0` },
  { column: "encrypted", ddl: `ALTER TABLE groups ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 1` },
  { column: "key_envelopes", ddl: `ALTER TABLE groups ADD COLUMN key_envelopes TEXT NOT NULL DEFAULT '[]'` },
  { column: "origin", ddl: `ALTER TABLE groups ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'` },
];

// govern_* 两表的后加列（#33 册子 §4.4）。
export const governColumnMigrations: { table: string; column: string; ddl: string }[] = [
  {
    table: "govern_proposals",
    column: "source_event_id",
    ddl: `ALTER TABLE govern_proposals ADD COLUMN source_event_id TEXT`,
  },
  {
    table: "govern_proposals",
    column: "content_version",
    ddl: `ALTER TABLE govern_proposals ADD COLUMN content_version INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: "govern_proposals",
    column: "revoked_rev",
    ddl: `ALTER TABLE govern_proposals ADD COLUMN revoked_rev INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: "govern_votes",
    column: "source_event_id",
    ddl: `ALTER TABLE govern_votes ADD COLUMN source_event_id TEXT`,
  },
  {
    table: "govern_proposals",
    column: "links_json",
    ddl: `ALTER TABLE govern_proposals ADD COLUMN links_json TEXT NOT NULL DEFAULT ''`,
  },
];

export const eventIndexStatements: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_id, created_at DESC, event_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_recent ON events(created_at DESC, event_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at ASC, event_id ASC)`,
];

/** `PRAGMA table_info(<table>)` 的列名集合（表名为包内字面量，非外部输入）。 */
export function tableColumns(db: HostDb, table: string): Set<string> {
  const rows = db.all(`PRAGMA table_info(` + table + `)`);
  const cols = new Set<string>();
  for (const row of rows) cols.add(String(row.name));
  return cols;
}

/** 执行 schemaStatements 之后的幂等迁移；顺序与 `schema.go:307-369` 一致（索引必须在补列之后建）。 */
export function migrate(db: HostDb): void {
  const cols = tableColumns(db, "events");
  for (const m of eventColumnMigrations) {
    if (cols.has(m.column)) continue;
    try {
      db.exec(m.ddl);
    } catch (err) {
      throw new Error(`store: migrate events.${m.column}: ${String(err)}`);
    }
  }
  // 索引必须在补列**之后**建：idx_events_target 引用新列，老库上先建会失败。
  for (const stmt of eventIndexStatements) {
    try {
      db.exec(stmt);
    } catch (err) {
      throw new Error(`store: migrate events index: ${String(err)}`);
    }
  }
  const itemCols = tableColumns(db, "items");
  for (const m of itemColumnMigrations) {
    if (itemCols.has(m.column)) continue;
    try {
      db.exec(m.ddl);
    } catch (err) {
      throw new Error(`store: migrate items.${m.column}: ${String(err)}`);
    }
  }
  // 索引必须在补列之后建：idx_items_author 引用新列。
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_author ON items(author_id, state)`);
  } catch (err) {
    throw new Error(`store: migrate items index: ${String(err)}`);
  }
  const groupCols = tableColumns(db, "groups");
  for (const m of groupColumnMigrations) {
    if (groupCols.has(m.column)) continue;
    try {
      db.exec(m.ddl);
    } catch (err) {
      throw new Error(`store: migrate groups.${m.column}: ${String(err)}`);
    }
  }
  // govern_* 两表的后加列：按表分别取列集合再逐条补。
  for (const m of governColumnMigrations) {
    const cols2 = tableColumns(db, m.table);
    if (cols2.has(m.column)) continue;
    try {
      db.exec(m.ddl);
    } catch (err) {
      throw new Error(`store: migrate ${m.table}.${m.column}: ${String(err)}`);
    }
  }
}

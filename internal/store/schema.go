package store

import (
	"database/sql"
	"fmt"
)

// schemaStatements 是内容库的建表语句（按序执行，幂等）。
// 注意：pack.sqlite 只用其中 articles/segments/quizzes/media_meta/meta 五张表，
// 导出侧在 internal/packexport 里有同样的五张表 DDL（列顺序必须一致）。
// escrow.priv_cipher 是客户端密文，节点只存不解释（不派生密钥、不解密、不校验密码）。
var schemaStatements = []string{
	`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

	`CREATE TABLE IF NOT EXISTS items(
		item_id      TEXT PRIMARY KEY,
		source       TEXT NOT NULL,
		type         TEXT NOT NULL,
		title        TEXT NOT NULL DEFAULT '',
		source_rev   TEXT NOT NULL DEFAULT '',
		content_hash TEXT NOT NULL,
		sqlite_table TEXT NOT NULL,
		dist_class   TEXT NOT NULL DEFAULT 'public',
		state        TEXT NOT NULL DEFAULT 'active',
		updated_at   TEXT NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS articles(
		item_id      TEXT PRIMARY KEY,
		title        TEXT NOT NULL DEFAULT '',
		digest       TEXT NOT NULL DEFAULT '',
		published_at TEXT NOT NULL DEFAULT '',
		tags_json    TEXT NOT NULL DEFAULT '[]',
		body_md      TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		source_rev   TEXT NOT NULL DEFAULT ''
	)`,

	`CREATE TABLE IF NOT EXISTS segments(
		item_id      TEXT NOT NULL,
		seq          INTEGER NOT NULL,
		kind         TEXT NOT NULL DEFAULT '',
		text         TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		PRIMARY KEY(item_id, seq)
	)`,

	`CREATE TABLE IF NOT EXISTS quizzes(
		item_id       TEXT PRIMARY KEY,
		question_json TEXT NOT NULL,
		content_hash  TEXT NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS media_meta(
		item_id           TEXT PRIMARY KEY,
		mime              TEXT NOT NULL DEFAULT '',
		size              INTEGER NOT NULL DEFAULT 0,
		duration          INTEGER NOT NULL DEFAULT 0,
		chunk_size        INTEGER NOT NULL DEFAULT 0,
		chunk_hashes_json TEXT NOT NULL DEFAULT '[]'
	)`,

	`CREATE TABLE IF NOT EXISTS blobs(
		blob_id    TEXT PRIMARY KEY,
		size       INTEGER NOT NULL,
		item_id    TEXT NOT NULL DEFAULT '',
		seq        INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS packs(
		pack_id         TEXT PRIMARY KEY,
		content_version INTEGER NOT NULL,
		dir             TEXT NOT NULL,
		merkle_root     TEXT NOT NULL,
		signature       TEXT NOT NULL,
		issued_at       TEXT NOT NULL,
		item_count      INTEGER NOT NULL,
		created_at      TEXT NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS tombstones(
		item_id     TEXT PRIMARY KEY,
		revoked_rev INTEGER NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS identities(
		id           TEXT PRIMARY KEY,
		alg          TEXT NOT NULL,
		pubkey       TEXT NOT NULL,
		created_at   INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL DEFAULT 0
	)`,

	`CREATE TABLE IF NOT EXISTS escrow(
		username    TEXT PRIMARY KEY,
		id          TEXT NOT NULL,
		alg         TEXT NOT NULL,
		salt        TEXT NOT NULL,
		kdf_json    TEXT NOT NULL,
		enc_nonce   TEXT NOT NULL,
		priv_cipher TEXT NOT NULL,
		updated_at  INTEGER NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS auth_nonces(
		id      TEXT NOT NULL,
		nonce   TEXT NOT NULL,
		seen_at INTEGER NOT NULL,
		PRIMARY KEY(id, nonce)
	)`,

	`CREATE INDEX IF NOT EXISTS idx_auth_nonces_seen_at ON auth_nonces(seen_at)`,

	`CREATE TABLE IF NOT EXISTS events(
		event_id    TEXT PRIMARY KEY,
		id          TEXT NOT NULL,
		type        TEXT NOT NULL,
		body_json   TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		received_at INTEGER NOT NULL
	)`,

	// blob_replicas：peer 存 BASE_PEERS 里的 url；一行 = 「那个 peer 曾经声明持有该块」，
	// 与本地是否持有无关；长期离线不删行，seen_at 供运维判断新鲜度。
	`CREATE TABLE IF NOT EXISTS blob_replicas(
		blob_id TEXT NOT NULL,
		peer    TEXT NOT NULL,
		seen_at INTEGER NOT NULL,
		PRIMARY KEY(blob_id, peer)
	)`,

	// comment_tombstone：评论审核删除的墓碑（册子 §5.2）。
	// 一行 = 「这条评论的正文块已被审核删除」；随事件反熵传播，各节点据此删块且不再拉回。
	`CREATE TABLE IF NOT EXISTS comment_tombstone(
		event_id    TEXT PRIMARY KEY,
		payload_cid TEXT NOT NULL,
		reason      TEXT,
		at          INTEGER NOT NULL,
		received_at INTEGER NOT NULL
	)`,

	`CREATE INDEX IF NOT EXISTS idx_comment_tombstone_cid ON comment_tombstone(payload_cid)`,
	`CREATE INDEX IF NOT EXISTS idx_comment_tombstone_recv ON comment_tombstone(received_at, event_id)`,

	// peer_sync_cursor：节点↔节点事件增量拉取的进度（册子 §5.2）。
	// 一行 = 对某 peer 某 kind（event / tombstone）已拉到 (cursor_ts, cursor_id)，严格递增。
	`CREATE TABLE IF NOT EXISTS peer_sync_cursor(
		peer       TEXT NOT NULL,
		kind       TEXT NOT NULL,
		cursor_ts  INTEGER NOT NULL,
		cursor_id  TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY(peer, kind)
	)`,

	// profiles：身份**主动设置**的公开昵称（治理册 §3.2）。
	// 展示层：不跨节点同步、不进 events、不参与反熵；与 escrow.username 无关，不复用、不因本册公开。
	`CREATE TABLE IF NOT EXISTS profiles(
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
}

// eventColumnMigrations 是 events 表的**后加列**（B 阶段引入）。
// schemaStatements 全是 CREATE TABLE/INDEX IF NOT EXISTS——对既有表不会补列，
// 因此必须做列存在性检查再逐条 ALTER，否则老库上 SELECT 这些列会直接报错。
var eventColumnMigrations = []struct{ column, ddl string }{
	{"target_id", `ALTER TABLE events ADD COLUMN target_id TEXT`},
	{"payload_cid", `ALTER TABLE events ADD COLUMN payload_cid TEXT`},
	{"reply_to", `ALTER TABLE events ADD COLUMN reply_to TEXT`},
}

// itemColumnMigrations 是 items 表的**后加列**（治理册 §3.1 的归属缓存）。
// 与 events 同因：schemaStatements 全是 CREATE TABLE IF NOT EXISTS，对既有表不补列。
var itemColumnMigrations = []struct{ column, ddl string }{
	{"author_id", `ALTER TABLE items ADD COLUMN author_id TEXT NOT NULL DEFAULT ''`},
	{"author_sig", `ALTER TABLE items ADD COLUMN author_sig TEXT NOT NULL DEFAULT ''`},
}

// migrate 执行 schemaStatements 之后的幂等迁移。
func migrate(db *sql.DB) error {
	cols, err := tableColumns(db, "events")
	if err != nil {
		return err
	}
	for _, m := range eventColumnMigrations {
		if cols[m.column] {
			continue
		}
		if _, err := db.Exec(m.ddl); err != nil {
			return fmt.Errorf("store: migrate events.%s: %w", m.column, err)
		}
	}
	// 索引必须在补列**之后**建：idx_events_target 引用新列，老库上先建会失败。
	for _, stmt := range eventIndexStatements {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("store: migrate events index: %w", err)
		}
	}
	itemCols, err := tableColumns(db, "items")
	if err != nil {
		return err
	}
	for _, m := range itemColumnMigrations {
		if itemCols[m.column] {
			continue
		}
		if _, err := db.Exec(m.ddl); err != nil {
			return fmt.Errorf("store: migrate items.%s: %w", m.column, err)
		}
	}
	// 索引必须在补列之后建：idx_items_author 引用新列。
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_items_author ON items(author_id, state)`); err != nil {
		return fmt.Errorf("store: migrate items index: %w", err)
	}
	return nil
}

var eventIndexStatements = []string{
	`CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_id, created_at DESC, event_id DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_events_recent ON events(created_at DESC, event_id DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at ASC, event_id ASC)`,
}

// tableColumns 返回表的列名集合（表名为本包内的字面量，非外部输入）。
func tableColumns(db *sql.DB, table string) (map[string]bool, error) {
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols := map[string]bool{}
	for rows.Next() {
		var (
			cid     int
			name    string
			ctype   string
			notNull int
			dflt    sql.NullString
			pk      int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notNull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols[name] = true
	}
	return cols, rows.Err()
}

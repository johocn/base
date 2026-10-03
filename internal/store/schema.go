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

	// groups：小组名单投影（第 9 册 §4.2）。**节点侧唯一的组状态**——
	// 只含 id 列表与 epoch，不含任何密钥、不解密任何内容（总纲 §3.1）。
	// 首个 epoch=1 的 roster 事件锁定 creator_id；后续事件必须同 actor 且 epoch 严格更大。
	// event_id 指向最新一条 roster 事件（组名 name 在它的 body_json 里，故本表不存 name）。
	`CREATE TABLE IF NOT EXISTS groups(
		group_id         TEXT PRIMARY KEY,
		creator_id       TEXT NOT NULL,
		epoch            INTEGER NOT NULL,
		roster_rev       INTEGER NOT NULL DEFAULT 0,
		encrypted        INTEGER NOT NULL DEFAULT 1,
		member_ids_json  TEXT NOT NULL,
		key_envelopes    TEXT NOT NULL DEFAULT '[]',
		event_id         TEXT NOT NULL,
		updated_at       INTEGER NOT NULL,
		origin           TEXT NOT NULL DEFAULT 'user'
	)`,

	// govern_proposals / govern_votes：审批治理的提案与票（第 3 册 §5.1）。
	// #33 起降级为**本地物化视图**：事件是权威来源，`govern.v1` 事件投影写入这两表，
	// `source_event_id` 指回来源事件（可空；NULL = 本地路径写入的提案 / 票）。
	// 只存本节点，老路径不进 events、不参与反熵、不跨节点同步（§2.5）。
	`CREATE TABLE IF NOT EXISTS govern_proposals(
		proposal_id       INTEGER PRIMARY KEY,
		action            TEXT    NOT NULL,
		item_id           TEXT    NOT NULL,
		proposer_id       TEXT    NOT NULL,
		reason            TEXT    NOT NULL DEFAULT '',
		title             TEXT    NOT NULL DEFAULT '',
		body_md           TEXT    NOT NULL DEFAULT '',
		links_json        TEXT    NOT NULL DEFAULT '', -- #37 册子 §3.5：tag 型 edit 的载荷（links[] 的规范 JSON）
		base_content_hash TEXT    NOT NULL,
		created_at        INTEGER NOT NULL,
		executed_at       INTEGER NOT NULL DEFAULT 0,
		voided_at         INTEGER NOT NULL DEFAULT 0,
		executed_result   TEXT    NOT NULL DEFAULT '',
		source_event_id   TEXT,
		content_version   INTEGER NOT NULL DEFAULT 0,
		revoked_rev       INTEGER NOT NULL DEFAULT 0
	)`,

	`CREATE TABLE IF NOT EXISTS govern_votes(
		proposal_id INTEGER NOT NULL,
		voter_id    TEXT    NOT NULL,
		created_at  INTEGER NOT NULL,
		source_event_id TEXT,
		PRIMARY KEY(proposal_id, voter_id)
	)`,

	`CREATE INDEX IF NOT EXISTS idx_govern_proposals_item ON govern_proposals(item_id, action)`,

	// tag_links：统一标签与内容的关联（#37 册子 §3.2）。**节点侧唯一权威**——
	// 内容包不加表，导出靠同一次写入物化出的 segments 行传播（§3.3）。
	// 目标被下架（remove）后**不做级联删除**：悬空引用由客户端静默跳过（§3.2）。
	`CREATE TABLE IF NOT EXISTS tag_links(
		tag_id     TEXT NOT NULL,
		target_id  TEXT NOT NULL,
		kind       TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (tag_id, target_id)
	)`,

	`CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_id)`,

	// progress / checkin_days：学习进度与打卡的**两张投影表**（#8 册子 §4.2）。
	// 一条 progress.v1 事件**同一事务**同时写这两张表：
	//   progress     = (id,item_id) 的 LWW 寄存器（§3.3 / §3.4），只留胜者；
	//   checkin_days = 打卡日集合（§3.5），insert-or-ignore 保留首次。
	// 打卡日**不能**从 progress 派生：(id,item_id) 只留最后一次的 day，会把该条目历史上的打卡日冲掉。
	// 两表都是新表（无存量列演进问题），故直接进 schemaStatements，不需要 ColumnMigrations。
	`CREATE TABLE IF NOT EXISTS progress(
		id         TEXT    NOT NULL,
		item_id    TEXT    NOT NULL,
		position   INTEGER NOT NULL,
		done       INTEGER NOT NULL,
		day        TEXT    NOT NULL,
		updated_at INTEGER NOT NULL,
		event_id   TEXT    NOT NULL,
		dirty      INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY(id, item_id)
	)`,

	`CREATE INDEX IF NOT EXISTS idx_progress_item ON progress(item_id)`,

	`CREATE TABLE IF NOT EXISTS checkin_days(
		id             TEXT    NOT NULL,
		day            TEXT    NOT NULL,
		first_event_id TEXT    NOT NULL,
		created_at     INTEGER NOT NULL,
		PRIMARY KEY(id, day)
	)`,

	// directory_terms：节点级词条目录（册子 #58 §2.1）。**节点侧独立数据面**——
	// 不新增 items 行、不进 segments、不进内容包。主键 (kind, term_key)。
	// 新表（无存量列演进问题），故直接进 schemaStatements，不入 ColumnMigrations。
	`CREATE TABLE IF NOT EXISTS directory_terms(
		kind            TEXT NOT NULL,
		term_key        TEXT NOT NULL,
		display_name    TEXT NOT NULL,
		state           TEXT NOT NULL,
		first_author_id TEXT NOT NULL DEFAULT '',
		created_at      TEXT NOT NULL,
		updated_at      TEXT NOT NULL,
		PRIMARY KEY(kind, term_key)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_directory_terms_state ON directory_terms(kind, state)`,

	// circle_assignments：圆圈归属声明（融合治理册 §2.2）。**节点侧独立数据面**——
	// 不新增 items 行、不进 segments、不进内容包。主键 (item_id, circle_id)，**只插不删**（无删除路径）。
	// 新表（无存量列演进问题），故直接进 schemaStatements，不入 ColumnMigrations。
	`CREATE TABLE IF NOT EXISTS circle_assignments(
		item_id    TEXT    NOT NULL,
		circle_id  TEXT    NOT NULL,
		origin     TEXT    NOT NULL DEFAULT 'fusion', -- fusion | user
		created_at INTEGER NOT NULL,
		PRIMARY KEY(item_id, circle_id)
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

// groupColumnMigrations 是 groups 表的**后加列**（#33 册子 §3.8）。
// 与 events / items 同因：schemaStatements 全是 CREATE TABLE IF NOT EXISTS，对既有表不补列。
// 存量行 encrypted 默认 1（语义不变：「存量小组一律加密」，册子 §3.1 / AC 13）。
var groupColumnMigrations = []struct{ column, ddl string }{
	{"roster_rev", `ALTER TABLE groups ADD COLUMN roster_rev INTEGER NOT NULL DEFAULT 0`},
	{"encrypted", `ALTER TABLE groups ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 1`},
	{"key_envelopes", `ALTER TABLE groups ADD COLUMN key_envelopes TEXT NOT NULL DEFAULT '[]'`},
	{"origin", `ALTER TABLE groups ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`},
}

// governColumnMigrations 是 govern_* 两表的**后加列**（#33 册子 §4.4）。
// 两表由本册降级为「本地物化视图」：事件是权威来源，投影列只供既有读接口与兼容期回读。
// 与 events / items / groups 同因：schemaStatements 全是 CREATE TABLE IF NOT EXISTS，对既有表不补列。
var governColumnMigrations = []struct{ table, column, ddl string }{
	{"govern_proposals", "source_event_id", `ALTER TABLE govern_proposals ADD COLUMN source_event_id TEXT`},
	{"govern_proposals", "content_version", `ALTER TABLE govern_proposals ADD COLUMN content_version INTEGER NOT NULL DEFAULT 0`},
	{"govern_proposals", "revoked_rev", `ALTER TABLE govern_proposals ADD COLUMN revoked_rev INTEGER NOT NULL DEFAULT 0`},
	{"govern_votes", "source_event_id", `ALTER TABLE govern_votes ADD COLUMN source_event_id TEXT`},
	{"govern_proposals", "links_json", `ALTER TABLE govern_proposals ADD COLUMN links_json TEXT NOT NULL DEFAULT ''`},
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
	groupCols, err := tableColumns(db, "groups")
	if err != nil {
		return err
	}
	for _, m := range groupColumnMigrations {
		if groupCols[m.column] {
			continue
		}
		if _, err := db.Exec(m.ddl); err != nil {
			return fmt.Errorf("store: migrate groups.%s: %w", m.column, err)
		}
	}
	// govern_* 两表的后加列（#33 §4.4）：按表分别取列集合再逐条补。
	for _, m := range governColumnMigrations {
		cols, err := tableColumns(db, m.table)
		if err != nil {
			return err
		}
		if cols[m.column] {
			continue
		}
		if _, err := db.Exec(m.ddl); err != nil {
			return fmt.Errorf("store: migrate %s.%s: %w", m.table, m.column, err)
		}
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

package store

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
}

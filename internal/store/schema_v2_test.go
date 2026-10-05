package store

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// TestFavoritesTableSchema 覆盖 V2：favorites 表存在，列/主键/索引符合 DDL。
func TestFavoritesTableSchema(t *testing.T) {
	st := openTemp(t)
	cols := tableInfo(t, st.db, "favorites")
	want := []columnInfo{
		{name: "id", ctype: "TEXT", notNull: 1, pk: 1},
		{name: "item_id", ctype: "TEXT", notNull: 1, pk: 2},
		{name: "created_at", ctype: "INTEGER", notNull: 1, pk: 0},
	}
	if len(cols) != len(want) {
		t.Fatalf("favorites 列数=%d, want %d: %+v", len(cols), len(want), cols)
	}
	for i, c := range cols {
		w := want[i]
		if c.name != w.name || c.ctype != w.ctype || c.notNull != w.notNull || c.pk != w.pk {
			t.Fatalf("列 %d 结构不符: 得 %+v want %+v", i, c, w)
		}
	}
	// 索引 idx_favorites_item 存在
	var idxName string
	if err := st.db.QueryRow(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_favorites_item'`).Scan(&idxName); err != nil {
		t.Fatalf("idx_favorites_item 不存在: %v", err)
	}
}

// TestGovernVotesV2Columns 覆盖 V2：govern_votes 有 vote_weight/vote_type/date 三列且 DEFAULT 正确。
func TestGovernVotesV2Columns(t *testing.T) {
	st := openTemp(t)
	cols, err := tableColumns(st.db, "govern_votes")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"vote_weight", "vote_type", "date"} {
		if !cols[c] {
			t.Fatalf("govern_votes 缺列 %q", c)
		}
	}
	sql := tableSQL(t, st.db, "govern_votes")
	if !strings.Contains(sql, "vote_weight") || !strings.Contains(sql, "vote_type") || !strings.Contains(sql, "date") {
		t.Fatalf("govern_votes 建表语句缺 V2 列:\n%s", sql)
	}
}

// TestGovernProposalsV2Columns 覆盖 V2：govern_proposals 有 governance_level/category/circle_id 三列。
func TestGovernProposalsV2Columns(t *testing.T) {
	st := openTemp(t)
	cols, err := tableColumns(st.db, "govern_proposals")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"governance_level", "category", "circle_id"} {
		if !cols[c] {
			t.Fatalf("govern_proposals 缺列 %q", c)
		}
	}
}

// TestItemsV2Columns 覆盖 V2：items 有 pin_level/pinned_at/highlight_until 三列。
func TestItemsV2Columns(t *testing.T) {
	st := openTemp(t)
	cols, err := tableColumns(st.db, "items")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"pin_level", "pinned_at", "highlight_until"} {
		if !cols[c] {
			t.Fatalf("items 缺列 %q", c)
		}
	}
}

// TestMigrateSchemaV2OnLegacyDb 覆盖老库迁移：只有老 schema 的库，Open 之后补全所有 V2 列和 favorites 表。
func TestMigrateSchemaV2OnLegacyDb(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "base.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath))
	if err != nil {
		t.Fatal(err)
	}
	// 建老库 items（只有老列，无 V2 pin_level 等）
	if _, err := db.Exec(`CREATE TABLE items(
		item_id TEXT PRIMARY KEY, source TEXT NOT NULL, type TEXT NOT NULL,
		title TEXT NOT NULL DEFAULT '', source_rev TEXT NOT NULL DEFAULT '',
		content_hash TEXT NOT NULL, sqlite_table TEXT NOT NULL,
		dist_class TEXT NOT NULL DEFAULT 'public', state TEXT NOT NULL DEFAULT 'active',
		tags_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
		author_id TEXT NOT NULL DEFAULT '', author_sig TEXT NOT NULL DEFAULT ''
	)`); err != nil {
		t.Fatal(err)
	}
	// 老 govern_votes（无 V2 三列）
	if _, err := db.Exec(`CREATE TABLE govern_votes(
		proposal_id INTEGER NOT NULL, voter_id TEXT NOT NULL,
		created_at INTEGER NOT NULL, source_event_id TEXT,
		PRIMARY KEY(proposal_id, voter_id)
	)`); err != nil {
		t.Fatal(err)
	}
	// 老 govern_proposals（无 V2 三列）
	if _, err := db.Exec(`CREATE TABLE govern_proposals(
		proposal_id INTEGER PRIMARY KEY, action TEXT NOT NULL, item_id TEXT NOT NULL,
		proposer_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
		body_md TEXT NOT NULL DEFAULT '', links_json TEXT NOT NULL DEFAULT '',
		base_content_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
		executed_at INTEGER NOT NULL DEFAULT 0, voided_at INTEGER NOT NULL DEFAULT 0,
		executed_result TEXT NOT NULL DEFAULT '', source_event_id TEXT,
		content_version INTEGER NOT NULL DEFAULT 0, revoked_rev INTEGER NOT NULL DEFAULT 0
	)`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open(老库): %v", err)
	}
	defer func() { _ = st.Close() }()

	// govern_votes V2 列
	if cols, _ := tableColumns(st.db, "govern_votes"); !cols["vote_weight"] || !cols["vote_type"] || !cols["date"] {
		t.Fatalf("老库 govern_votes 未补 V2 列: %v", cols)
	}
	// govern_proposals V2 列
	if cols, _ := tableColumns(st.db, "govern_proposals"); !cols["governance_level"] || !cols["category"] || !cols["circle_id"] {
		t.Fatalf("老库 govern_proposals 未补 V2 列: %v", cols)
	}
	// items V2 列
	if cols, _ := tableColumns(st.db, "items"); !cols["pin_level"] || !cols["pinned_at"] || !cols["highlight_until"] {
		t.Fatalf("老库 items 未补 V2 列: %v", cols)
	}
	// favorites 表（整个表都是新的）
	if cols, _ := tableColumns(st.db, "favorites"); len(cols) == 0 {
		t.Fatalf("老库未创建 favorites 表")
	}
}

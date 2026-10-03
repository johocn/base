package store

import (
	"database/sql"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// columnInfo 是 PRAGMA table_info 的一行（供结构断言与两侧对拍）。
type columnInfo struct {
	name    string
	ctype   string
	notNull int
	dflt    sql.NullString
	pk      int
}

func tableInfo(t *testing.T, db *sql.DB, table string) []columnInfo {
	t.Helper()
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		t.Fatalf("PRAGMA table_info(%s): %v", table, err)
	}
	defer rows.Close()
	var out []columnInfo
	for rows.Next() {
		var (
			ci  columnInfo
			cid int
		)
		if err := rows.Scan(&cid, &ci.name, &ci.ctype, &ci.notNull, &ci.dflt, &ci.pk); err != nil {
			t.Fatalf("scan table_info(%s): %v", table, err)
		}
		out = append(out, ci)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("table_info(%s): %v", table, err)
	}
	return out
}

// tableSQL 读 sqlite_master 里建表语句的原文（供两侧对拍）。
func tableSQL(t *testing.T, db *sql.DB, table string) string {
	t.Helper()
	var s string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&s); err != nil {
		t.Fatalf("sqlite_master(%s): %v", table, err)
	}
	return s
}

// TestCircleAssignmentsTableSchema 覆盖 T1 用例 1：新表存在，列名/类型/主键与 DDL 一致。
func TestCircleAssignmentsTableSchema(t *testing.T) {
	st := openTemp(t)
	cols := tableInfo(t, st.db, "circle_assignments")
	want := []columnInfo{
		{name: "item_id", ctype: "TEXT", notNull: 1, pk: 1},
		{name: "circle_id", ctype: "TEXT", notNull: 1, pk: 2},
		{name: "origin", ctype: "TEXT", notNull: 1, pk: 0},
		{name: "created_at", ctype: "INTEGER", notNull: 1, pk: 0},
	}
	if len(cols) != len(want) {
		t.Fatalf("circle_assignments 列数=%d, want %d: %+v", len(cols), len(want), cols)
	}
	for i, c := range cols {
		w := want[i]
		if c.name != w.name || c.ctype != w.ctype || c.notNull != w.notNull || c.pk != w.pk {
			t.Fatalf("列 %d 结构不符: 得 %+v want %+v", i, c, w)
		}
	}
	// origin 缺省须为 fusion（字符串字面量在 table_info 里带引号，故去引号比对）。
	if got := strings.Trim(cols[2].dflt.String, "'"); !cols[2].dflt.Valid || got != "fusion" {
		t.Fatalf("origin 缺省 = %v, want fusion", cols[2].dflt)
	}
	sql := tableSQL(t, st.db, "circle_assignments")
	if !strings.Contains(sql, "PRIMARY KEY(item_id, circle_id)") || !strings.Contains(sql, "DEFAULT 'fusion'") {
		t.Fatalf("circle_assignments 建表语句不符 DDL:\n%s", sql)
	}
}

// TestSchemaOpenIsIdempotent 覆盖 T1 用例 2：同一库连开两次不报错、结构不变。
func TestSchemaOpenIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	sql1 := tableSQL(t, st.db, "circle_assignments")
	groups1 := tableInfo(t, st.db, "groups")
	if err := st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("二次 Open: %v", err)
	}
	defer func() { _ = st2.Close() }()
	if got := tableSQL(t, st2.db, "circle_assignments"); got != sql1 {
		t.Fatalf("二次开库 circle_assignments DDL 变化:\n%s\n%s", got, sql1)
	}
	if got := tableInfo(t, st2.db, "groups"); !reflect.DeepEqual(got, groups1) {
		t.Fatalf("二次开库 groups 结构变化: %+v / %+v", got, groups1)
	}
}

// TestMigrateAddsGroupOriginToLegacyDb 覆盖 T1 用例 3：老库（groups 无 origin 列）升级后补列，存量行取 user。
func TestMigrateAddsGroupOriginToLegacyDb(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "base.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath))
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	// 老库：模拟 #33 之后、本册之前的 groups 表（有 roster_rev/encrypted/key_envelopes，无 origin）。
	if _, err := db.Exec(`CREATE TABLE groups(
		group_id         TEXT PRIMARY KEY,
		creator_id       TEXT NOT NULL,
		epoch            INTEGER NOT NULL,
		roster_rev       INTEGER NOT NULL DEFAULT 0,
		encrypted        INTEGER NOT NULL DEFAULT 1,
		member_ids_json  TEXT NOT NULL,
		key_envelopes    TEXT NOT NULL DEFAULT '[]',
		event_id         TEXT NOT NULL,
		updated_at       INTEGER NOT NULL
	)`); err != nil {
		t.Fatalf("建老 groups: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
		VALUES('g-old','id-a',1,1,1,'["id-a"]','[]','e1',1)`); err != nil {
		t.Fatalf("插老行: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open(老库): %v", err)
	}
	defer func() { _ = st.Close() }()
	cols, err := tableColumns(st.db, "groups")
	if err != nil {
		t.Fatal(err)
	}
	if !cols["origin"] {
		t.Fatalf("老库升级后 groups 缺 origin 列: %v", cols)
	}
	var origin string
	if err := st.db.QueryRow(`SELECT origin FROM groups WHERE group_id='g-old'`).Scan(&origin); err != nil {
		t.Fatalf("读存量行 origin: %v", err)
	}
	if origin != "user" {
		t.Fatalf("存量行 origin=%q, want user", origin)
	}
}

// TestNewGroupOriginDefaultsToUser 覆盖 T1 用例 4：新建圈子 origin 默认 user。
func TestNewGroupOriginDefaultsToUser(t *testing.T) {
	st := openTemp(t)
	if err := st.PutGroupRoster(GroupRoster{
		GroupID: "g-new", CreatorID: "id-a", Epoch: 1,
		MemberIDsJSON: `["id-a"]`, EventID: "e1", UpdatedAt: 1,
	}); err != nil {
		t.Fatalf("PutGroupRoster: %v", err)
	}
	var origin string
	if err := st.db.QueryRow(`SELECT origin FROM groups WHERE group_id='g-new'`).Scan(&origin); err != nil {
		t.Fatalf("读 origin: %v", err)
	}
	if origin != "user" {
		t.Fatalf("新圈子 origin=%q, want user", origin)
	}
}

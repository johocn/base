package store

import "testing"

func TestMigrateAddsAuthorColumnsAndProfiles(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	cols, err := tableColumns(st.db, "items")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"author_id", "author_sig"} {
		if !cols[c] {
			t.Fatalf("items 缺少列 %s", c)
		}
	}
	if !cols["state"] {
		t.Fatal("items 既有列丢失")
	}
	pcols, err := tableColumns(st.db, "profiles")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"id", "name", "updated_at"} {
		if !pcols[c] {
			t.Fatalf("profiles 缺少列 %s", c)
		}
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	// 二次打开：列已存在时迁移必须幂等（对应老库补列的路径）
	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("二次 Open: %v", err)
	}
	defer func() { _ = st2.Close() }()
	if _, err := st2.db.Exec(`SELECT author_id, author_sig FROM items LIMIT 1`); err != nil {
		t.Fatalf("补列后仍不可查询: %v", err)
	}
	if _, err := st2.db.Exec(`SELECT id, name, updated_at FROM profiles LIMIT 1`); err != nil {
		t.Fatalf("profiles 不可查询: %v", err)
	}
}

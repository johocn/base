package packexport

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

func TestExportRejectsNonWhitelistedTable(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// 直接往 items 里塞一个 sqlite_table=events 的条目：白名单必须仍是显式集合
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, "base.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES('wall/1','wall','wall','t','r','h','events','public','active','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := Export(st, fixedOptions(st)); err == nil {
		t.Fatal("非白名单 sqlite_table 必须报错")
	}
}

func TestExportSegmentsRoundTrip(t *testing.T) {
	st, _ := seedStore(t)
	segs := []store.Segment{
		{Seq: 0, Kind: "digest", Text: "课程简介"},
		{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
	}
	if err := st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "course/c1", Source: "course", Type: "course", Title: "课程一", Segments: segs,
	}); err != nil {
		t.Fatal(err)
	}
	res, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(res.PackPath)+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT seq,kind,text,content_hash FROM segments WHERE item_id='course/c1' ORDER BY seq ASC`)
	if err != nil {
		t.Fatalf("pack.segments: %v", err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var seq int
		var kind, text, hash string
		if err := rows.Scan(&seq, &kind, &text, &hash); err != nil {
			t.Fatal(err)
		}
		if seq != n || kind != segs[n].Kind || text != segs[n].Text {
			t.Fatalf("第 %d 行不符: %d/%s/%s", n, seq, kind, text)
		}
		if hash != protocol.SHA256Hex([]byte(text)) {
			t.Fatalf("行级 hash 不符: %s", hash)
		}
		n++
	}
	if n != 2 {
		t.Fatalf("pack.segments = %d 行, want 2", n)
	}
	var entry *protocol.Entry
	for i := range res.Manifest.Entries {
		if res.Manifest.Entries[i].ItemID == "course/c1" {
			entry = &res.Manifest.Entries[i]
		}
	}
	if entry == nil || entry.SQLiteTable != "segments" || entry.ContentHash != store.SegmentsContentHash(segs) {
		t.Fatalf("manifest 条目异常: %+v", entry)
	}

	// 确定性：同参数两次导出字节一致。
	// Windows 上 Go 打开文件仅共享读/写（不含删除），pack.sqlite 的只读句柄未关闭时，
	// 二次导出删除同路径旧文件会失败；先关闭读句柄再导出。
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatal(err)
	}
	if second.PackSHA256 != res.PackSHA256 {
		t.Fatalf("含 segments 的导出必须字节一致: %s != %s", second.PackSHA256, res.PackSHA256)
	}
}
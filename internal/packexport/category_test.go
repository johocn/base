package packexport

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/johocn/base/internal/importer"
	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// writeCategorySeed 造一个含分类声明的 markdown 目录。
func writeCategorySeed(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c2\nlesson: l1\ncategory: math\ncategory_title: 数学\ncategory_digest: 数学入门\n---\n\n甲的正文\n",
		"20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n乙的正文\n",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatalf("写 %s: %v", name, err)
		}
	}
	return dir
}

func TestExportCategoryContainer(t *testing.T) {
	st, _ := seedStore(t) // export_test.go 既有夹具
	dir := writeCategorySeed(t)
	if _, err := importer.Run(st, dir, importer.Options{}); err != nil {
		t.Fatalf("importer.Run: %v", err)
	}

	res, err := Export(st, fixedOptions(st)) // export_test.go 既有夹具
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	// 导出侧：pack.sqlite 无 items 表，条目元数据只存在于签名 manifest；
	// 故 source/type/sqlite_table/title 从 manifest 条目取，segments 三行清单从 pack.sqlite 取。
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(res.PackPath)+"?mode=ro")
	if err != nil {
		t.Fatalf("打开 pack: %v", err)
	}
	defer db.Close()
	var source, typ, table, title string
	for i := range res.Manifest.Entries {
		e := &res.Manifest.Entries[i]
		if e.ItemID == "category/math" {
			source, typ, table, title = e.Source, e.Type, e.SQLiteTable, e.Title
		}
	}
	if source != "category" || typ != "category" || table != "segments" || title != "数学" {
		t.Fatalf("分类条目列值异常: %s/%s/%s/%s", source, typ, table, title)
	}
	rows, err := db.Query(`SELECT seq,kind,text FROM segments WHERE item_id='category/math' ORDER BY seq ASC`)
	if err != nil {
		t.Fatalf("pack.segments: %v", err)
	}
	type row struct {
		seq  int
		kind string
		text string
	}
	got := []row{}
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.seq, &r.kind, &r.text); err != nil {
			t.Fatal(err)
		}
		got = append(got, r)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	want := []row{{0, "digest", "数学入门"}, {1, "course", "course/c1"}, {2, "course", "course/c2"}}
	if len(got) != len(want) {
		t.Fatalf("分类清单 = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 行 = %+v, want %+v", i, got[i], want[i])
		}
	}

	// manifest 里的分类条目必须是 segments 表 + 容器级哈希
	var entry *protocol.Entry
	for i := range res.Manifest.Entries {
		if res.Manifest.Entries[i].ItemID == "category/math" {
			entry = &res.Manifest.Entries[i]
		}
	}
	if entry == nil || entry.SQLiteTable != "segments" {
		t.Fatalf("manifest 缺分类条目: %+v", entry)
	}

	// 确定性：同参数两次导出字节一致（须先关只读句柄，见「执行期更正 1」）
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatalf("二次 Export: %v", err)
	}
	if second.PackSHA256 != res.PackSHA256 {
		t.Fatalf("含分类条目的导出必须字节一致: %s != %s", second.PackSHA256, res.PackSHA256)
	}
}

func TestImportPackAcceptsCategoryContainer(t *testing.T) {
	st, _ := seedStore(t)
	segs := []store.Segment{
		{Seq: 0, Kind: "digest", Text: "数学入门"},
		{Seq: 1, Kind: "course", Text: "course/c1"},
	}
	res, err := st.ImportPack(9, []store.PackEntry{{
		ItemID: "category/math", Source: "category", Type: "category", Title: "数学",
		ContentHash: store.SegmentsContentHash(segs),
		SQLiteTable: "segments", DistClass: "public", Segments: segs,
	}}, nil)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if res.Entries != 1 {
		t.Fatalf("Entries = %d, want 1", res.Entries)
	}
	back, err := st.ListSegments("category/math")
	if err != nil || len(back) != 2 {
		t.Fatalf("接收侧清单 = %d 行, err=%v", len(back), err)
	}
	if store.SegmentsContentHash(back) != store.SegmentsContentHash(segs) {
		t.Fatal("接收侧条目级哈希与导出侧不一致")
	}
	it, ok, _ := st.GetItem("category/math")
	if !ok || it.Source != "category" || it.Type != "category" || it.SQLiteTable != "segments" {
		t.Fatalf("接收侧分类条目异常: %+v ok=%v", it, ok)
	}
}

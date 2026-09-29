package packexport

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// readPackEntries 从已打开的 pack.sqlite 只读句柄读回全部条目，构造成 []store.PackEntry。
// pack.sqlite 无 items 表，条目四列取自 manifest；segments/articles/media_meta/quizzes
// 的载荷列从各自表读。UpdatedAt 留空由 ImportPack 补 nowUTC。
func readPackEntries(t *testing.T, db *sql.DB, manifest []protocol.Entry) []store.PackEntry {
	t.Helper()
	out := make([]store.PackEntry, 0, len(manifest))
	for _, e := range manifest {
		pe := store.PackEntry{
			ItemID: e.ItemID, Source: e.Source, Type: e.Type, Title: e.Title,
			SourceRev: e.SourceRev, ContentHash: e.ContentHash,
			SQLiteTable: e.SQLiteTable, DistClass: e.DistClass,
		}
		switch e.SQLiteTable {
		case "segments":
			rows, err := db.Query(`SELECT seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC`, e.ItemID)
			if err != nil {
				t.Fatalf("读 pack.segments(%s): %v", e.ItemID, err)
			}
			for rows.Next() {
				seg := store.Segment{ItemID: e.ItemID}
				if err := rows.Scan(&seg.Seq, &seg.Kind, &seg.Text, &seg.ContentHash); err != nil {
					t.Fatalf("scan pack.segments(%s): %v", e.ItemID, err)
				}
				pe.Segments = append(pe.Segments, seg)
			}
			if err := rows.Close(); err != nil {
				t.Fatal(err)
			}
		case "articles":
			if err := db.QueryRow(`SELECT digest,published_at,tags_json,body_md FROM articles WHERE item_id=?`, e.ItemID).
				Scan(&pe.Digest, &pe.PublishedAt, &pe.TagsJSON, &pe.BodyMD); err != nil {
				t.Fatalf("读 pack.articles(%s): %v", e.ItemID, err)
			}
		case "media_meta":
			var chunkJSON string
			if err := db.QueryRow(`SELECT mime,size,duration,chunk_size,chunk_hashes_json FROM media_meta WHERE item_id=?`, e.ItemID).
				Scan(&pe.MIME, &pe.Size, &pe.Duration, &pe.ChunkSize, &chunkJSON); err != nil {
				t.Fatalf("读 pack.media_meta(%s): %v", e.ItemID, err)
			}
			if err := json.Unmarshal([]byte(chunkJSON), &pe.ChunkHashes); err != nil {
				t.Fatalf("chunk_hashes_json(%s): %v", e.ItemID, err)
			}
		case "quizzes":
			if err := db.QueryRow(`SELECT question_json FROM quizzes WHERE item_id=?`, e.ItemID).Scan(&pe.QuestionJSON); err != nil {
				t.Fatalf("读 pack.quizzes(%s): %v", e.ItemID, err)
			}
		}
		out = append(out, pe)
	}
	return out
}

// TestExportTagBackfillRoundTrip 覆盖册子 §3.3 的跨节点标签闭环：
// 导出侧 tag 条目物化为唯一 segments 行（seq 从 1 起）；接收侧 ImportPack 据 segments 幂等回填 tag_links。
func TestExportTagBackfillRoundTrip(t *testing.T) {
	st, _ := seedStore(t)
	if err := st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "course/c1", Source: "course", Type: "course", Title: "课程一",
		Segments: []store.Segment{{Seq: 0, Kind: "digest", Text: "课程简介"}},
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}
	tagID, ok := protocol.TagItemID("甲", "第一章", "第一节")
	if !ok {
		t.Fatal("TagItemID 应合法")
	}
	if _, err := st.UpsertTagSubmission(store.TagSubmission{
		TagID: tagID, Title: protocol.TagTitle("甲", "第一章", "第一节"),
		Links:    []store.TagLink{{TagID: tagID, TargetID: "course/c1", Kind: "course"}},
		AuthorID: "aa", AuthorSig: "sig",
	}); err != nil {
		t.Fatalf("UpsertTagSubmission: %v", err)
	}

	res, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(res.PackPath)+"?mode=ro")
	if err != nil {
		t.Fatalf("打开 pack: %v", err)
	}

	// AC 8：pack.meta.schema_version = 1
	var schemaVersion string
	if err := db.QueryRow(`SELECT value FROM meta WHERE key='schema_version'`).Scan(&schemaVersion); err != nil {
		t.Fatalf("读 pack.meta: %v", err)
	}
	if schemaVersion != "1" {
		t.Fatalf("schema_version = %q, want \"1\"", schemaVersion)
	}

	// AC：tag 条目在 pack.segments 只有一行 (seq=1, kind=course, text=course/c1)
	var tagRows int
	if err := db.QueryRow(`SELECT count(*) FROM segments WHERE item_id=?`, tagID).Scan(&tagRows); err != nil {
		t.Fatalf("count pack.segments(%s): %v", tagID, err)
	}
	if tagRows != 1 {
		t.Fatalf("tag 条目 segments 行数 = %d, want 1", tagRows)
	}
	var seq int
	var kind, text string
	if err := db.QueryRow(`SELECT seq,kind,text FROM segments WHERE item_id=?`, tagID).Scan(&seq, &kind, &text); err != nil {
		t.Fatalf("读 tag segments 行: %v", err)
	}
	if seq != 1 || kind != "course" || text != "course/c1" {
		t.Fatalf("tag segments 行 = (%d,%s,%s), want (1,course,course/c1)", seq, kind, text)
	}

	entries := readPackEntries(t, db, res.Manifest.Entries)

	// Windows：pack.sqlite 只读句柄不关，二次导出删同路径旧文件会失败（见 segments_test.go 注释）。
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	// AC 7：同参数重复导出字节一致
	second, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatalf("二次 Export: %v", err)
	}
	if second.PackSHA256 != res.PackSHA256 {
		t.Fatalf("含 tag 条目的导出必须字节一致: %s != %s", second.PackSHA256, res.PackSHA256)
	}

	// 接收侧：另一库 ImportPack 据 segments 回填 tag_links
	dst, _ := seedStore(t)
	if _, err := dst.ImportPack(res.ContentVersion, entries, res.Manifest.Tombstone); err != nil {
		t.Fatalf("dst.ImportPack: %v", err)
	}
	want := []store.TagLink{{TagID: tagID, TargetID: "course/c1", Kind: "course"}}
	got, err := dst.ListTagLinks(tagID)
	if err != nil {
		t.Fatalf("ListTagLinks: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("接收侧 tag_links = %+v, want %+v", got, want)
	}

	// 幂等：同包再入一次，tag_links 不产生重复行
	if _, err := dst.ImportPack(res.ContentVersion, entries, res.Manifest.Tombstone); err != nil {
		t.Fatalf("dst.ImportPack 二次: %v", err)
	}
	again, err := dst.ListTagLinks(tagID)
	if err != nil {
		t.Fatalf("ListTagLinks 二次: %v", err)
	}
	if !reflect.DeepEqual(again, want) {
		t.Fatalf("幂等失败：tag_links = %+v, want %+v", again, want)
	}
}

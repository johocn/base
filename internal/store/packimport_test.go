package store

import (
	"os"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func entryOf(t *testing.T, st *Store, itemID string) PackEntry {
	t.Helper()
	a, ok, err := st.GetArticle(itemID)
	if err != nil || !ok {
		t.Fatalf("GetArticle %s: ok=%v err=%v", itemID, ok, err)
	}
	return PackEntry{
		ItemID: a.ItemID, Source: "article", Type: "article", Title: a.Title,
		SourceRev: a.SourceRev, ContentHash: a.ContentHash, SQLiteTable: "articles",
		DistClass: "public", Digest: a.Digest, PublishedAt: a.PublishedAt, TagsJSON: a.TagsJSON, BodyMD: a.BodyMD,
	}
}

func TestImportPackAtomicAndIdempotent(t *testing.T) {
	st := openTemp(t)
	if err := st.UpsertArticle(Article{
		ItemID: "article:a", Title: "甲", BodyMD: "甲正文\n", ContentHash: protocol.SHA256Hex([]byte("甲正文\n")),
		SourceRev: "rev1", TagsJSON: `[]`,
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	e := entryOf(t, st, "article:a")

	res, err := st.ImportPack(5, []PackEntry{e}, nil)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if res.Entries != 1 || len(res.Rejected) != 0 {
		t.Fatalf("res = %+v", res)
	}
	if v, _ := st.ContentVersion(); v != 5 {
		t.Fatalf("content_version = %d, want 5", v)
	}
	// 幂等：重复导入同一版本不报错、不产生新行
	if _, err := st.ImportPack(5, []PackEntry{e}, nil); err != nil {
		t.Fatalf("重复导入: %v", err)
	}
	if _, ok, _ := st.GetArticle("article:a"); !ok {
		t.Fatal("条目应仍在")
	}
}

func TestImportPackTombstoneRemovesRowsAndReportsBlobs(t *testing.T) {
	st := openTemp(t)
	id := putBlob(t, st, "视频块0", "lesson:v", 0)
	if err := st.UpsertMediaItem(MediaItem{
		ItemID: "lesson:v", Source: "lesson", Type: "video", Title: "视频",
		SourceRev: "rev", ContentHash: protocol.SHA256Hex([]byte(id)), SQLiteTable: "media_meta",
		MIME: "video/mp4", Size: 10, ChunkSize: 1 << 20, ChunkHashes: []string{id},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	res, err := st.ImportPack(6, nil, []protocol.Tombstone{{ItemID: "lesson:v", RevokedRev: 6}})
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if len(res.RemovedBlobs) != 1 || res.RemovedBlobs[0] != id {
		t.Fatalf("RemovedBlobs = %v, want [%s]", res.RemovedBlobs, id)
	}
	if _, ok, _ := st.GetItem("lesson:v"); ok {
		t.Fatal("items 行应被删")
	}
	if _, _, _, _, _, ok, _ := st.GetMediaMeta("lesson:v"); ok {
		t.Fatal("media_meta 行应被删")
	}
	if has, _, _ := st.HasBlob(id); has {
		t.Fatal("blobs 行应被删")
	}
	// 块文件本体不在事务里删：由调用方负责
	if _, err := os.Stat(st.BlobPath(id)); err != nil {
		t.Fatalf("块文件本不应在本步被删: %v", err)
	}
	ts, _ := st.ListTombstones()
	if len(ts) != 1 || ts[0].RevokedRev != 6 {
		t.Fatalf("tombstones = %+v", ts)
	}
}

func TestImportPackRejectsRollback(t *testing.T) {
	st := openTemp(t)
	if err := st.AddTombstone("article:a", 7); err != nil {
		t.Fatalf("AddTombstone: %v", err)
	}
	e := PackEntry{
		ItemID: "article:a", Source: "article", Type: "article", Title: "甲",
		ContentHash: protocol.SHA256Hex([]byte("甲")), SQLiteTable: "articles",
		DistClass: "public", BodyMD: "甲", TagsJSON: `[]`,
	}
	// 同版本（7）重现 → 拒该条目
	res, err := st.ImportPack(7, []PackEntry{e}, nil)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if len(res.Rejected) != 1 || res.Rejected[0] != "article:a" || res.Entries != 0 {
		t.Fatalf("res = %+v", res)
	}
	if _, ok, _ := st.GetArticle("article:a"); ok {
		t.Fatal("被拒条目不得入库")
	}
	// 更大版本（8）= 正常重新发布 → 允许入库，且墓碑 revoked_rev 取大值
	res, err = st.ImportPack(8, []PackEntry{e}, nil)
	if err != nil {
		t.Fatalf("ImportPack v8: %v", err)
	}
	if res.Entries != 1 || len(res.Rejected) != 0 {
		t.Fatalf("res = %+v", res)
	}
	if _, ok, _ := st.GetArticle("article:a"); !ok {
		t.Fatal("重新发布应入库")
	}
}

func TestImportPackSkipsNonPublic(t *testing.T) {
	st := openTemp(t)
	res, err := st.ImportPack(1, []PackEntry{{
		ItemID: "article:x", Source: "article", Type: "article", SQLiteTable: "articles",
		DistClass: "controlled", ContentHash: "h", BodyMD: "x",
	}}, nil)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if res.Skipped != 1 || res.Entries != 0 {
		t.Fatalf("res = %+v", res)
	}
	if _, ok, _ := st.GetItem("article:x"); ok {
		t.Fatal("非 public 条目不得入库")
	}
}

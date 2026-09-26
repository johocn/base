package store

import (
	"os"
	"sort"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestListBlobsPageCursor(t *testing.T) {
	st := openTemp(t)
	ids := []string{}
	for _, s := range []string{"a", "b", "c"} {
		ids = append(ids, putBlob(t, st, "内容-"+s, "lesson:x", 0))
	}
	sort.Strings(ids)

	page, next, err := st.ListBlobsPage("", 2)
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if len(page) != 2 || next != page[1].BlobID {
		t.Fatalf("page1 = %d 条 next=%q", len(page), next)
	}
	page2, next2, err := st.ListBlobsPage(next, 2)
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(page2) != 1 || next2 != "" {
		t.Fatalf("page2 = %d 条 next=%q, want 1 条且 next 为空", len(page2), next2)
	}
	all, err := st.ListAllBlobIDs()
	if err != nil {
		t.Fatalf("all: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("全部块 = %d, want 3", len(all))
	}
	if ids[0] > ids[2] {
		t.Fatal("unreachable")
	}
}

func TestDeleteBlobRemovesFileAndRow(t *testing.T) {
	st := openTemp(t)
	id := putBlob(t, st, "要删的块", "lesson:x", 0)
	if err := st.DeleteBlob(id); err != nil {
		t.Fatalf("DeleteBlob: %v", err)
	}
	if _, err := os.Stat(st.BlobPath(id)); !os.IsNotExist(err) {
		t.Fatalf("块文件仍在: %v", err)
	}
	if ok, _, _ := st.HasBlob(id); ok {
		t.Fatal("blobs 行仍在")
	}
	if err := st.DeleteBlob(id); err != nil { // 幂等
		t.Fatalf("重复删除应成功: %v", err)
	}
}

func TestMediaChunkIndexMapsOwnerAndSeq(t *testing.T) {
	st := openTemp(t)
	b0 := putBlob(t, st, "块0", "lesson:v", 0)
	b1 := putBlob(t, st, "块1", "lesson:v", 1)
	if err := st.UpsertMediaItem(MediaItem{
		ItemID: "lesson:v", Source: "lesson", Type: "video", Title: "视频",
		SourceRev: "rev", ContentHash: "hash", SQLiteTable: "media_meta",
		MIME: "video/mp4", Size: 10, ChunkSize: 1 << 20,
		ChunkHashes: []string{b0, b1},
	}); err != nil {
		t.Fatalf("UpsertMediaItem: %v", err)
	}
	// 存量封面路径：chunk_hashes_json 里是 64 字符全量 sha256，必须归一到前 32 字符。
	cover := []byte("cover-bytes")
	coverID := protocol.BlobID(cover)
	if err := st.PutBlob(coverID, cover, "cover:a", 0); err != nil {
		t.Fatalf("PutBlob cover: %v", err)
	}
	if err := st.UpsertMediaItem(MediaItem{
		ItemID: "cover:a", Source: "article", Type: "cover", Title: "封面",
		SourceRev: "rev", ContentHash: protocol.SHA256Hex(cover), SQLiteTable: "media_meta",
		MIME: "image/png", Size: int64(len(cover)), ChunkSize: int64(len(cover)),
		ChunkHashes: []string{protocol.SHA256Hex(cover)},
	}); err != nil {
		t.Fatalf("UpsertMediaItem cover: %v", err)
	}

	idx, err := st.MediaChunkIndex()
	if err != nil {
		t.Fatalf("index: %v", err)
	}
	if got := idx[b1]; got.ItemID != "lesson:v" || got.Seq != 1 {
		t.Fatalf("b1 owner = %+v, want lesson:v/seq=1", got)
	}
	if got := idx[coverID]; got.ItemID != "cover:a" || got.Seq != 0 {
		t.Fatalf("封面 owner = %+v（64 字符声明必须归一）, want cover:a/seq=0", got)
	}
	if _, ok := idx[protocol.SHA256Hex(cover)]; ok {
		t.Fatal("64 字符全量 sha256 不得作为 key 出现")
	}
}

package importer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/johocn/base/internal/store"
)

func TestImportVideoChunking(t *testing.T) {
	st := openTemp(t)
	// ChunkSize + 3 字节 → 2 块，末块 3 字节
	path := writeTempFile(t, "clip.mp4", ChunkSize+3)

	res, err := ImportVideo(st, VideoOptions{Path: path, Slug: "v1", Title: "第一课"})
	if err != nil {
		t.Fatalf("ImportVideo: %v", err)
	}
	if res.Chunks != 2 || res.Written != 2 {
		t.Fatalf("块数 = %d/%d, want 2/2", res.Chunks, res.Written)
	}
	if res.TotalSize != int64(ChunkSize+3) {
		t.Fatalf("总字节 = %d", res.TotalSize)
	}

	mime, size, dur, chunkSize, hashes, ok, err := st.GetMediaMeta("lesson:v1")
	if err != nil || !ok {
		t.Fatalf("GetMediaMeta: ok=%v err=%v", ok, err)
	}
	if size != int64(ChunkSize+3) || chunkSize != ChunkSize || dur != 0 || len(hashes) != 2 || mime != "video/mp4" {
		t.Fatalf("media_meta = %s/%d/%d/%d/%d 块", mime, size, dur, chunkSize, len(hashes))
	}

	// 幂等重导入：同字节块不重写
	res2, err := ImportVideo(st, VideoOptions{Path: path, Slug: "v1"})
	if err != nil {
		t.Fatalf("重复导入: %v", err)
	}
	if res2.Written != 0 {
		t.Fatalf("重复导入写盘 = %d, want 0", res2.Written)
	}
	if res2.ContentHash != res.ContentHash {
		t.Fatalf("content_hash 不稳定: %s != %s", res2.ContentHash, res.ContentHash)
	}
}

func TestImportVideoRejectsEmpty(t *testing.T) {
	st := openTemp(t)
	path := writeTempFile(t, "empty.mp4", 0)
	if _, err := ImportVideo(st, VideoOptions{Path: path, Slug: "e"}); err == nil {
		t.Fatal("空文件应报错")
	}
}

func writeTempFile(t *testing.T, name string, size int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	data := make([]byte, size)
	for i := range data {
		data[i] = byte(i * 31)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("写临时文件: %v", err)
	}
	return path
}

func openTemp(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir(), store.WithStoreKey("9f2c1d4a7b3e5081f6a9c2d5e8b10432a7c9e6b3d0f84261c5a8e2b7d4f01963"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

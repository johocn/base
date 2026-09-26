package packexport

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/johocn/base/internal/importer"
	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

const testSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"

func seedStore(t *testing.T) (*store.Store, []byte) {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	write := func(id, title, body string) {
		if err := st.UpsertArticle(store.Article{
			ItemID: id, Title: title, Digest: title, PublishedAt: "2026-01-01T00:00:00Z",
			TagsJSON: `["演示"]`, BodyMD: body, ContentHash: protocol.SHA256Hex([]byte(body)),
			SourceRev: "rev-1", UpdatedAt: "2026-01-02T03:04:05Z",
		}); err != nil {
			t.Fatalf("UpsertArticle(%s): %v", id, err)
		}
	}
	write("article:demo-1", "演示一", "demo body 1\n")
	write("article:demo-2", "演示二", "demo body 2\n")

	cover := []byte("\x89PNG\r\n\x1a\n0123456789")
	if err := st.PutBlob(protocol.BlobID(cover), cover, "cover:demo-1", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	if err := st.UpsertMediaItem(store.MediaItem{
		ItemID: "cover:demo-1", Source: "article", Type: "cover", Title: "封面",
		SourceRev: "rev-1", ContentHash: protocol.SHA256Hex(cover), MIME: "image/png",
		Size: int64(len(cover)), ChunkSize: int64(len(cover)),
		ChunkHashes: []string{protocol.SHA256Hex(cover)}, UpdatedAt: "2026-01-02T03:04:05Z",
	}); err != nil {
		t.Fatalf("UpsertMediaItem: %v", err)
	}
	return st, cover
}

func fixedOptions(st *store.Store) Options {
	return Options{
		Issuer:     "base-node-1",
		SignKeyHex: testSeed,
		Version:    7,
		IssuedAt:   time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	}
}

func TestExportBuildsVerifiablePack(t *testing.T) {
	st, cover := seedStore(t)
	res, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if res.Entries != 3 {
		t.Fatalf("Entries = %d, want 3", res.Entries)
	}
	if res.ContentVersion != 7 {
		t.Fatalf("ContentVersion = %d, want 7", res.ContentVersion)
	}
	wantMerkle, err := protocol.MerkleRoot([]string{protocol.BlobID(cover)})
	if err != nil {
		t.Fatal(err)
	}
	if res.MerkleRoot != wantMerkle {
		t.Fatalf("MerkleRoot = %s, want %s", res.MerkleRoot, wantMerkle)
	}
	if res.PackID != protocol.DerivePackID("base-node-1", 7, wantMerkle) {
		t.Fatalf("PackID 不可复算: %s", res.PackID)
	}
	kp, err := protocol.KeyPairFromSeed(testSeed)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := res.Manifest.Verify(kp.PubHex)
	if err != nil || !ok {
		t.Fatalf("manifest 验签失败: ok=%v err=%v", ok, err)
	}
	if len(res.Manifest.Tombstone) != 0 {
		t.Fatalf("P0 空库导出 tombstone 应为空数组, got %+v", res.Manifest.Tombstone)
	}
	if res.Manifest.Entries[0].Chunks != nil {
		t.Fatalf("文章条目不应带 chunks: %+v", res.Manifest.Entries[0])
	}
	if len(res.Manifest.Entries[2].Chunks) != 1 {
		t.Fatalf("封面条目应带 1 个 chunk: %+v", res.Manifest.Entries[2])
	}
	rec, ok, err := st.GetPack(res.PackID)
	if err != nil || !ok || rec.ContentVersion != 7 || rec.ItemCount != 3 {
		t.Fatalf("包未登记: ok=%v err=%v rec=%+v", ok, err, rec)
	}
	latest, ok, _ := st.LatestPack()
	if !ok || latest.PackID != res.PackID {
		t.Fatalf("LatestPack = %+v", latest)
	}
}

func TestExportReadablePackSQLite(t *testing.T) {
	st, _ := seedStore(t)
	res, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(res.PackPath)+"?mode=ro")
	if err != nil {
		t.Fatalf("open pack: %v", err)
	}
	defer db.Close()
	var articles int
	if err := db.QueryRow(`SELECT count(*) FROM articles`).Scan(&articles); err != nil {
		t.Fatalf("count articles: %v", err)
	}
	if articles != 2 {
		t.Fatalf("pack.articles = %d, want 2", articles)
	}
	var media int
	if err := db.QueryRow(`SELECT count(*) FROM media_meta`).Scan(&media); err != nil {
		t.Fatal(err)
	}
	if media != 1 {
		t.Fatalf("pack.media_meta = %d, want 1", media)
	}
	meta := map[string]string{}
	rows, err := db.Query(`SELECT key,value FROM meta`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			t.Fatal(err)
		}
		meta[k] = v
	}
	if meta["pack_id"] != res.PackID || meta["content_version"] != "7" || meta["merkle_root"] != res.MerkleRoot || meta["schema_version"] != "1" {
		t.Fatalf("pack.meta 错误: %+v", meta)
	}
	var body string
	if err := db.QueryRow(`SELECT body_md FROM articles WHERE item_id='article:demo-1'`).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if body != "demo body 1\n" {
		t.Fatalf("pack 正文 = %q（正文必须原样搬运，不做格式转换）", body)
	}
}

func TestExportIsDeterministicWithFixedVersionAndTime(t *testing.T) {
	st, _ := seedStore(t)
	opt := fixedOptions(st)
	first, err := Export(st, opt)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Export(st, opt)
	if err != nil {
		t.Fatal(err)
	}
	if first.PackSHA256 != second.PackSHA256 {
		t.Fatalf("pack.sqlite 字节不一致: %s != %s", first.PackSHA256, second.PackSHA256)
	}
	if first.ManifestSHA256 != second.ManifestSHA256 {
		t.Fatalf("manifest 字节不一致: %s != %s", first.ManifestSHA256, second.ManifestSHA256)
	}
	if first.PackID != second.PackID {
		t.Fatalf("pack_id 不稳定: %s != %s", first.PackID, second.PackID)
	}
	// 版本自增路径：Version=0 时使用全局 content_version 计数器
	third, err := Export(st, Options{Issuer: "base-node-1", SignKeyHex: testSeed, IssuedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	if third.ContentVersion != 1 {
		t.Fatalf("首次自增版本 = %d, want 1", third.ContentVersion)
	}
	fourth, err := Export(st, Options{Issuer: "base-node-1", SignKeyHex: testSeed, IssuedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	if fourth.ContentVersion != 2 {
		t.Fatalf("二次自增版本 = %d, want 2", fourth.ContentVersion)
	}
	if fourth.PackID == third.PackID {
		t.Fatal("版本不同但 pack_id 相同（pack_id 必须与 content_version 绑定）")
	}
}

func TestExportEmptyStore(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	res, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatalf("空库导出应成功: %v", err)
	}
	if res.Entries != 0 {
		t.Fatalf("Entries = %d, want 0", res.Entries)
	}
	wantMerkle, _ := protocol.MerkleRoot(nil)
	if res.MerkleRoot != wantMerkle {
		t.Fatalf("空库 merkle = %s, want %s", res.MerkleRoot, wantMerkle)
	}
}

// 块级去重（契约 §4.1）下，entries[].chunks[] 仍必须与 chunk_hashes_json 逐位一致（验收 3）：
// 2.5 MiB 全零视频的块 0 与块 1 同字节，blobs 只落一行，若照 blobs 填 chunks 会少一块、
// 且 size 之和不等于条目 size，接收方校验 len(hashes) != len(chunks) 会整包拒收。
func TestExportKeepsDeclaredChunkCountUnderDedup(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	path := filepath.Join(t.TempDir(), "zeros.mp4")
	if err := os.WriteFile(path, make([]byte, 2621440), 0o600); err != nil {
		t.Fatalf("写视频: %v", err)
	}
	if _, err := importer.ImportVideo(st, importer.VideoOptions{Path: path, Slug: "zeros"}); err != nil {
		t.Fatalf("ImportVideo: %v", err)
	}
	itemID := "lesson:zeros"
	res, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	var entry *protocol.Entry
	for i := range res.Manifest.Entries {
		if res.Manifest.Entries[i].ItemID == itemID {
			entry = &res.Manifest.Entries[i]
		}
	}
	if entry == nil {
		t.Fatalf("manifest 缺少 %s", itemID)
	}
	if len(entry.Chunks) != 3 {
		t.Fatalf("chunks = %d, want 3（去重不得改变声明块数）: %+v", len(entry.Chunks), entry.Chunks)
	}
	var sum int64
	for _, c := range entry.Chunks {
		sum += c.Size
	}
	if sum != 2621440 {
		t.Fatalf("chunks size 之和 = %d, want 2621440", sum)
	}
	if entry.Chunks[0].BlobID != entry.Chunks[1].BlobID {
		t.Fatalf("块 0/1 应同 id（全零视频）: %+v", entry.Chunks)
	}
	if entry.Chunks[0].BlobID == entry.Chunks[2].BlobID {
		t.Fatalf("块 2 与块 0 不应同 id: %+v", entry.Chunks)
	}

	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(res.PackPath)+"?mode=ro")
	if err != nil {
		t.Fatalf("open pack: %v", err)
	}
	defer db.Close()
	var chunkJSON string
	if err := db.QueryRow(`SELECT chunk_hashes_json FROM media_meta WHERE item_id=?`, itemID).Scan(&chunkJSON); err != nil {
		t.Fatalf("读 pack.media_meta: %v", err)
	}
	var hashes []string
	if err := json.Unmarshal([]byte(chunkJSON), &hashes); err != nil {
		t.Fatalf("chunk_hashes_json: %v", err)
	}
	if len(hashes) != len(entry.Chunks) {
		t.Fatalf("chunk_hashes_json=%d 与 chunks=%d 不一致", len(hashes), len(entry.Chunks))
	}
	for i, h := range hashes {
		if h != entry.Chunks[i].BlobID {
			t.Fatalf("第 %d 位块 id 不一致: %s != %s", i, h, entry.Chunks[i].BlobID)
		}
	}
}

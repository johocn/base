package store

import (
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	st, err := Open(t.TempDir(), WithStoreKey(testKeyHex))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestOpenConfiguresWAL(t *testing.T) {
	st := openTemp(t)
	var mode string
	if err := st.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatalf("pragma: %v", err)
	}
	if mode != "wal" {
		t.Fatalf("journal_mode = %q, want wal（说明 DSN 的 _pragma 没生效）", mode)
	}
}

func TestArticleUpsertIsIdempotent(t *testing.T) {
	st := openTemp(t)
	body := "第一段\n\n第二段"
	a := Article{
		ItemID: "article:demo-1", Title: "演示一", Digest: "第一段",
		PublishedAt: "2026-01-01T00:00:00Z", TagsJSON: `["离线","协议"]`,
		BodyMD: body, ContentHash: protocol.SHA256Hex([]byte(body)),
		SourceRev: "rev-1", UpdatedAt: "2026-01-02T03:04:05Z",
	}
	if err := st.UpsertArticle(a); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	a.BodyMD = body + "\n追加"
	a.ContentHash = protocol.SHA256Hex([]byte(a.BodyMD))
	a.SourceRev = "rev-2"
	if err := st.UpsertArticle(a); err != nil {
		t.Fatalf("UpsertArticle(2): %v", err)
	}

	items, err := st.ListItems("active")
	if err != nil {
		t.Fatalf("ListItems: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1（幂等键是 item_id）", len(items))
	}
	it := items[0]
	if it.ItemID != a.ItemID || it.Type != "article" || it.Source != "article" || it.SQLiteTable != "articles" || it.DistClass != "public" {
		t.Fatalf("item 派生字段错误: %+v", it)
	}
	if it.ContentHash != a.ContentHash || it.SourceRev != "rev-2" {
		t.Fatalf("重跑未刷新 content_hash/source_rev: %+v", it)
	}
	got, ok, err := st.GetArticle(a.ItemID)
	if err != nil || !ok {
		t.Fatalf("GetArticle ok=%v err=%v", ok, err)
	}
	if got.BodyMD != a.BodyMD || got.TagsJSON != `["离线","协议"]` {
		t.Fatalf("article 内容不一致: %+v", got)
	}
}

func TestBlobLayoutAndMeta(t *testing.T) {
	st := openTemp(t)
	data := []byte("blob-bytes")
	id := protocol.BlobID(data)
	if err := st.PutBlob(id, data, "cover:demo-1", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	ok, size, err := st.HasBlob(id)
	if err != nil || !ok || size != int64(len(data)) {
		t.Fatalf("HasBlob ok=%v size=%d err=%v", ok, size, err)
	}
	got, err := st.GetBlobBytes(id)
	if err != nil || string(got) != string(data) {
		t.Fatalf("GetBlobBytes err=%v", err)
	}
	wantSuffix := "blobs/" + id[0:2] + "/" + id[2:4] + "/" + id
	if p := st.BlobPath(id); len(p) < len(wantSuffix) || p[len(p)-len(wantSuffix):] != wantSuffix {
		t.Fatalf("BlobPath = %s, 期望以 %s 结尾", p, wantSuffix)
	}

	v1, err := st.BumpContentVersion()
	if err != nil || v1 != 1 {
		t.Fatalf("BumpContentVersion = %d err=%v, want 1", v1, err)
	}
	v2, _ := st.BumpContentVersion()
	if v2 != 2 {
		t.Fatalf("BumpContentVersion(2) = %d, want 2", v2)
	}
	if got := st.MetaString("content_version", ""); got != "2" {
		t.Fatalf("meta content_version = %q, want 2", got)
	}
}

func TestPacksAndTombstones(t *testing.T) {
	st := openTemp(t)
	rec := PackRecord{
		PackID: "p1", ContentVersion: 3, Dir: "packs/p1", MerkleRoot: "aa",
		Signature: "bb", IssuedAt: "2026-01-02T03:04:05Z", ItemCount: 2, CreatedAt: "2026-01-02T03:04:05Z",
	}
	if err := st.InsertPack(rec); err != nil {
		t.Fatalf("InsertPack: %v", err)
	}
	got, ok, err := st.GetPack("p1")
	if err != nil || !ok || got.ContentVersion != 3 || got.ItemCount != 2 {
		t.Fatalf("GetPack ok=%v err=%v got=%+v", ok, err, got)
	}
	latest, ok, err := st.LatestPack()
	if err != nil || !ok || latest.PackID != "p1" {
		t.Fatalf("LatestPack ok=%v err=%v latest=%+v", ok, err, latest)
	}
	if err := st.AddTombstone("article:old", 2); err != nil {
		t.Fatalf("AddTombstone: %v", err)
	}
	ts, err := st.ListTombstones()
	if err != nil || len(ts) != 1 || ts[0].ItemID != "article:old" || ts[0].RevokedRev != 2 {
		t.Fatalf("ListTombstones err=%v ts=%+v", err, ts)
	}
}

func TestListItemsPageAndMissingPack(t *testing.T) {
	st := openTemp(t)
	for _, id := range []string{"article:a", "article:b", "article:c"} {
		if err := st.UpsertArticle(Article{ItemID: id, Title: id, BodyMD: id, ContentHash: protocol.SHA256Hex([]byte(id)), SourceRev: "r", UpdatedAt: "2026-01-01T00:00:00Z"}); err != nil {
			t.Fatal(err)
		}
	}
	page, next, err := st.ListItemsPage("", 2)
	if err != nil || len(page) != 2 || next != "article:b" {
		t.Fatalf("第一页 page=%d next=%q err=%v", len(page), next, err)
	}
	page2, next2, err := st.ListItemsPage(next, 2)
	if err != nil || len(page2) != 1 || next2 != "" {
		t.Fatalf("第二页 page=%d next=%q err=%v", len(page2), next2, err)
	}
	if _, ok, err := st.GetPack("nope"); err != nil || ok {
		t.Fatalf("GetPack(unknown) ok=%v err=%v, want false/nil", ok, err)
	}
}
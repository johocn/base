package store

import (
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestArticleBodyEncryptedAtRest(t *testing.T) {
	st := openTemp(t)
	body := "这是正文，绝不能以明文出现在 data 目录里"
	a := Article{ItemID: "article:enc", Title: "t", BodyMD: body,
		ContentHash: protocol.SHA256Hex([]byte(body)), SourceRev: "r", UpdatedAt: "2026-01-01T00:00:00Z"}
	if err := st.UpsertArticle(a); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}

	var raw string
	if err := st.db.QueryRow(`SELECT body_md FROM articles WHERE item_id=?`, a.ItemID).Scan(&raw); err != nil {
		t.Fatalf("裸读 body_md: %v", err)
	}
	if strings.Contains(raw, "这是正文") {
		t.Fatal("body_md 列里出现了明文")
	}
	if !strings.HasPrefix(raw, encPrefix) {
		t.Fatalf("body_md 未带加密前缀: %q", raw)
	}
	assertPlaintextAbsent(t, st.DataDir(), []byte(body))

	got, ok, err := st.GetArticle(a.ItemID)
	if err != nil || !ok {
		t.Fatalf("GetArticle ok=%v err=%v", ok, err)
	}
	if got.BodyMD != body {
		t.Fatalf("GetArticle.BodyMD = %q, want %q", got.BodyMD, body)
	}

	m, err := st.ListArticles([]string{a.ItemID})
	if err != nil {
		t.Fatal(err)
	}
	if m[a.ItemID].BodyMD != body {
		t.Fatalf("ListArticles 返回未解密内容: %q", m[a.ItemID].BodyMD)
	}
}

func TestArticleUpsertReEncryptsEveryWrite(t *testing.T) {
	st := openTemp(t)
	body := "同一段正文"
	a := Article{ItemID: "article:twice", Title: "t", BodyMD: body,
		ContentHash: protocol.SHA256Hex([]byte(body)), SourceRev: "r", UpdatedAt: "2026-01-01T00:00:00Z"}
	if err := st.UpsertArticle(a); err != nil {
		t.Fatal(err)
	}
	var first string
	if err := st.db.QueryRow(`SELECT body_md FROM articles WHERE item_id=?`, a.ItemID).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertArticle(a); err != nil {
		t.Fatal(err)
	}
	var second string
	if err := st.db.QueryRow(`SELECT body_md FROM articles WHERE item_id=?`, a.ItemID).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("两次写入的密文相同，nonce 未随机化")
	}
	got, _, err := st.GetArticle(a.ItemID)
	if err != nil || got.BodyMD != body {
		t.Fatalf("重复写入后读回不一致: %q err=%v", got.BodyMD, err)
	}
}

func TestArticleReadsLegacyPlaintextRow(t *testing.T) {
	st := openTemp(t)
	if _, err := st.db.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES('article:legacy','article','article','t','r','h','articles','public','active','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(`INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
		VALUES('article:legacy','t','','','[]','历史明文正文','h','r')`); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.GetArticle("article:legacy")
	if err != nil || !ok {
		t.Fatalf("GetArticle ok=%v err=%v", ok, err)
	}
	if got.BodyMD != "历史明文正文" {
		t.Fatalf("历史明文行应原样返回，got %q", got.BodyMD)
	}
}

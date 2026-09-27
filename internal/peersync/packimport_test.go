package peersync

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/johocn/base/internal/httpapi"
	"github.com/johocn/base/internal/packexport"
	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

const (
	srcIssuer = "base-node-1"
	srcSeed   = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
)

// newSourceNode 起一个真 httpapi 源节点（进程内），返回 store、对端 URL、注入给 Config 的传输、公钥。
func newSourceNode(t *testing.T) (*store.Store, string, func(Peer) (http.RoundTripper, error), string) {
	t.Helper()
	st := openTemp(t)
	srv, err := httpapi.New(st, httpapi.Options{Issuer: srcIssuer, SignKeyHex: srcSeed, Version: "test"})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	url, tr := newInprocPeer(t, srv.PeerHandler())
	kp, err := protocol.KeyPairFromSeed(srcSeed)
	if err != nil {
		t.Fatalf("KeyPairFromSeed: %v", err)
	}
	return st, url, tr, kp.PubHex
}

// seedSource 写入 1 篇文章 + 1 个封面并导出 1 个包。
func seedSource(t *testing.T, st *store.Store) packexport.Result {
	t.Helper()
	body := "甲正文\n"
	if err := st.UpsertArticle(store.Article{
		ItemID: "article:aaa", Title: "甲", Digest: "甲摘要", PublishedAt: "2026-01-01T00:00:00Z",
		TagsJSON: `[]`, BodyMD: body, ContentHash: protocol.SHA256Hex([]byte(body)),
		SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	cover := []byte("COVERBYTES")
	if err := st.PutBlob(protocol.BlobID(cover), cover, "cover:aaa", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	if err := st.UpsertMediaItem(store.MediaItem{
		ItemID: "cover:aaa", Source: "article", Type: "cover", Title: "甲封面",
		SourceRev: "rev-1", ContentHash: protocol.SHA256Hex(cover), SQLiteTable: "media_meta",
		MIME: "image/png", Size: int64(len(cover)), ChunkSize: int64(len(cover)),
		ChunkHashes: []string{protocol.SHA256Hex(cover)}, UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertMediaItem: %v", err)
	}
	res, err := packexport.Export(st, packexport.Options{Issuer: srcIssuer, SignKeyHex: srcSeed})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	return res
}

func TestImportPackCopiesPackageAndRows(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	res := seedSource(t, src)

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	outcome, err := cfg.ImportPack(context.Background(), dst, Peer{URL: url}, 0)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if outcome.Status != "imported" || outcome.ContentVersion != res.ContentVersion || outcome.Entries != 2 {
		t.Fatalf("outcome = %+v", outcome)
	}
	if v, _ := dst.ContentVersion(); v != res.ContentVersion {
		t.Fatalf("缓存节点水位 = %d, want %d", v, res.ContentVersion)
	}
	// 公开读三件套在缓存节点上立即可用（包已落位、packs 行已登记）
	if _, ok, _ := dst.LatestPack(); !ok {
		t.Fatal("packs 行未登记")
	}
	got, err := os.ReadFile(res.PackPath)
	if err != nil {
		t.Fatal(err)
	}
	copied, err := os.ReadFile(res.PackPath)
	if err != nil || len(got) != len(copied) {
		t.Fatal("pack 字节数异常")
	}
	if _, err := os.Stat(res.PackPath); err != nil {
		t.Fatalf("源包应仍在: %v", err)
	}
	// 正文在缓存节点上仍以密文落盘、以明文供读（L4a′ 只在 store 一层）
	a, ok, err := dst.GetArticle("article:aaa")
	if err != nil || !ok || a.BodyMD != "甲正文\n" {
		t.Fatalf("缓存节点正文 = %+v ok=%v err=%v", a, ok, err)
	}
}

func TestImportPackRejectsUntrustedIssuer(t *testing.T) {
	src, url, tr, _ := newSourceNode(t)
	seedSource(t, src)
	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{}}
	if _, err := cfg.ImportPack(context.Background(), dst, Peer{URL: url}, 0); err == nil {
		t.Fatal("未命中信任表的 issuer 必须拒绝整包")
	}
	if v, _ := dst.ContentVersion(); v != 0 {
		t.Fatalf("拒绝整包后本地水位应不变，got %d", v)
	}
}

func TestImportPackRejectsTamperedManifest(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	res := seedSource(t, src)

	// 直接篡改盘上的 manifest（服务端就是读盘发的），再复制
	raw, err := os.ReadFile(res.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	tampered := strings.Replace(string(raw), `"content_version":1`, `"content_version":2`, 1)
	if tampered == string(raw) {
		t.Fatal("未命中待篡改片段，测试前提失效")
	}
	if err := os.WriteFile(res.ManifestPath, []byte(tampered), 0o644); err != nil {
		t.Fatal(err)
	}

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	if _, err := cfg.ImportPack(context.Background(), dst, Peer{URL: url}, 0); err == nil {
		t.Fatal("篡改 manifest 必须拒绝整包")
	}
	if v, _ := dst.ContentVersion(); v != 0 {
		t.Fatalf("拒绝整包后本地水位应不变，got %d", v)
	}
	if _, ok, _ := dst.LatestPack(); ok {
		t.Fatal("被拒的包不得登记 packs 行")
	}
}

// seedCourseSource 写入一个 course 容器（segments）+ 一个小测（quizzes）+ 一篇文章并导出 1 个包。
// 独立于 seedSource，避免改动既有用例依赖的种子语义。
func seedCourseSource(t *testing.T, st *store.Store) packexport.Result {
	t.Helper()
	body := "甲正文\n"
	if err := st.UpsertArticle(store.Article{
		ItemID: "article:aaa", Title: "甲", Digest: "甲摘要", PublishedAt: "2026-01-01T00:00:00Z",
		TagsJSON: `[]`, BodyMD: body, ContentHash: protocol.SHA256Hex([]byte(body)),
		SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	if err := st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "course/c1", Source: "course", Type: "course", Title: "课程一",
		Segments: []store.Segment{
			{Seq: 0, Kind: "digest", Text: "课程简介"},
			{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
		},
		UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}
	const qjson = `{"schema_version":1,"questions":[]}`
	if err := st.UpsertQuiz(store.Quiz{
		ItemID: "course/c1/lesson/l1/quiz/q1", Title: "小测一", QuestionJSON: qjson,
		ContentHash: protocol.SHA256Hex([]byte(qjson)), SourceRev: "rev-1",
		UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertQuiz: %v", err)
	}
	res, err := packexport.Export(st, packexport.Options{Issuer: srcIssuer, SignKeyHex: srcSeed})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	return res
}

func TestImportPackCopiesSegmentsAndQuizzes(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	seedCourseSource(t, src)

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	outcome, err := cfg.ImportPack(context.Background(), dst, Peer{URL: url}, 0)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if outcome.Status != "imported" {
		t.Fatalf("outcome = %+v", outcome)
	}
	segs, err := dst.ListSegments("course/c1")
	if err != nil {
		t.Fatalf("ListSegments: %v", err)
	}
	if len(segs) != 2 {
		t.Fatalf("segments = %d 行, want 2: %+v", len(segs), segs)
	}
	if segs[0].Seq != 0 || segs[0].Kind != "digest" || segs[0].Text != "课程简介" ||
		segs[1].Seq != 1 || segs[1].Kind != "lesson" || segs[1].Text != "course/c1/lesson/l1" {
		t.Fatalf("segments 行不符: %+v", segs)
	}
	qs, err := dst.ListQuizzes([]string{"course/c1/lesson/l1/quiz/q1"})
	if err != nil {
		t.Fatalf("ListQuizzes: %v", err)
	}
	q, ok := qs["course/c1/lesson/l1/quiz/q1"]
	if !ok || q.QuestionJSON != `{"schema_version":1,"questions":[]}` {
		t.Fatalf("quizzes = %+v ok=%v", qs, ok)
	}
}

func TestImportPackRejectsTamperedSegments(t *testing.T) {
	src, _, _, _ := newSourceNode(t)
	res := seedCourseSource(t, src)

	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(res.PackPath))
	if err != nil {
		t.Fatalf("open pack: %v", err)
	}
	rs, err := db.Exec(`UPDATE segments SET text='篡改文本' WHERE item_id='course/c1' AND seq=1`)
	if err != nil {
		t.Fatalf("篡改 segments: %v", err)
	}
	if n, _ := rs.RowsAffected(); n != 1 {
		t.Fatalf("篡改未命中行: affected=%d", n)
	}
	if err := db.Close(); err != nil { // 必须先释放写句柄，Windows 下否则只读打开会失败
		t.Fatalf("关闭写连接: %v", err)
	}

	_, err = readAndVerifyPack(res.PackPath, res.Manifest)
	if err == nil {
		t.Fatal("segments 行级 hash 被篡改必须拒绝整包")
	}
	if !strings.Contains(err.Error(), "行级 hash 不符") {
		t.Fatalf("应以行级 hash 不符拒绝，got: %v", err)
	}
}

func TestImportPackNoopWhenUpToDate(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	res := seedSource(t, src)
	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	if _, err := cfg.ImportPack(context.Background(), dst, Peer{URL: url}, 0); err != nil {
		t.Fatalf("首次复制: %v", err)
	}
	outcome, err := cfg.ImportPack(context.Background(), dst, Peer{URL: url}, res.ContentVersion)
	if err != nil {
		t.Fatalf("二次复制: %v", err)
	}
	if outcome.Status != "noop" {
		t.Fatalf("同版本应 noop，got %+v", outcome)
	}
}

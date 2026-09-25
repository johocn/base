package httpapi

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/johocn/base/internal/packexport"
	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// 与 RFC 8032 §7.1 TEST 1 相同的确定性测试密钥。
const testSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"

// 测试密钥对应公钥（与 vectors/v1/ed25519.json 一致）。
const testPub = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"

var testCover = []byte("\x89PNG\r\n\x1a\nCOVERBYTES")

// seedStore 写入 2 篇文章 + 1 个封面并导出 1 个包；返回导出结果供断言复用。
func seedStore(t *testing.T, st *store.Store) packexport.Result {
	t.Helper()
	add := func(itemID, title, body string) {
		if err := st.UpsertArticle(store.Article{
			ItemID: itemID, Title: title, Digest: title + "摘要", PublishedAt: "2026-01-01T00:00:00Z",
			TagsJSON: `["演示"]`, BodyMD: body, ContentHash: protocol.SHA256Hex([]byte(body)),
			SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z",
		}); err != nil {
			t.Fatalf("UpsertArticle: %v", err)
		}
	}
	add("article:aaa", "甲", "甲正文\n")
	add("article:bbb", "乙", "乙正文\n")

	hash := protocol.SHA256Hex(testCover)
	if err := st.PutBlob(protocol.BlobID(testCover), testCover, "cover:aaa", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	if err := st.UpsertMediaItem(store.MediaItem{
		ItemID: "cover:aaa", Source: "article", Type: "cover", Title: "甲封面",
		SourceRev: "rev-1", ContentHash: hash, SQLiteTable: "media_meta", MIME: "image/png",
		Size: int64(len(testCover)), ChunkSize: int64(len(testCover)),
		ChunkHashes: []string{hash}, UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertMediaItem: %v", err)
	}

	res, err := packexport.Export(st, packexport.Options{Issuer: "base-node-1", SignKeyHex: testSeed})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	return res
}

func newTestServer(t *testing.T) (*store.Store, packexport.Result, *inprocServer) {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	res := seedStore(t, st)
	srv, err := New(st, Options{Issuer: "base-node-1", SignKeyHex: testSeed, Version: "test"})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	ts := newInprocServer(srv.Handler())
	t.Cleanup(ts.Close)
	return st, res, ts
}

func getJSON(t *testing.T, url string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode %s: %v", url, err)
	}
	return resp.StatusCode, body
}

func TestHealthz(t *testing.T) {
	_, _, ts := newTestServer(t)
	code, body := getJSON(t, ts.URL+"/healthz")
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("healthz: code=%d body=%v", code, body)
	}
}

func TestPubkeyIsAnonymousAndMatchesVector(t *testing.T) {
	_, _, ts := newTestServer(t)
	code, body := getJSON(t, ts.URL+"/v1/pubkey")
	if code != http.StatusOK {
		t.Fatalf("pubkey: code=%d", code)
	}
	if body["public_key_hex"] != testPub {
		t.Fatalf("public_key_hex = %v, want %s", body["public_key_hex"], testPub)
	}
	if body["issuer"] != "base-node-1" {
		t.Fatalf("issuer = %v", body["issuer"])
	}
}

func TestPubkeyAbsentOnDistributionNode(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	srv, err := New(st, Options{Issuer: "base-node-2"})
	if err != nil {
		t.Fatal(err)
	}
	ts := newInprocServer(srv.Handler())
	t.Cleanup(ts.Close)
	resp, err := http.Get(ts.URL + "/v1/pubkey")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("无私钥节点 pubkey 状态 = %d, want 404", resp.StatusCode)
	}
}

func TestCatalogAnonymousFullList(t *testing.T) {
	_, res, ts := newTestServer(t)
	code, body := getJSON(t, ts.URL+"/v1/catalog")
	if code != http.StatusOK {
		t.Fatalf("catalog: code=%d body=%v", code, body)
	}
	if body["pack_id"] != res.PackID {
		t.Fatalf("pack_id = %v, want %s", body["pack_id"], res.PackID)
	}
	if int64(body["content_version"].(float64)) != res.ContentVersion {
		t.Fatalf("content_version = %v, want %d", body["content_version"], res.ContentVersion)
	}
	items := body["items"].([]any)
	if len(items) != 3 {
		t.Fatalf("items = %d, want 3", len(items))
	}
	first := items[0].(map[string]any)
	if first["item_id"] != "article:aaa" || first["type"] != "article" || first["source_rev"] != "rev-1" {
		t.Fatalf("首条目录项异常: %v", first)
	}
	if body["next_cursor"] != nil {
		t.Fatalf("next_cursor = %v, want null", body["next_cursor"])
	}
}

func TestCatalogSinceCurrentVersionIsNoop(t *testing.T) {
	_, res, ts := newTestServer(t)
	code, body := getJSON(t, ts.URL+"/v1/catalog?since="+itoa(res.ContentVersion))
	if code != http.StatusOK {
		t.Fatalf("code=%d", code)
	}
	if len(body["items"].([]any)) != 0 {
		t.Fatalf("since 等于当前版本时 items 应为空: %v", body["items"])
	}
	if body["next_cursor"] != nil {
		t.Fatalf("next_cursor 应为 null: %v", body["next_cursor"])
	}
}

func TestCatalogPagingCursorEndsWithNull(t *testing.T) {
	_, _, ts := newTestServer(t)
	code, body := getJSON(t, ts.URL+"/v1/catalog?limit=1")
	if code != http.StatusOK {
		t.Fatalf("code=%d", code)
	}
	if len(body["items"].([]any)) != 1 || body["next_cursor"] != "article:aaa" {
		t.Fatalf("第一页异常: %v", body)
	}

	code, body = getJSON(t, ts.URL+"/v1/catalog?limit=1&cursor=article:aaa")
	if code != http.StatusOK {
		t.Fatalf("code=%d", code)
	}
	if body["items"].([]any)[0].(map[string]any)["item_id"] != "article:bbb" || body["next_cursor"] != "article:bbb" {
		t.Fatalf("第二页异常: %v", body)
	}

	code, body = getJSON(t, ts.URL+"/v1/catalog?limit=1&cursor=article:bbb")
	if code != http.StatusOK {
		t.Fatalf("code=%d", code)
	}
	if body["items"].([]any)[0].(map[string]any)["item_id"] != "cover:aaa" {
		t.Fatalf("第三页异常: %v", body)
	}
	if body["next_cursor"] != nil {
		t.Fatalf("最后一页 next_cursor 必须为 null（契约第 1 条），got %v", body["next_cursor"])
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestManifestServesExportedFileAndVerifies(t *testing.T) {
	_, res, ts := newTestServer(t)
	resp, err := http.Get(ts.URL + "/v1/manifest/" + res.PackID)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("manifest 状态 = %d", resp.StatusCode)
	}
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(res.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatal("manifest 响应与磁盘文件不一致")
	}
	var m protocol.Manifest
	if err := json.Unmarshal(got, &m); err != nil {
		t.Fatal(err)
	}
	ok, err := m.Verify(testPub)
	if err != nil || !ok {
		t.Fatalf("匿名拉到的 manifest 验签失败: ok=%v err=%v", ok, err)
	}
}

func TestPackServesReadableSQLite(t *testing.T) {
	_, res, ts := newTestServer(t)
	resp, err := http.Get(ts.URL + "/v1/pack/" + res.PackID)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pack 状态 = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "sqlite3") {
		t.Fatalf("pack Content-Type = %q", ct)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(raw)) != mustStat(t, res.PackPath) {
		t.Fatalf("pack 字节数 = %d, 与磁盘文件不一致", len(raw))
	}

	// 落到临时文件后当普通 SQLite 打开，验证「匿名拉到的包真的能读」
	path := filepath.Join(t.TempDir(), "pack.sqlite")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var body string
	if err := db.QueryRow(`SELECT body_md FROM articles WHERE item_id='article:aaa'`).Scan(&body); err != nil {
		t.Fatalf("读 pack.sqlite: %v", err)
	}
	if body != "甲正文\n" {
		t.Fatalf("pack.sqlite 正文 = %q", body)
	}
	var version string
	if err := db.QueryRow(`SELECT value FROM meta WHERE key='content_version'`).Scan(&version); err != nil {
		t.Fatalf("读 pack.sqlite meta: %v", err)
	}
	if version != strconv.FormatInt(res.ContentVersion, 10) {
		t.Fatalf("pack.sqlite content_version = %s, want %d", version, res.ContentVersion)
	}
}

func TestBlobGetAndHead(t *testing.T) {
	st, _, ts := newTestServer(t)
	blob := protocol.BlobID(testCover)

	resp, err := http.Get(ts.URL + "/v1/blob/" + blob)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("blob 状态 = %d", resp.StatusCode)
	}
	if et := resp.Header.Get("ETag"); et != `"`+blob+`"` {
		t.Fatalf("ETag = %q", et)
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("Cache-Control = %q（内容寻址应可长缓存）", cc)
	}
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(testCover) {
		t.Fatal("blob 字节与写入内容不一致")
	}

	req, err := http.NewRequest(http.MethodHead, ts.URL+"/v1/blob/"+blob, nil)
	if err != nil {
		t.Fatal(err)
	}
	head, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer head.Body.Close()
	if head.StatusCode != http.StatusOK {
		t.Fatalf("HEAD 状态 = %d", head.StatusCode)
	}
	if head.ContentLength != int64(len(testCover)) {
		t.Fatalf("HEAD Content-Length = %d, want %d", head.ContentLength, len(testCover))
	}
	body, err := io.ReadAll(head.Body)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) != 0 {
		t.Fatalf("HEAD 不应有 body，收到 %d 字节", len(body))
	}
	_ = st
}

func TestBlobTamperedOnDiskIsRejected(t *testing.T) {
	st, _, ts := newTestServer(t)
	blob := protocol.BlobID(testCover)
	if err := os.WriteFile(st.BlobPath(blob), []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	resp, err := http.Get(ts.URL + "/v1/blob/" + blob)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("坏块必须被拒（500），实际 = %d", resp.StatusCode)
	}
}

func TestContentEndpointsValidation(t *testing.T) {
	_, _, ts := newTestServer(t)
	unknown := strings.Repeat("0", 32)
	cases := []struct {
		path string
		want int
	}{
		{"/v1/blob/XX", http.StatusBadRequest},
		{"/v1/blob/" + unknown, http.StatusNotFound},
		{"/v1/manifest/not-a-pack-id", http.StatusBadRequest},
		{"/v1/manifest/" + unknown, http.StatusNotFound},
		{"/v1/pack/" + unknown, http.StatusNotFound},
	}
	for _, c := range cases {
		resp, err := http.Get(ts.URL + c.path)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != c.want {
			t.Fatalf("%s 状态 = %d, want %d", c.path, resp.StatusCode, c.want)
		}
	}
}

func TestCORSPreflight(t *testing.T) {
	_, _, ts := newTestServer(t)
	req, err := http.NewRequest(http.MethodOptions, ts.URL+"/v1/catalog", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("OPTIONS 状态 = %d", resp.StatusCode)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("缺少 CORS 头")
	}
}

func mustStat(t *testing.T, path string) int64 {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Size()
}
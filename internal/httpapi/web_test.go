package httpapi

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

func getText(t *testing.T, url string) (int, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(b)
}

func TestIndexPageListsPublicArticles(t *testing.T) {
	_, _, ts := newTestServer(t)
	code, body := getText(t, ts.URL+"/")
	if code != http.StatusOK {
		t.Fatalf("首页状态 = %d", code)
	}
	for _, want := range []string{"内容目录", "甲", "乙", `href="/a/article:aaa"`, `href="/a/article:bbb"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("首页缺少 %q\n页面内容：\n%s", want, body)
		}
	}
	if strings.Contains(body, "甲封面") {
		t.Fatalf("首页不应列出 cover 条目：\n%s", body)
	}
}

func TestArticlePageRendersBody(t *testing.T) {
	_, _, ts := newTestServer(t)
	code, body := getText(t, ts.URL+"/a/article:aaa")
	if code != http.StatusOK {
		t.Fatalf("文章页状态 = %d", code)
	}
	for _, want := range []string{"甲", "甲正文", "甲摘要"} {
		if !strings.Contains(body, want) {
			t.Fatalf("文章页缺少 %q\n%s", want, body)
		}
	}
}

func TestArticlePageShowsCoverBlob(t *testing.T) {
	_, _, ts := newTestServer(t)
	code, body := getText(t, ts.URL+"/a/article:aaa")
	if code != http.StatusOK {
		t.Fatalf("文章页状态 = %d", code)
	}
	if !strings.Contains(body, "/v1/blob/"+protocol.BlobID(testCover)) {
		t.Fatalf("有封面的文章页应引用封面块\n%s", body)
	}

	code, body = getText(t, ts.URL+"/a/article:bbb")
	if code != http.StatusOK {
		t.Fatalf("无封面文章页状态 = %d", code)
	}
	if strings.Contains(body, "/v1/blob/") {
		t.Fatalf("无封面的文章页不应出现块链接\n%s", body)
	}
}

func TestArticlePageEscapesHTML(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	evil := "<script>alert(1)</script>"
	if err := st.UpsertArticle(store.Article{
		ItemID: "article:evil", Title: "<b>坏标题</b>", Digest: "摘要",
		PublishedAt: "2026-01-01T00:00:00Z", TagsJSON: `["演示"]`, BodyMD: evil,
		ContentHash: protocol.SHA256Hex([]byte(evil)), SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	srv, err := New(st, Options{Issuer: "base-node-1", Version: "test"})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	ts := newInprocServer(srv.Handler())
	t.Cleanup(ts.Close)

	code, body := getText(t, ts.URL+"/a/article:evil")
	if code != http.StatusOK {
		t.Fatalf("文章页状态 = %d", code)
	}
	if strings.Contains(body, "<script>alert(1)</script>") {
		t.Fatalf("正文未转义，存在注入：\n%s", body)
	}
	if !strings.Contains(body, "&lt;script&gt;") {
		t.Fatalf("缺少转义后的正文：\n%s", body)
	}
	if strings.Contains(body, "<b>坏标题</b>") {
		t.Fatalf("标题未转义：\n%s", body)
	}
}

func TestArticlePageMissingIs404(t *testing.T) {
	_, _, ts := newTestServer(t)
	if code, _ := getText(t, ts.URL+"/a/article:nope"); code != http.StatusNotFound {
		t.Fatalf("不存在的文章状态 = %d, want 404", code)
	}
	// 非 article 类型（这里是 cover）不能被当成文章页渲染
	if code, _ := getText(t, ts.URL+"/a/cover:aaa"); code != http.StatusNotFound {
		t.Fatalf("cover 条目当文章页的状态 = %d, want 404", code)
	}
}
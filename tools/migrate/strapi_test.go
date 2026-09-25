package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

var pngBytes = []byte("\x89PNG\r\n\x1a\n0123456789")

// fixture 同时覆盖两种响应形态：列表为裸数组，详情为 {data:{...}} 包裹。
func newFixture(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/zhao-website/v1/articles", func(w http.ResponseWriter, r *http.Request) {
		// Go 不会把 Header["Host"] 发出去，必须走 req.Host（见 do 的特殊处理）
		if r.Host != "v.joho.cn" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"missing host header"}`))
			return
		}
		page := r.URL.Query().Get("page")
		list := []map[string]any{}
		if page == "1" {
			list = append(list, map[string]any{
				"documentId": "doc-1", "title": "已发布一", "slug": "hello", "excerpt": "摘要一",
				"status": "published", "publishedAt": "2026-01-01T00:00:00.000Z",
				"updatedAt": "2026-01-02T03:04:05.000Z", "tags": []string{"演示", "迁移"},
				"coverImage": map[string]any{"url": "/uploads/cover.png", "mime": "image/png"},
			})
			list = append(list, map[string]any{
				"documentId": "doc-2", "title": "草稿", "slug": "draft-one",
				"status": "draft", "updatedAt": "2026-01-02T03:04:05.000Z",
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(list)
	})
	mux.HandleFunc("/api/zhao-website/v1/articles/hello", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
			"documentId": "doc-1", "title": "已发布一", "slug": "hello",
			"status": "published", "updatedAt": "2026-01-02T03:04:05.000Z",
			"content": "# 标题\n\n正文第一段。\n",
		}})
	})
	mux.HandleFunc("/uploads/cover.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestRunImportsPublishedOnlyAndIsIdempotent(t *testing.T) {
	srv := newFixture(t)
	st := openStore(t)
	opt := Options{
		BaseURL: srv.URL, PageSize: 1, HTTPTimeout: 5 * time.Second,
		Headers: map[string]string{"Host": "v.joho.cn"},
	}

	first, err := Run(st, opt)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if first.Seen != 2 || first.Published != 1 || first.Skipped != 1 || first.Imported != 1 || first.Covers != 1 {
		t.Fatalf("首次统计异常: %+v", first)
	}

	a, ok, err := st.GetArticle("article:hello")
	if err != nil || !ok {
		t.Fatalf("GetArticle: ok=%v err=%v", ok, err)
	}
	if a.BodyMD != "# 标题\n\n正文第一段。\n" {
		t.Fatalf("正文未原样搬运: %q", a.BodyMD)
	}
	if a.ContentHash != protocol.SHA256Hex([]byte(a.BodyMD)) {
		t.Fatalf("content_hash 不匹配: %s", a.ContentHash)
	}
	if a.TagsJSON != `["演示","迁移"]` {
		t.Fatalf("tags_json = %s", a.TagsJSON)
	}

	cover, err := st.ListBlobsForItem("cover:hello")
	if err != nil {
		t.Fatal(err)
	}
	if len(cover) != 1 || cover[0].BlobID != protocol.BlobID(pngBytes) {
		t.Fatalf("封面块未登记: %+v", cover)
	}
	has, size, err := st.HasBlob(protocol.BlobID(pngBytes))
	if err != nil || !has || size != int64(len(pngBytes)) {
		t.Fatalf("封面块文件缺失: has=%v size=%d err=%v", has, size, err)
	}

	// 草稿不得入库
	if _, ok, _ := st.GetArticle("article:draft-one"); ok {
		t.Fatal("草稿被导入了")
	}

	second, err := Run(st, opt)
	if err != nil {
		t.Fatalf("二次 Run: %v", err)
	}
	items, err := st.ListItems("active")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("重跑后条目数 = %d, want 2（幂等）", len(items))
	}
	if second.Imported != 1 {
		t.Fatalf("重跑导入数 = %d, want 1（覆盖同一条目）", second.Imported)
	}
}

func TestRunRequiresBaseURL(t *testing.T) {
	st := openStore(t)
	if _, err := Run(st, Options{}); err == nil {
		t.Fatal("缺少 BaseURL 时未报错")
	}
}

func TestRunEmptySourceIsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
	}))
	t.Cleanup(srv.Close)
	st := openStore(t)
	res, err := Run(st, Options{BaseURL: srv.URL, PageSize: 10})
	if err != nil {
		t.Fatalf("空源不应报错: %v", err)
	}
	if res.Seen != 0 || res.Imported != 0 {
		t.Fatalf("空源统计异常: %+v", res)
	}
}
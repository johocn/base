package importer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

func TestParseMD(t *testing.T) {
	raw := "---\nslug: hello-base\ntitle: 你好 base\ntags: 离线, 协议 ,\npublished_at: 2026-09-25T00:00:00Z\n---\n\n第一段\n\n第二段\n"
	doc, err := ParseMD("20260925-hello.md", []byte(raw))
	if err != nil {
		t.Fatalf("ParseMD: %v", err)
	}
	if doc.Slug != "hello-base" || doc.Title != "你好 base" {
		t.Fatalf("slug/title 解析错误: %+v", doc)
	}
	if len(doc.Tags) != 2 || doc.Tags[0] != "离线" || doc.Tags[1] != "协议" {
		t.Fatalf("tags 解析错误: %+v", doc.Tags)
	}
	if doc.PublishedAt != "2026-09-25T00:00:00Z" {
		t.Fatalf("published_at = %q", doc.PublishedAt)
	}
	if doc.Body != "第一段\n\n第二段" {
		t.Fatalf("body = %q", doc.Body)
	}
	if doc.Digest == "" {
		t.Fatal("digest 不应为空（取正文首行）")
	}

	t.Run("无 front-matter 用文件名与首行标题", func(t *testing.T) {
		doc, err := ParseMD("离线学习指南.md", []byte("# 离线学习指南\n\n正文内容\n"))
		if err != nil {
			t.Fatal(err)
		}
		if doc.Slug != "离线学习指南" || doc.Title != "离线学习指南" {
			t.Fatalf("降级解析失败: %+v", doc)
		}
	})
	t.Run("CRLF 归一", func(t *testing.T) {
		doc, err := ParseMD("a.md", []byte("---\r\nslug: a\r\n---\r\n\r\n正文\r\n第二行\r\n"))
		if err != nil {
			t.Fatal(err)
		}
		if doc.Body != "正文\n第二行" {
			t.Fatalf("body = %q", doc.Body)
		}
	})
}

func TestRunImportIsIdempotent(t *testing.T) {
	dataDir := t.TempDir()
	st, err := store.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	mdDir := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(mdDir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("01-a.md", "---\nslug: a\ntitle: 甲\n---\n\n甲的正文")
	write("02-b.md", "---\nslug: b\ntitle: 乙\n---\n\n乙的正文")

	res, err := Run(st, mdDir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Imported != 2 || res.Failed != 0 {
		t.Fatalf("Run = %+v, want imported 2 / failed 0", res)
	}
	items, _ := st.ListItems("active")
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2", len(items))
	}
	a, ok, _ := st.GetArticle("article:a")
	if !ok {
		t.Fatal("article:a 未写入")
	}
	if a.BodyMD != "甲的正文" || a.ContentHash != protocol.SHA256Hex([]byte("甲的正文")) {
		t.Fatalf("article:a 内容/哈希错误: %+v", a)
	}
	if a.SourceRev == "" || a.TagsJSON == "" || a.PublishedAt == "" {
		t.Fatalf("article:a 派生字段不应为空: %+v", a)
	}

	write("01-a.md", "---\nslug: a\ntitle: 甲（改）\n---\n\n甲的新正文")
	res2, err := Run(st, mdDir)
	if err != nil {
		t.Fatalf("Run(2): %v", err)
	}
	if res2.Imported != 2 {
		t.Fatalf("Run(2) = %+v", res2)
	}
	items2, _ := st.ListItems("active")
	if len(items2) != 2 {
		t.Fatalf("重跑后 items = %d, want 2（幂等键 source+item_id）", len(items2))
	}
	a2, _, _ := st.GetArticle("article:a")
	if a2.Title != "甲（改）" || a2.BodyMD != "甲的新正文" {
		t.Fatalf("重跑未覆盖同一条目: %+v", a2)
	}
}
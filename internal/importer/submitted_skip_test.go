package importer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/johocn/base/internal/store"
)

// 投稿域容器（items.author_id 非空）不得被导入器覆盖：跳过并产 warning，不产 error。
func TestRunSkipsSubmittedContainer(t *testing.T) {
	st := openImporterStore(t)
	// 造一个「投稿域」课程容器：author_id 非空 → 导入器必须绕开。
	if _, err := st.UpsertSegmentSubmission(store.SegmentSubmission{
		ItemID: "course/c1", Type: "course", Title: "投稿的课", AuthorID: "aa", AuthorSig: "ff",
		Segments: []store.Segment{{ItemID: "course/c1", Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"}},
	}); err != nil {
		t.Fatalf("UpsertSegmentSubmission: %v", err)
	}
	dir := t.TempDir()
	md := "---\nslug: a1\ntitle: 甲文\ncourse: c1\nlesson: l1\nlesson_title: 第一讲\n---\n\n正文\n"
	if err := os.WriteFile(filepath.Join(dir, "a1.md"), []byte(md), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Failed != 0 {
		t.Fatalf("投稿域跳过不应计 Failed: %+v", res)
	}
	if len(res.Warnings) == 0 || !strings.Contains(strings.Join(res.Warnings, "\n"), "course/c1") {
		t.Fatalf("应产出 course/c1 的 warning: %+v", res.Warnings)
	}
	// 容器原样保留（title 与行集都没被导入器改写）。
	it, ok, _ := st.GetItem("course/c1")
	if !ok || it.Title != "投稿的课" {
		t.Fatalf("投稿域容器被改写: %+v", it)
	}
}

// 空归属的存量容器（导入器自建）仍可被导入器重建。
func TestRunRebuildsUnattributedContainer(t *testing.T) {
	st := openImporterStore(t)
	if err := st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "course/c2", Source: "course", Type: "course", Title: "旧课",
		Segments: []store.Segment{{ItemID: "course/c2", Seq: 1, Kind: "lesson", Text: "course/c2/lesson/l1"}},
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}
	dir := t.TempDir()
	md := "---\nslug: a2\ntitle: 乙文\ncourse: c2\nlesson: l1\ncourse_title: 新课\n---\n\n正文\n"
	if err := os.WriteFile(filepath.Join(dir, "a2.md"), []byte(md), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(res.Warnings) != 0 {
		t.Fatalf("空归属容器不应跳过: %+v", res.Warnings)
	}
	it, _, _ := st.GetItem("course/c2")
	if it.Title != "新课" {
		t.Fatalf("空归属容器应被重建: %+v", it)
	}
}

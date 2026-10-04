package importer

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// writeMD 把若干 markdown（name → 内容）写进同一个临时目录，返回目录路径。
// Run 只读顶层 *.md，故这里只写平铺文件。
func writeMD(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatalf("写 %s: %v", name, err)
		}
	}
	return dir
}

// segmentTexts 返回某容器 seq>=1 的子项清单（按 seq 升序）。
func segmentTexts(t *testing.T, st *store.Store, itemID string) []string {
	t.Helper()
	segs, err := st.ListSegments(itemID)
	if err != nil {
		t.Fatalf("ListSegments(%s): %v", itemID, err)
	}
	return childIDsOf(segs)
}

func containsID(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

// 规则 3：order 缺省排末尾，order 相同按文件名升序。
func TestCourseOrdering(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\norder: 2\n---\n\n甲",
		"20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\norder: 1\n---\n\n乙",
		"30-c.md": "---\nslug: c\ntitle: 丙\ncourse: c1\nlesson: l1\n---\n\n丙",
	})
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Imported != 3 || res.Failed != 0 {
		t.Fatalf("Run = %+v, want imported 3 / failed 0", res)
	}

	got := segmentTexts(t, st, "course/c1/lesson/l1")
	want := []string{
		"course/c1/lesson/l1/article/b", // order=1
		"course/c1/lesson/l1/article/a", // order=2
		"course/c1/lesson/l1/article/c", // 缺省排末尾
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("课时清单 = %v, want %v", got, want)
	}

	courseGot := segmentTexts(t, st, "course/c1")
	if !reflect.DeepEqual(courseGot, []string{"course/c1/lesson/l1"}) {
		t.Fatalf("课程清单 = %v", courseGot)
	}
}

// 规则 1：course 缺省 → 独立文章 article/<slug>，不进任何清单。
func TestCoursePlacementUnclassified(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"a.md": "---\nslug: solo\ntitle: 独立文章\n---\n\n正文",
	})
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Imported != 1 || res.Failed != 0 {
		t.Fatalf("Run = %+v", res)
	}
	if _, ok, _ := st.GetArticle("article/solo"); !ok {
		t.Fatal("article/solo 未写入")
	}
	items, _ := st.ListItems("active")
	if len(items) != 1 {
		t.Fatalf("未归类文章不应产生容器条目，items = %d", len(items))
	}
	for _, it := range items {
		for _, id := range segmentTexts(t, st, it.ItemID) {
			if id == "article/solo" {
				t.Fatalf("未归类文章出现在清单 %s 里", it.ItemID)
			}
		}
	}
}

// 规则 2：course 有值、lesson 缺省 → 只该文件失败，不整批失败。
func TestCourseMissingLessonFailsThatFileOnly(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"01-ok.md":  "---\nslug: ok\ntitle: 正常\n---\n\n正文",
		"02-bad.md": "---\nslug: bad\ntitle: 缺课时\ncourse: c1\n---\n\n正文",
	})
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run 不应报顶层 error（不整批失败）: %v", err)
	}
	if res.Imported != 1 || res.Failed != 1 {
		t.Fatalf("Run = %+v, want imported 1 / failed 1", res)
	}
	if !strings.Contains(strings.Join(res.Errors, "\n"), "02-bad.md") {
		t.Fatalf("Errors 未包含失败文件名: %v", res.Errors)
	}
	if _, ok, _ := st.GetArticle("article/ok"); !ok {
		t.Fatal("同批正常文章应仍写入")
	}
}

// 规则 4：容器 title / digest 缺省口径。
func TestCourseContainerTitleAndDigestDefaults(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"01-default.md":  "---\nslug: d\ntitle: 默认\ncourse: c2\nlesson: l2\n---\n\n正文",
		"02-explicit.md": "---\nslug: e\ntitle: 显式\ncourse: c3\ncourse_title: 显式课程\ncourse_digest: 课程简介\nlesson: l3\nlesson_title: 第一讲\nlesson_digest: 课时简介\n---\n\n正文",
	})
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// 缺省：title 回退 <cid> / <lid>，无 seq=0 行。
	c2, ok, _ := st.GetItem("course/c2")
	if !ok || c2.Title != "c2" {
		t.Fatalf("course/c2 title = %+v, want c2", c2)
	}
	l2, ok, _ := st.GetItem("course/c2/lesson/l2")
	if !ok || l2.Title != "l2" {
		t.Fatalf("course/c2/lesson/l2 title = %+v, want l2", l2)
	}
	for _, id := range []string{"course/c2", "course/c2/lesson/l2"} {
		segs, _ := st.ListSegments(id)
		for _, s := range segs {
			if s.Seq == 0 {
				t.Fatalf("%s 的 digest 缺省，不应有 seq=0 行", id)
			}
		}
	}

	// 显式：title 取声明值，seq=0 存在且 text 为 digest。
	c3, ok, _ := st.GetItem("course/c3")
	if !ok || c3.Title != "显式课程" {
		t.Fatalf("course/c3 title = %+v, want 显式课程", c3)
	}
	l3, ok, _ := st.GetItem("course/c3/lesson/l3")
	if !ok || l3.Title != "第一讲" {
		t.Fatalf("course/c3/lesson/l3 title = %+v, want 第一讲", l3)
	}
	c3segs, _ := st.ListSegments("course/c3")
	if len(c3segs) == 0 || c3segs[0].Seq != 0 || c3segs[0].Text != "课程简介" {
		t.Fatalf("course/c3 seq=0 = %+v, want 课程简介", c3segs)
	}
	l3segs, _ := st.ListSegments("course/c3/lesson/l3")
	if len(l3segs) == 0 || l3segs[0].Seq != 0 || l3segs[0].Text != "课时简介" {
		t.Fatalf("course/c3/lesson/l3 seq=0 = %+v, want 课时简介", l3segs)
	}
}

// 规则 6（前半）：连跑两次幂等。
func TestCourseRunIdempotent(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"01-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\norder: 1\n---\n\n甲",
		"02-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\norder: 2\n---\n\n乙",
		"03-c.md": "---\nslug: c\ntitle: 丙\ncourse: c1\nlesson: l2\n---\n\n丙",
		"04-d.md": "---\nslug: d\ntitle: 丁\n---\n\n丁",
	})
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("Run(1): %v", err)
	}
	first := snapshotSegments(t, st)
	count1 := len(listActive(t, st))

	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("Run(2): %v", err)
	}
	if second := snapshotSegments(t, st); !reflect.DeepEqual(first, second) {
		t.Fatalf("重跑 segments 不一致:\n first=%v\nsecond=%v", first, second)
	}
	if count2 := len(listActive(t, st)); count2 != count1 {
		t.Fatalf("重跑 items 条数变化: %d → %d", count1, count2)
	}
}

// 规则 6（后半）：合并式重建不得删掉 import-video 产出的行，也不得冲掉 md 的 lesson_title。
func TestCourseRebuildKeepsVideoChild(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"01-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\nlesson_title: 第一讲\n---\n\n甲的正文",
	})
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("Run(1): %v", err)
	}

	// 模拟 import-video 的产物（Task 5 才给 VideoOptions 加 Course/Lesson，这里直连 store）。
	videoID := "course/c1/lesson/l1/video/v1"
	videoHash := protocol.SHA256Hex([]byte("video-bytes"))
	if err := st.UpsertMediaItem(store.MediaItem{
		ItemID: videoID, Source: "lesson", Type: "video", Title: "视频一",
		SourceRev: videoHash[:16], ContentHash: videoHash, SQLiteTable: "media_meta",
		MIME: "video/mp4", Size: 11, ChunkSize: 11, ChunkHashes: []string{videoHash},
	}); err != nil {
		t.Fatalf("UpsertMediaItem: %v", err)
	}
	if err := ensureLessonChild(st, "c1", "l1", videoID); err != nil {
		t.Fatalf("ensureLessonChild: %v", err)
	}

	// 视频并入不得冲掉 md 设好的 lesson_title。
	before, ok, _ := st.GetItem("course/c1/lesson/l1")
	if !ok || before.Title != "第一讲" {
		t.Fatalf("ensureLessonChild 冲掉了 lesson_title: %+v", before)
	}

	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("Run(2): %v", err)
	}
	got := segmentTexts(t, st, "course/c1/lesson/l1")
	if !containsID(got, videoID) {
		t.Fatalf("合并式重建删掉了视频行: %v", got)
	}
	if !containsID(got, "course/c1/lesson/l1/article/a") {
		t.Fatalf("md 文章行丢失: %v", got)
	}
	after, _, _ := st.GetItem("course/c1/lesson/l1")
	if after.Title != "第一讲" {
		t.Fatalf("重跑后 lesson_title = %q, want 第一讲", after.Title)
	}
}

// resolvePlacement 的直接口径：只有 article 允许无 course。
func TestResolvePlacement(t *testing.T) {
	p, err := resolvePlacement(map[string]string{}, "article", "solo", "solo.md")
	if err != nil {
		t.Fatalf("article 缺 course 不应报错: %v", err)
	}
	if p.ItemID != "article/solo" || p.Course != "" || p.Lesson != "" {
		t.Fatalf("placement = %+v", p)
	}

	// quiz 现在允许 standalone → quiz/{slug}
	if _, err := resolvePlacement(map[string]string{}, "quiz", "q", "q.md"); err != nil {
		t.Fatalf("quiz 缺 course 不应报错（standalone 用 quiz/ 命名空间）: %v", err)
	}

	// video 仍需 course
	if _, err := resolvePlacement(map[string]string{}, "video", "v", "v.md"); err == nil {
		t.Fatal("video 缺 course 应报错")
	}

	if _, err := resolvePlacement(map[string]string{"course": "c1"}, "article", "a", "a.md"); err == nil {
		t.Fatal("course 有值、lesson 缺省应报错")
	}

	p, err = resolvePlacement(map[string]string{"course": "c1", "lesson": "l1", "order": " 2 "}, "article", "a", "a.md")
	if err != nil {
		t.Fatalf("完整归属不应报错: %v", err)
	}
	if p.ItemID != "course/c1/lesson/l1/article/a" || p.Order != "2" || p.Filename != "a.md" {
		t.Fatalf("placement = %+v", p)
	}
}

func listActive(t *testing.T, st *store.Store) []store.Item {
	t.Helper()
	items, err := st.ListItems("active")
	if err != nil {
		t.Fatalf("ListItems: %v", err)
	}
	return items
}

// snapshotSegments 记录每个 active 条目的清单，用于幂等比对。
func snapshotSegments(t *testing.T, st *store.Store) map[string][]store.Segment {
	t.Helper()
	out := map[string][]store.Segment{}
	for _, it := range listActive(t, st) {
		segs, err := st.ListSegments(it.ItemID)
		if err != nil {
			t.Fatalf("ListSegments(%s): %v", it.ItemID, err)
		}
		out[it.ItemID] = segs
	}
	return out
}

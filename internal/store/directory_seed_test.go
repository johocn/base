package store

import (
	"testing"
)

// TestDirectorySeedFromExisting 验收 AC9：开库时把存量分类 / 讲师 / 标签登记为 approved，
// 且只 bump 一次目录版本；再次开库靠 directory_seeded 短路，不重复写入也不再 bump。
func TestDirectorySeedFromExisting(t *testing.T) {
	dir := t.TempDir()

	// 第一次 Open：库为空，seed 无内容可采（不 bump，也不落短路键）。
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open(1): %v", err)
	}
	if v, err := st.DirectoryVersion(); err != nil || v != 0 {
		t.Fatalf("空库 DirectoryVersion=%d err=%v, want 0", v, err)
	}

	// 造存量内容：容器属性段、分类容器、标签条目。
	if err := st.UpsertSegmentItem(SegmentItem{
		ItemID: "course/c1", Source: "course", Type: "course", Title: "课程一",
		Segments: []Segment{
			{ItemID: "course/c1", Seq: -2, Kind: "attr.category", Text: "数学"},
			{ItemID: "course/c1", Seq: -1, Kind: "attr.instructor", Text: "李老师"},
		},
	}); err != nil {
		t.Fatalf("UpsertSegmentItem(course): %v", err)
	}
	if err := st.UpsertSegmentItem(SegmentItem{
		ItemID: "category/math", Source: "category", Type: "category", Title: "数学",
		Segments: []Segment{},
	}); err != nil {
		t.Fatalf("UpsertSegmentItem(category): %v", err)
	}
	if err := st.UpsertSegmentItem(SegmentItem{
		ItemID: "tag/数学/第一章/第一节", Source: "tag", Type: "tag", Title: "数学",
		Segments: []Segment{},
	}); err != nil {
		t.Fatalf("UpsertSegmentItem(tag): %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("Close(1): %v", err)
	}

	// 第二次 Open：触发 seed，存量名称登记为 approved。
	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("Open(2): %v", err)
	}
	approved, pending, err := st2.ListDirectory()
	if err != nil {
		t.Fatalf("ListDirectory(2): %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("seed 后不应有 pending: %+v", pending)
	}
	byKey := make(map[[2]string]DirectoryTerm, len(approved))
	for _, term := range approved {
		byKey[[2]string{term.Kind, term.TermKey}] = term
	}
	want := []struct{ kind, key, display string }{
		{DirectoryKindCategory, "数学", "数学"},
		{DirectoryKindInstructor, "李老师", "李老师"},
		{DirectoryKindCategory, "math", "math"},
		{DirectoryKindTag, "数学", "数学"},
	}
	for _, w := range want {
		term, ok := byKey[[2]string{w.kind, w.key}]
		if !ok {
			t.Fatalf("缺词条 (%s,%s); approved=%+v", w.kind, w.key, approved)
		}
		if term.State != DirectoryStateApproved || term.DisplayName != w.display {
			t.Fatalf("词条 (%s,%s)=%+v, want state=approved display=%q", w.kind, w.key, term, w.display)
		}
	}
	if len(approved) != len(want) {
		t.Fatalf("approved 数量=%d, want %d: %+v", len(approved), len(want), approved)
	}
	v2, err := st2.DirectoryVersion()
	if err != nil || v2 != 1 {
		t.Fatalf("seed 后 DirectoryVersion=%d err=%v, want 1（首次 Open 空库不 bump，seed 写入才 bump 一次）", v2, err)
	}
	if err := st2.Close(); err != nil {
		t.Fatalf("Close(2): %v", err)
	}

	// 第三次 Open：directory_seeded 生效，不再重复 seed、不再 bump。
	st3, err := Open(dir)
	if err != nil {
		t.Fatalf("Open(3): %v", err)
	}
	defer func() { _ = st3.Close() }()
	v3, err := st3.DirectoryVersion()
	if err != nil || v3 != v2 {
		t.Fatalf("重复 Open 后 DirectoryVersion=%d err=%v, want %d（不得再 bump）", v3, err, v2)
	}
	approved3, pending3, err := st3.ListDirectory()
	if err != nil {
		t.Fatalf("ListDirectory(3): %v", err)
	}
	if len(approved3) != len(approved) || len(pending3) != 0 {
		t.Fatalf("重复 Open 词条数变化: approved=%d pending=%d, want %d/0", len(approved3), len(pending3), len(approved))
	}
}

// TestDirectorySeedEmptyDatabase 全新空库：不 seed、不 bump、无词条。
func TestDirectorySeedEmptyDatabase(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	if v, err := st.DirectoryVersion(); err != nil || v != 0 {
		t.Fatalf("空库 DirectoryVersion=%d err=%v, want 0", v, err)
	}
	approved, pending, err := st.ListDirectory()
	if err != nil {
		t.Fatalf("ListDirectory: %v", err)
	}
	if len(approved) != 0 || len(pending) != 0 {
		t.Fatalf("空库不应有词条: approved=%+v pending=%+v", approved, pending)
	}
}

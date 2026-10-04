package importer

import (
	"reflect"
	"sort"
	"testing"

	"github.com/johocn/base/internal/store"
)

// TestRebuildTagLinks_Basic article + quiz 带 tags → 自动建 tag 容器
func TestRebuildTagLinks_Basic(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ntags: 考试,复习\n---\n\n甲正文\n",
		"q.md": "---\ntype: quiz\nslug: q1\ncourse: c1\nlesson: l1\ntags: 考试\n---\n\n### 题\n- [x] 甲\n- 乙\n",
	})
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Imported != 2 || res.Failed != 0 {
		t.Fatalf("Run = %+v", res)
	}

	// 两个 tag 都应有 item 行
	for _, tagID := range []string{"tag/考试", "tag/复习"} {
		it, ok, err := st.GetItem(tagID)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			t.Fatalf("%s item 未创建", tagID)
		}
		if it.Source != "tag" || it.Type != "tag" || it.SQLiteTable != "segments" {
			t.Fatalf("%s item 列异常: %+v", tagID, it)
		}
		if it.AuthorID != "" {
			t.Fatalf("%s author_id 应为空 (importer 自建, 可被 governance 认领), got %q", tagID, it.AuthorID)
		}
	}

	// tag/考试 → article + quiz 两条
	examLinks, _ := st.ListTagLinks("tag/考试")
	sort.Slice(examLinks, func(i, j int) bool { return examLinks[i].TargetID < examLinks[j].TargetID })
	if len(examLinks) != 2 {
		t.Fatalf("tag/考试 应有 2 条, 实得 %+v", examLinks)
	}
	if examLinks[0].TargetID != "course/c1/lesson/l1/article/a" || examLinks[0].Kind != "article" {
		t.Fatalf("article link 异常: %+v", examLinks[0])
	}
	if examLinks[1].TargetID != "course/c1/lesson/l1/quiz/q1" || examLinks[1].Kind != "quiz" {
		t.Fatalf("quiz link 异常: %+v", examLinks[1])
	}

	// tag/复习 → article 一条
	reviewLinks, _ := st.ListTagLinks("tag/复习")
	if len(reviewLinks) != 1 || reviewLinks[0].TargetID != "course/c1/lesson/l1/article/a" || reviewLinks[0].Kind != "article" {
		t.Fatalf("tag/复习 link 异常: %+v", reviewLinks)
	}

	// 物化 segments 行验证
	segs, _ := st.ListSegments("tag/考试")
	if len(segs) != 2 || segs[0].Kind != "article" || segs[1].Kind != "quiz" {
		t.Fatalf("tag/考试 segments 异常: %+v", segs)
	}
}

// TestRebuildTagLinks_GovernedTagSkipped importer 不覆盖 governance 管控的 tag
func TestRebuildTagLinks_GovernedTagSkipped(t *testing.T) {
	st := openTemp(t)

	// Step 1: governance 先建 tag/考纲 (author_id="aa")
	if _, err := st.UpsertTagSubmission(store.TagSubmission{
		TagID:     "tag/考纲",
		Title:     "考纲",
		Links:     []store.TagLink{{TagID: "tag/考纲", TargetID: "article/outside", Kind: "article"}},
		AuthorID:  "aa",
		AuthorSig: "sig1",
	}); err != nil {
		t.Fatalf("首轮 UpsertTagSubmission: %v", err)
	}
	linksBefore, _ := st.ListTagLinks("tag/考纲")
	if len(linksBefore) != 1 || linksBefore[0].TargetID != "article/outside" {
		t.Fatalf("governance 关联未生效: %+v", linksBefore)
	}

	// Step 2: importer 导入新 quiz 带 tag/考纲 → 应跳过 governance tag, 不覆盖
	dir := writeMD(t, map[string]string{
		"q.md": "---\ntype: quiz\nslug: q2\ncourse: c1\nlesson: l1\ntags: 考纲\n---\n\n### 题\n- 甲\n",
	})
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("Run: %v", err)
	}

	linksAfter, _ := st.ListTagLinks("tag/考纲")
	if len(linksAfter) != 1 || linksAfter[0].TargetID != "article/outside" {
		t.Fatalf("importer 不应覆盖 governance tag 关联, 实得 %+v", linksAfter)
	}
}

// TestRebuildTagLinks_Idempotent 同一输入重复 Run, tag item / tag_links 不变
func TestRebuildTagLinks_Idempotent(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"a.md": "---\nslug: a\ntitle: 甲\ntags: 核心\n---\n\n甲\n",
		"b.md": "---\nslug: b\ntitle: 乙\ntags: 核心\n---\n\n乙\n",
	})
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("首轮 Run: %v", err)
	}
	first, _ := st.ListTagLinks("tag/核心")
	sort.Slice(first, func(i, j int) bool { return first[i].TargetID < first[j].TargetID })
	// 幂等重跑
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("次轮 Run: %v", err)
	}
	second, _ := st.ListTagLinks("tag/核心")
	sort.Slice(second, func(i, j int) bool { return second[i].TargetID < second[j].TargetID })
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("幂等性破坏:\n  首轮 %+v\n  次轮 %+v", first, second)
	}
}

// TestRebuildTagLinks_DuplicateTags 同一内容带重复 tag 名, tag_links 只写一行
func TestRebuildTagLinks_DuplicateTags(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		// a, b 都带相同 tag, importer 去重
		"a.md": "---\nslug: a\ntitle: 甲\ntags: 重复,重复,唯一\n---\n\n甲\n",
		"b.md": "---\nslug: b\ntitle: 乙\ntags: 重复\n---\n\n乙\n",
	})
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	repeats, _ := st.ListTagLinks("tag/重复")
	// a 和 b 各一条 → 2 条, 但 tag 名本身重复只保留一条
	if len(repeats) != 2 {
		t.Fatalf("tag/重复 应有 2 条, 实得 %+v", repeats)
	}
	uniques, _ := st.ListTagLinks("tag/唯一")
	if len(uniques) != 1 {
		t.Fatalf("tag/唯一 应有 1 条, 实得 %+v", uniques)
	}
}

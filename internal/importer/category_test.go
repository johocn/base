package importer

import (
	"reflect"
	"strings"
	"testing"
)

// writeMD、openTemp、segmentTexts 三个 helper 已存在于同包测试
// （course_test.go / video_test.go），此处直接复用。

func TestCategorySingleAttributionFailsFast(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n甲",
		"20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\ncategory: physics\n---\n\n乙",
	})
	_, err := Run(st, dir, Options{})
	if err == nil {
		t.Fatal("同一课程声明两个分类必须报错")
	}
	if !strings.Contains(err.Error(), "至多属一个分类") {
		t.Fatalf("错误文案不符: %v", err)
	}
	// 硬校验在任何写库之前：库里不得留下任何条目
	items, lerr := st.ListItems("active")
	if lerr != nil {
		t.Fatal(lerr)
	}
	if len(items) != 0 {
		t.Fatalf("报错后库内条目 = %d, want 0（必须在写库前失败）", len(items))
	}
}

func TestCategorySlugInvalidFailsFast(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: Math_1\n---\n\n甲",
	})
	if _, err := Run(st, dir, Options{}); err == nil || !strings.Contains(err.Error(), "不是合法 slug") {
		t.Fatalf("非法 category slug 必须报错，实得 %v", err)
	}
}

func TestCategoryWithoutCourseFailsFast(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncategory: math\n---\n\n甲",
	})
	if _, err := Run(st, dir, Options{}); err == nil || !strings.Contains(err.Error(), "没有 course") {
		t.Fatalf("声明 category 但无 course 必须报错，实得 %v", err)
	}
}

func TestCategorySameSlugAcrossDocsIsFine(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\n---\n\n甲",
		"20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l2\ncategory: math\n---\n\n乙",
	})
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Imported != 2 || res.Failed != 0 {
		t.Fatalf("Run = %+v, want imported 2 / failed 0", res)
	}
	it, ok, _ := st.GetItem("category/math")
	if !ok || it.Source != "category" || it.Type != "category" || it.SQLiteTable != "segments" {
		t.Fatalf("分类条目异常: %+v ok=%v", it, ok)
	}
	if it.Title != "数学" {
		t.Fatalf("分类标题 = %q, want 数学（取第一个非空 category_title）", it.Title)
	}
	if got := segmentTexts(t, st, "category/math"); !reflect.DeepEqual(got, []string{"course/c1"}) {
		t.Fatalf("分类清单 = %v, want [course/c1]", got)
	}
}

func TestCategoryListIsSortedByCourseID(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c2\nlesson: l1\ncategory: math\ncategory_digest: 数学入门\n---\n\n甲",
		"20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n乙",
	})
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	segs, err := st.ListSegments("category/math")
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 3 || segs[0].Seq != 0 || segs[0].Kind != "digest" || segs[0].Text != "数学入门" {
		t.Fatalf("seq=0 简介行异常: %+v", segs)
	}
	got := segmentTexts(t, st, "category/math")
	want := []string{"course/c1", "course/c2"} // cid 字典序，与文件遍历顺序无关
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("分类清单 = %v, want %v", got, want)
	}
}

func TestCategoryMoveClearsOldCategory(t *testing.T) {
	st := openTemp(t)
	before := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n甲",
	})
	if _, err := Run(st, before, Options{}); err != nil {
		t.Fatalf("首轮 Run: %v", err)
	}
	courseBefore, ok, _ := st.GetItem("course/c1")
	if !ok {
		t.Fatal("course/c1 未落地")
	}

	after := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: physics\n---\n\n甲",
	})
	if _, err := Run(st, after, Options{}); err != nil {
		t.Fatalf("次轮 Run: %v", err)
	}
	if got := segmentTexts(t, st, "category/physics"); !reflect.DeepEqual(got, []string{"course/c1"}) {
		t.Fatalf("新分类清单 = %v, want [course/c1]", got)
	}
	if got := segmentTexts(t, st, "category/math"); len(got) != 0 {
		t.Fatalf("旧分类清单 = %v, want 空（AC 3：旧分类里不再出现该课程）", got)
	}
	courseAfter, _, _ := st.GetItem("course/c1")
	if courseAfter.ContentHash != courseBefore.ContentHash {
		t.Fatalf("课程 content_hash 变了: %s → %s（AC 3 要求不变）", courseBefore.ContentHash, courseAfter.ContentHash)
	}
}

func TestCategoryRunIdempotentAndDeterministic(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\n---\n\n甲",
	})
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("首轮 Run: %v", err)
	}
	first, _, _ := st.GetItem("category/math")
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("次轮 Run: %v", err)
	}
	second, _, _ := st.GetItem("category/math")
	if first.ContentHash != second.ContentHash {
		t.Fatalf("重复导入分类条目哈希漂移: %s → %s", first.ContentHash, second.ContentHash)
	}
	if got := segmentTexts(t, st, "category/math"); !reflect.DeepEqual(got, []string{"course/c1"}) {
		t.Fatalf("重复导入后清单 = %v（行数不得叠加）", got)
	}
}

func TestCategoryDigestAndTitleSurviveUndeclaredRerun(t *testing.T) {
	st := openTemp(t)
	first := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\ncategory_digest: 数学入门\n---\n\n甲",
	})
	if _, err := Run(st, first, Options{}); err != nil {
		t.Fatalf("首轮 Run: %v", err)
	}
	// 第二轮：文档不再声明 category（课程进「未归类」），既有分类条目被重写为空清单但标题简介保留
	second := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\n---\n\n甲",
	})
	if _, err := Run(st, second, Options{}); err != nil {
		t.Fatalf("次轮 Run: %v", err)
	}
	it, ok, _ := st.GetItem("category/math")
	if !ok || it.Title != "数学" {
		t.Fatalf("既有分类条目应保留: %+v ok=%v", it, ok)
	}
	if got := segmentTexts(t, st, "category/math"); len(got) != 0 {
		t.Fatalf("清单 = %v, want 空", got)
	}
	segs, _ := st.ListSegments("category/math")
	if len(segs) != 1 || segs[0].Seq != 0 || segs[0].Text != "数学入门" {
		t.Fatalf("seq=0 简介行应沿用既有值: %+v", segs)
	}
}

func TestCategoryIgnoresIndependentDocuments(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\n---\n\n甲",
		"20-q.md": "---\ntype: quiz\nslug: q\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\n---\n\n" + quizBody(),
	})
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Imported != 2 {
		t.Fatalf("Run = %+v, want imported 2", res)
	}
	// quiz 与 article 共用文档级三键：quiz 也能为它的课程声明分类
	if got := segmentTexts(t, st, "category/math"); !reflect.DeepEqual(got, []string{"course/c1"}) {
		t.Fatalf("分类清单 = %v, want [course/c1]", got)
	}
	// 独立文章不进任何分类清单，仍是 article/<slug>
	if _, ok, _ := st.GetItem("article/a"); !ok {
		t.Fatal("独立文章应是 article/a")
	}
}

// quizBody 返回一段合法题库正文（同包 quiz_test.go 已有同类夹具，此处取一份最小可用形态）。
func quizBody() string {
	return "### 题\n- [x] 甲\n- 乙\n"
}

package httpapi

import (
	"net/http"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// containerSubmitBody 造一份容器投稿体：content_hash 走容器口径（SegmentsContentHash），
// 签名与 article/quiz 同域（protocol.AuthorSignBytes(itemID, contentHash, id)）。
func containerSubmitBody(t *testing.T, seed, typ, itemID, title string, segs []submitSegment) string {
	t.Helper()
	id, _ := identityFromSeed(t, seed)
	rows := make([]store.Segment, 0, len(segs))
	for _, s := range segs {
		rows = append(rows, store.Segment{ItemID: itemID, Seq: s.Seq, Kind: s.Kind, Text: s.Text})
	}
	hash := store.SegmentsContentHash(rows)
	signBytes, err := protocol.AuthorSignBytes(itemID, hash, id)
	if err != nil {
		t.Fatalf("AuthorSignBytes: %v", err)
	}
	sig, err := protocol.Sign(seed, signBytes)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return mustJSON(t, map[string]any{
		"type": typ, "item_id": itemID, "title": title, "segments": segs, "author_sig": sig,
	})
}

func TestContainerShapeOf(t *testing.T) {
	ok := map[string]string{
		"course/c1":                 "course",
		"course/c1/lesson/l1":       "lesson",
		"course/a-b/lesson/l-2":     "lesson",
		"course/" + repeat("c", 64): "course",
	}
	for id, want := range ok {
		if got, good := containerShapeOf(id); !good || got != want {
			t.Fatalf("containerShapeOf(%q) = (%q,%v), want (%q,true)", id, got, good, want)
		}
	}
	bad := []string{
		"", "course", "course/", "course/C1", "course/c1/", "course/c1/lesson",
		"course/c1/lesson/", "course/c1/lesson/L1", "lesson/l1",
		"course/c1/lesson/l1/quiz/q1", "course/" + repeat("c", 65),
	}
	for _, id := range bad {
		if got, good := containerShapeOf(id); good {
			t.Fatalf("containerShapeOf(%q) 应不识别，却得到 %q", id, got)
		}
	}
}

// 课程与课时两种容器都能落库，且 content_hash 走容器口径。
func TestSubmitAcceptsCourseAndLesson(t *testing.T) {
	n := newSubmitNode(t)
	// 课程：封面属性 + 简介 + 一个课时子项
	courseBody := containerSubmitBody(t, testSeed, "course", "course/c1", "甲课", []submitSegment{
		{Seq: -1, Kind: "attr.cover", Text: "00112233445566778899aabbccddeeff"},
		{Seq: 0, Kind: "digest", Text: "简介\n"},
		{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
	})
	code, out := postSubmit(t, n, testSeed, courseBody)
	if code != http.StatusOK || out["created"] != true {
		t.Fatalf("课程投稿: code=%d out=%v", code, out)
	}
	segs, err := n.st.ListSegments("course/c1")
	if err != nil || len(segs) != 3 {
		t.Fatalf("课程 segments: n=%d err=%v", len(segs), err)
	}
	if segs[0].Seq != -1 || segs[1].Seq != 0 || segs[2].Seq != 1 {
		t.Fatalf("课程 segments 未按 seq 升序: %+v", segs)
	}
	it, ok, err := n.st.GetItem("course/c1")
	if err != nil || !ok {
		t.Fatalf("GetItem: ok=%v err=%v", ok, err)
	}
	if want := store.SegmentsContentHash(segs); it.ContentHash != want {
		t.Fatalf("content_hash=%s want=%s", it.ContentHash, want)
	}
	if it.Type != "course" || it.AuthorID == "" {
		t.Fatalf("items 行不对: %+v", it)
	}

	// 课时：正文属性 + 一个 article 子项
	lessonBody := containerSubmitBody(t, testSeed, "lesson", "course/c1/lesson/l1", "第一讲", []submitSegment{
		{Seq: -1, Kind: "attr.body_md", Text: "# 讲稿\n\n正文\n"},
		{Seq: 1, Kind: "article", Text: "course/c1/lesson/l1/article/a1"},
	})
	code, out = postSubmit(t, n, testSeed, lessonBody)
	if code != http.StatusOK || out["created"] != true {
		t.Fatalf("课时投稿: code=%d out=%v", code, out)
	}
	lsegs, err := n.st.ListSegments("course/c1/lesson/l1")
	if err != nil || len(lsegs) != 2 || lsegs[0].Kind != "attr.body_md" || lsegs[1].Kind != "article" {
		t.Fatalf("课时 segments: %+v err=%v", lsegs, err)
	}
}

// 回归（F1，0.15.0 实测 400）：≥2 条属性行时两种传入顺序都必须落库。
// 线上口径是「编辑器按 assignAttrSeqs 产出 seq 降序 → 节点校验前按 seq 升序排序」——
// 旧 AttrSeqsCanonical 逐元素比对，只认降序，故 ≥2 条属性行必判 item_segments_invalid。
func TestSubmitAcceptsMultipleAttrRowsInEitherOrder(t *testing.T) {
	canonical := []submitSegment{
		{Seq: -1, Kind: "attr.cover", Text: "00112233445566778899aabbccddeeff"},
		{Seq: -2, Kind: "attr.difficulty", Text: "basic"},
		{Seq: -3, Kind: "attr.duration", Text: "600"},
		{Seq: -4, Kind: "attr.instructor", Text: "李老师"},
	}
	for _, c := range []struct {
		name string
		in   []submitSegment
	}{
		{"编辑器产出顺序（seq 降序）", canonical},
		{"校验端排序顺序（seq 升序）", []submitSegment{canonical[3], canonical[2], canonical[1], canonical[0]}},
	} {
		n := newSubmitNode(t)
		segs := append(append([]submitSegment{}, c.in...),
			submitSegment{Seq: 0, Kind: "digest", Text: "简介"},
			submitSegment{Seq: 1, Kind: "lesson", Text: "course/c3/lesson/l1"},
		)
		body := containerSubmitBody(t, testSeed, "course", "course/c3", "甲课", segs)
		code, out := postSubmit(t, n, testSeed, body)
		if code != http.StatusOK || out["created"] != true {
			t.Fatalf("%s: code=%d out=%v", c.name, code, out)
		}
		stored, err := n.st.ListSegments("course/c3")
		if err != nil || len(stored) != 6 {
			t.Fatalf("%s: n=%d err=%v", c.name, len(stored), err)
		}
		for i := 1; i < len(stored); i++ {
			if stored[i-1].Seq >= stored[i].Seq {
				t.Fatalf("%s: 未按 seq 升序落库: %+v", c.name, stored)
			}
		}
		it, ok, err := n.st.GetItem("course/c3")
		if err != nil || !ok {
			t.Fatalf("%s: GetItem ok=%v err=%v", c.name, ok, err)
		}
		if want := store.SegmentsContentHash(stored); it.ContentHash != want {
			t.Fatalf("%s: content_hash=%s want=%s", c.name, it.ContentHash, want)
		}
	}
}

// 本人重投同一容器 → created=false，行集整体替换。
func TestSubmitContainerReSubmitByOwner(t *testing.T) {
	n := newSubmitNode(t)
	first := containerSubmitBody(t, testSeed, "course", "course/c9", "甲课", []submitSegment{
		{Seq: 1, Kind: "lesson", Text: "course/c9/lesson/l1"},
	})
	if code, out := postSubmit(t, n, testSeed, first); code != http.StatusOK {
		t.Fatalf("首次: code=%d out=%v", code, out)
	}
	second := containerSubmitBody(t, testSeed, "course", "course/c9", "甲课改", []submitSegment{
		{Seq: -1, Kind: "attr.instructor", Text: "李老师"},
	})
	code, out := postSubmit(t, n, testSeed, second)
	if code != http.StatusOK || out["created"] != false {
		t.Fatalf("重投: code=%d out=%v", code, out)
	}
	segs, _ := n.st.ListSegments("course/c9")
	if len(segs) != 1 || segs[0].Seq != -1 || segs[0].Kind != "attr.instructor" {
		t.Fatalf("重投未整体替换: %+v", segs)
	}
}

func TestSubmitRejectsBadContainerSegments(t *testing.T) {
	n := newSubmitNode(t)
	cases := []struct {
		name, typ, itemID string
		segs              []submitSegment
		want              string
	}{
		{"形态不识别", "course", "course/c1/lesson/l1/quiz/q1", nil, "item_id_invalid"},
		{"形态与 type 不符", "course", "course/c1/lesson/l1", nil, "item_type_mismatch"},
		{"seq<0 非 attr.*", "course", "course/c1", []submitSegment{{Seq: -1, Kind: "cover", Text: "x"}}, "item_segments_invalid"},
		{"属性行非规范排布", "course", "course/c1", []submitSegment{
			{Seq: -1, Kind: "attr.instructor", Text: "甲"},
			{Seq: -2, Kind: "attr.cover", Text: "00112233445566778899aabbccddeeff"},
		}, "item_segments_invalid"},
		{"seq=0 非 digest", "course", "course/c1", []submitSegment{{Seq: 0, Kind: "intro", Text: "x"}}, "item_segments_invalid"},
		{"seq 重复", "course", "course/c1", []submitSegment{
			{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
			{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l2"},
		}, "item_segments_invalid"},
		{"课程不许挂 article 子项", "course", "course/c1", []submitSegment{
			{Seq: 1, Kind: "article", Text: "article/a1"},
		}, "item_segments_invalid"},
		{"课时不许挂 lesson 子项", "lesson", "course/c1/lesson/l1", []submitSegment{
			{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l2"},
		}, "item_segments_invalid"},
	}
	for _, c := range cases {
		body := containerSubmitBody(t, testSeed, c.typ, c.itemID, "标题", c.segs)
		code, out := postSubmit(t, n, testSeed, body)
		if code != http.StatusBadRequest || out["code"] != c.want {
			t.Fatalf("%s: want %s, got code=%d out=%v", c.name, c.want, code, out)
		}
		if _, ok, _ := n.st.GetItem(c.itemID); ok {
			t.Fatalf("%s: 拒绝时不得写入", c.name)
		}
	}
}

// 他人（含空归属的存量容器）已占用 → 403 item_id_taken，且不得写入。
func TestSubmitContainerTaken(t *testing.T) {
	n := newSubmitNode(t)
	legacy := []store.Segment{{ItemID: "course/c2", Seq: 1, Kind: "lesson", Text: "course/c2/lesson/l1"}}
	if err := n.st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "course/c2", Source: "course", Type: "course", Title: "存量", Segments: legacy,
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}
	body := containerSubmitBody(t, testSeed, "course", "course/c2", "认领", []submitSegment{
		{Seq: 1, Kind: "lesson", Text: "course/c2/lesson/l9"},
	})
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusForbidden || out["code"] != "item_id_taken" {
		t.Fatalf("code=%d out=%v", code, out)
	}
	segs, _ := n.st.ListSegments("course/c2")
	if len(segs) != 1 || segs[0].Text != "course/c2/lesson/l1" {
		t.Fatalf("拒绝时不得写入: %+v", segs)
	}
}

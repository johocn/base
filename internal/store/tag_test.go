package store

import (
	"errors"
	"reflect"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

// 测试内辅助（不在生产代码里新增测试专用导出）：
// newTestStore 复用同包既有开库辅助 openTemp（store_test.go），
// putItemForTest / putEventForTest 直接用 s.db.Exec 造 items / events 行，列名以 schema.go 的 DDL 为准。
func newTestStore(t *testing.T) *Store {
	t.Helper()
	return openTemp(t)
}

func (s *Store) putItemForTest(itemID, typ string) error {
	_, err := s.db.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO NOTHING`,
		itemID, typ, typ, itemID, "", protocol.SHA256Hex([]byte(itemID)), "segments", "public", "active", nowUTC(), "", "")
	return err
}

func (s *Store) putEventForTest(eventID, typ string) error {
	_, err := s.db.Exec(`INSERT INTO events(event_id,id,type,body_json,created_at,received_at) VALUES(?,?,?,?,?,?)`,
		eventID, eventID, typ, "{}", 0, 0)
	return err
}

func tagLinksOf(t *testing.T, s *Store, tagID string) []TagLink {
	t.Helper()
	got, err := s.ListTagLinks(tagID)
	if err != nil {
		t.Fatalf("ListTagLinks: %v", err)
	}
	return got
}

func TestTagMaterializeOrderAndHash(t *testing.T) {
	links := []TagLink{
		{"tag/甲/一/一", "comment/0123456789abcdef0123456789abcdef", "comment"},
		{"tag/甲/一/一", "article/a2", "article"},
		{"tag/甲/一/一", "course/c9", "course"},
		{"tag/甲/一/一", "course/c1", "course"},
		{"tag/甲/一/一", "course/c1/lesson/l1", "lesson"},
	}
	segs := MaterializeTagSegments("tag/甲/一/一", links)
	want := []Segment{
		{ItemID: "tag/甲/一/一", Seq: 1, Kind: "course", Text: "course/c1"},
		{ItemID: "tag/甲/一/一", Seq: 2, Kind: "course", Text: "course/c9"},
		{ItemID: "tag/甲/一/一", Seq: 3, Kind: "lesson", Text: "course/c1/lesson/l1"},
		{ItemID: "tag/甲/一/一", Seq: 4, Kind: "article", Text: "article/a2"},
		{ItemID: "tag/甲/一/一", Seq: 5, Kind: "comment", Text: "comment/0123456789abcdef0123456789abcdef"},
	}
	if len(segs) != len(want) {
		t.Fatalf("行数 = %d, want %d", len(segs), len(want))
	}
	for i := range want {
		if segs[i].Seq != want[i].Seq || segs[i].Kind != want[i].Kind || segs[i].Text != want[i].Text {
			t.Errorf("行 %d = %+v, want %+v", i, segs[i], want[i])
		}
	}
	// 唯一性锚点：同一份输入（顺序打乱）必须得同一个 content_hash。
	shuffled := []TagLink{links[2], links[4], links[0], links[3], links[1]}
	if SegmentsContentHash(MaterializeTagSegments("tag/甲/一/一", shuffled)) != SegmentsContentHash(segs) {
		t.Fatal("乱序输入应得同一 content_hash")
	}
}

func TestUpsertTagSubmissionDirectWrite(t *testing.T) {
	s := newTestStore(t)
	if err := s.putItemForTest("course/c1", "course"); err != nil {
		t.Fatal(err)
	}
	created, err := s.UpsertTagSubmission(TagSubmission{
		TagID: "tag/甲/一/一", Title: "甲 · 一 · 一",
		Links:    []TagLink{{TagID: "tag/甲/一/一", TargetID: "course/c1", Kind: "course"}},
		AuthorID: "aa", AuthorSig: "sig",
	})
	if err != nil || !created {
		t.Fatalf("首次直打 created=%v err=%v", created, err)
	}
	if got := tagLinksOf(t, s, "tag/甲/一/一"); !reflect.DeepEqual(got, []TagLink{{"tag/甲/一/一", "course/c1", "course"}}) {
		t.Fatalf("tag_links = %+v", got)
	}
	segs, err := s.ListSegments("tag/甲/一/一")
	if err != nil || len(segs) != 1 || segs[0].Text != "course/c1" || segs[0].Kind != "course" {
		t.Fatalf("物化 segments = %+v err=%v", segs, err)
	}
	it, ok, err := s.GetItem("tag/甲/一/一")
	if err != nil || !ok {
		t.Fatalf("条目未建 ok=%v err=%v", ok, err)
	}
	if it.Source != "tag" || it.Type != "tag" || it.SQLiteTable != "segments" || it.AuthorID != "aa" {
		t.Fatalf("条目列 = %+v", it)
	}
	if it.ContentHash != SegmentsContentHash(segs) {
		t.Fatalf("content_hash 与容器口径不一致: %s", it.ContentHash)
	}

	// 幂等：同输入再提交仍是 1 行
	if _, err := s.UpsertTagSubmission(TagSubmission{
		TagID: "tag/甲/一/一", Title: "甲 · 一 · 一",
		Links:    []TagLink{{TagID: "tag/甲/一/一", TargetID: "course/c1", Kind: "course"}},
		AuthorID: "aa", AuthorSig: "sig2",
	}); err != nil {
		t.Fatalf("幂等重提交失败: %v", err)
	}
	if got := tagLinksOf(t, s, "tag/甲/一/一"); len(got) != 1 {
		t.Fatalf("幂等后 tag_links = %+v", got)
	}
}

func TestUpsertTagSubmissionRejectsTaggedTarget(t *testing.T) {
	s := newTestStore(t)
	if err := s.putItemForTest("course/c1", "course"); err != nil {
		t.Fatal(err)
	}
	if err := s.putItemForTest("course/c2", "course"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertTagSubmission(TagSubmission{
		TagID: "tag/甲/一/一", Title: "甲 · 一 · 一",
		Links:    []TagLink{{TagID: "tag/甲/一/一", TargetID: "course/c1", Kind: "course"}},
		AuthorID: "aa",
	}); err != nil {
		t.Fatal(err)
	}
	// c1 已有标签、c2 没有 → **整体拒绝**，不部分生效，也不新建条目
	_, err := s.UpsertTagSubmission(TagSubmission{
		TagID: "tag/乙/一/一", Title: "乙 · 一 · 一",
		Links: []TagLink{
			{TagID: "tag/乙/一/一", TargetID: "course/c2", Kind: "course"},
			{TagID: "tag/乙/一/一", TargetID: "course/c1", Kind: "course"},
		},
		AuthorID: "aa",
	})
	if !errors.Is(err, ErrTagTargetTagged) {
		t.Fatalf("err = %v, want ErrTagTargetTagged", err)
	}
	if _, ok, _ := s.GetItem("tag/乙/一/一"); ok {
		t.Fatal("被拒时不得建条目")
	}
	if got := tagLinksOf(t, s, "tag/乙/一/一"); len(got) != 0 {
		t.Fatalf("被拒时不得写关联: %+v", got)
	}
}

func TestUpsertTagSubmissionOccupied(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.UpsertTagSubmission(TagSubmission{
		TagID: "tag/甲/一/一", Title: "甲 · 一 · 一", AuthorID: "aa",
	}); err != nil {
		t.Fatal(err)
	}
	_, err := s.UpsertTagSubmission(TagSubmission{TagID: "tag/甲/一/一", Title: "甲 · 一 · 一", AuthorID: "bb"})
	if !errors.Is(err, ErrItemTaken) {
		t.Fatalf("err = %v, want ErrItemTaken", err)
	}
}

func TestListTagsOf(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.UpsertTagSubmission(TagSubmission{
		TagID: "tag/甲/一/一", Title: "x", Links: []TagLink{{TagID: "tag/甲/一/一", TargetID: "course/c1", Kind: "course"}}, AuthorID: "aa",
	}); err != nil {
		t.Fatal(err)
	}
	// 第二条关联不是直打（§3.4 会拒），这里直接造行：改标提案生效路径落 Task 6，
	// 本条用例只覆盖反查的排序与扫描。
	if _, err := s.db.Exec(`INSERT INTO tag_links(tag_id,target_id,kind,created_at) VALUES(?,?,?,?)`,
		"tag/乙/一/一", "course/c1", "course", nowUTC()); err != nil {
		t.Fatal(err)
	}
	got, err := s.ListTagsOf("course/c1")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"tag/乙/一/一", "tag/甲/一/一"}) {
		t.Fatalf("ListTagsOf = %v", got)
	}
}

func TestHasCommentEvent(t *testing.T) {
	s := newTestStore(t)
	if err := s.putEventForTest("e1", "comment.v1"); err != nil {
		t.Fatal(err)
	}
	if err := s.putEventForTest("e2", "group.v1"); err != nil {
		t.Fatal(err)
	}
	ok, err := s.HasCommentEvent("e1")
	if err != nil || !ok {
		t.Fatalf("e1 ok=%v err=%v", ok, err)
	}
	ok, err = s.HasCommentEvent("e2")
	if err != nil || ok {
		t.Fatalf("e2（group.v1）必须为 false: ok=%v err=%v", ok, err)
	}
	ok, err = s.HasCommentEvent("nope")
	if err != nil || ok {
		t.Fatalf("不存在必须为 false: ok=%v err=%v", ok, err)
	}
}

func TestMaterializeDropsDuplicateTargets(t *testing.T) {
	segs := MaterializeTagSegments("tag/甲/一/一", []TagLink{
		{"tag/甲/一/一", "course/c1", "course"},
		{"tag/甲/一/一", "course/c1", "lesson"},
	})
	if len(segs) != 1 {
		t.Fatalf("同 target_id 去重后应为 1 行，得 %d 行", len(segs))
	}
}

func TestTagItemIDUsesProtocol(t *testing.T) {
	// 契约口径由 protocol 单一来源提供，store 不得另立编码
	id, ok := protocol.TagItemID("甲", "一", "一")
	if !ok || id != "tag/甲/一/一" {
		t.Fatalf("protocol.TagItemID = %q %v", id, ok)
	}
}

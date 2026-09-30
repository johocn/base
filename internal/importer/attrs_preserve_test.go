package importer

import (
	"strings"
	"testing"

	"github.com/johocn/base/internal/store"
)

func openImporterStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir(), store.WithStoreKey("9f2c1d4a7b3e5081f6a9c2d5e8b10432a7c9e6b3d0f84261c5a8e2b7d4f01963"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// 重建课程容器时必须原样保留既有的 seq<0 属性行（本册 §2.2）。
func TestRebuildContainerPreservesAttrs(t *testing.T) {
	st := openImporterStore(t)
	first := []store.Segment{
		{ItemID: "course/c1", Seq: -1, Kind: "attr.cover", Text: "00112233445566778899aabbccddeeff"},
		{ItemID: "course/c1", Seq: -2, Kind: "attr.instructor", Text: "李老师"},
		{ItemID: "course/c1", Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
	}
	if err := st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "course/c1", Source: "course", Type: "course", Title: "甲课", Segments: first,
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}
	// 导入器再重建一次（新增一个课时）：属性行与封面必须留着。
	if err := rebuildContainer(st, "course/c1", "course", "course", "甲课", "新简介", []string{"course/c1/lesson/l2"}); err != nil {
		t.Fatalf("rebuildContainer: %v", err)
	}
	segs, err := st.ListSegments("course/c1")
	if err != nil {
		t.Fatalf("ListSegments: %v", err)
	}
	attrs := attrSegsOf(segs)
	if len(attrs) != 2 || attrs[0].Seq != -2 || attrs[1].Seq != -1 {
		t.Fatalf("属性行未保留: %+v", attrs)
	}
	if segs[0].Kind != "attr.instructor" || segs[1].Kind != "attr.cover" {
		t.Fatalf("属性行未按 seq 排在最前: %+v", segs)
	}
	if digestTextOf(segs) != "新简介" {
		t.Fatalf("简介未更新: %+v", segs)
	}
	// 合并式重建：既有的 l1 与新增的 l2 都在。
	kids := childIDsOf(segs)
	if len(kids) != 2 || !strings.Contains(strings.Join(kids, ","), "l1") || !strings.Contains(strings.Join(kids, ","), "l2") {
		t.Fatalf("子项合并不对: %+v", kids)
	}
}

// 标签关联全量替换后，seq<=0 的行必须留下（本册 §2.2 的第四处重建）。
func TestReplaceTagLinksKeepsNonChildRows(t *testing.T) {
	st := openImporterStore(t)
	// 先由标签投稿建条目（占住 author_id=aa），UpsertSegmentItem 的 ON CONFLICT 不写 author_id，
	// 故随后补写 segments 不会改动归属。
	if _, err := st.UpsertTagSubmission(store.TagSubmission{
		TagID: "tag/t1", Title: "t1", AuthorID: "aa", AuthorSig: "ff",
	}); err != nil {
		t.Fatalf("UpsertTagSubmission(建条目): %v", err)
	}
	if err := st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "tag/t1", Source: "tag", Type: "tag", Title: "t1",
		Segments: []store.Segment{
			{ItemID: "tag/t1", Seq: 0, Kind: "digest", Text: "标签简介"},
			{ItemID: "tag/t1", Seq: 1, Kind: "article", Text: "article/a1"},
		},
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}
	if _, err := st.UpsertTagSubmission(store.TagSubmission{
		TagID: "tag/t1", Title: "t1",
		Links:    []store.TagLink{{TargetID: "article/a2", Kind: "article"}},
		AuthorID: "aa", AuthorSig: "ff",
	}); err != nil {
		t.Fatalf("UpsertTagSubmission: %v", err)
	}
	segs, _ := st.ListSegments("tag/t1")
	if digestTextOf(segs) != "标签简介" {
		t.Fatalf("seq=0 行被误删: %+v", segs)
	}
	kids := childIDsOf(segs)
	if len(kids) != 1 || kids[0] != "article/a2" {
		t.Fatalf("子项未整体替换: %+v", kids)
	}
}

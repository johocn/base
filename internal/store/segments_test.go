package store

import (
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestSegmentsRoundTripAndHash(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	segs := []Segment{
		{Seq: 0, Kind: "digest", Text: "从哈希寻址讲到 Merkle 清单"},
		{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
		{Seq: 2, Kind: "lesson", Text: "course/c1/lesson/l2"},
	}
	if err := st.UpsertSegmentItem(SegmentItem{
		ItemID: "course/c1", Source: "course", Type: "course", Title: "内容寻址入门", Segments: segs,
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}

	got, err := st.ListSegments("course/c1")
	if err != nil || len(got) != 3 {
		t.Fatalf("ListSegments = %d 行, err=%v", len(got), err)
	}
	for i, s := range got {
		if s.Seq != i {
			t.Fatalf("第 %d 行 seq = %d（必须按 seq 升序读回）", i, s.Seq)
		}
		if s.ContentHash != protocol.SHA256Hex([]byte(s.Text)) {
			t.Fatalf("行级 hash 口径不符: %+v", s)
		}
	}
	it, ok, _ := st.GetItem("course/c1")
	if !ok || it.SQLiteTable != "segments" || it.Source != "course" || it.Type != "course" {
		t.Fatalf("条目行异常: %+v ok=%v", it, ok)
	}
	if it.ContentHash != SegmentsContentHash(segs) {
		t.Fatalf("条目级 hash 口径不符: %s != %s", it.ContentHash, SegmentsContentHash(segs))
	}

	// 幂等重写：同 item_id 再写一次，行数不叠加、顺序不漂移
	if err := st.UpsertSegmentItem(SegmentItem{
		ItemID: "course/c1", Source: "course", Type: "course", Title: "改了标题", Segments: segs[:2],
	}); err != nil {
		t.Fatal(err)
	}
	got2, _ := st.ListSegments("course/c1")
	if len(got2) != 2 {
		t.Fatalf("重写后行数 = %d, want 2（先删同 item_id 旧行）", len(got2))
	}
}

func TestSegmentsContentHashIsStable(t *testing.T) {
	segs := []Segment{{Seq: 0, Kind: "digest", Text: "简介"}, {Seq: 1, Kind: "video", Text: "course/c/lesson/l/video/v"}}
	if SegmentsContentHash(segs) != SegmentsContentHash(append([]Segment{}, segs...)) {
		t.Fatal("同一份 segments 的条目级 hash 必须相等")
	}
	// 口径写死：按 seq 升序拼接 "<kind>\t<text>\n"
	want := protocol.SHA256Hex([]byte("digest\t简介\nvideo\tcourse/c/lesson/l/video/v\n"))
	if SegmentsContentHash(segs) != want {
		t.Fatalf("拼接口径不符: %s != %s", SegmentsContentHash(segs), want)
	}
}

func TestRetireItemAndNextContentVersion(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if v, err := st.BumpContentVersion(); err != nil || v != 1 {
		t.Fatalf("BumpContentVersion = %d, err=%v", v, err)
	}
	next, err := st.NextContentVersion()
	if err != nil || next != 2 {
		t.Fatalf("NextContentVersion = %d, err=%v（只读，不递增）", next, err)
	}
	if again, _ := st.NextContentVersion(); again != 2 {
		t.Fatalf("NextContentVersion 不得改变计数器: %d", again)
	}

	if err := st.UpsertArticle(Article{ItemID: "article:old", Title: "旧", BodyMD: "旧正文",
		ContentHash: protocol.SHA256Hex([]byte("旧正文")), SourceRev: "r"}); err != nil {
		t.Fatal(err)
	}
	if err := st.RetireItem("article:old", next); err != nil {
		t.Fatalf("RetireItem: %v", err)
	}
	it, ok, _ := st.GetItem("article:old")
	if !ok || it.State != "removed" {
		t.Fatalf("退役后 state 应为 removed: %+v ok=%v", it, ok)
	}
	active, _ := st.ListItems("active")
	if len(active) != 0 {
		t.Fatalf("退役条目不应出现在 active 列表: %+v", active)
	}
	ts, _ := st.ListTombstones()
	if len(ts) != 1 || ts[0].ItemID != "article:old" || ts[0].RevokedRev != 2 {
		t.Fatalf("墓碑异常: %+v", ts)
	}
}
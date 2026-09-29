package store

import (
	"fmt"
	"testing"
)

// dmEventHex 造一个 16 字节（32 hex）的事件 id，形状与契约一致。
func dmEventHex(n int) string { return fmt.Sprintf("%032x", n) }

// 验收 4 的数据层：按收件人分页读 dm.v1——只认本收件人、只认 dm.v1、倒序 + 复合游标。
func TestListDMEventsFilterAndCursor(t *testing.T) {
	st := openTemp(t)
	put := func(eventID, typ, target string, createdAt int64) {
		t.Helper()
		if err := st.PutEvent(Event{
			EventID: eventID, ID: "actor-" + eventID, Type: typ, BodyJSON: `{}`,
			CreatedAt: createdAt, TargetID: target, PayloadCID: "cid-" + eventID,
		}); err != nil {
			t.Fatalf("PutEvent %s: %v", eventID, err)
		}
	}
	const (
		peer  = "000000000000000000000000000000aa"
		other = "000000000000000000000000000000bb"
	)
	// 同一收件人三条（时间递增）+ 别人的一条 + 另一类型的同 target 一条
	put(dmEventHex(1), "dm.v1", "dm/"+peer, 100)
	put(dmEventHex(2), "dm.v1", "dm/"+peer, 200)
	put(dmEventHex(3), "dm.v1", "dm/"+peer, 300)
	put(dmEventHex(4), "dm.v1", "dm/"+other, 400)
	put(dmEventHex(5), "dm.v1", "dm/"+peer, 500)
	put(dmEventHex(6), "group.v1", "dm/"+peer, 600)

	// 第一页：limit=2 → 最新的两条（500 / 300），由新到旧
	page1, err := st.ListDMEvents(peer, 0, "", 2)
	if err != nil {
		t.Fatalf("ListDMEvents page1: %v", err)
	}
	if len(page1) != 2 || page1[0].EventID != dmEventHex(5) || page1[1].EventID != dmEventHex(3) {
		t.Fatalf("第一页不符: %+v", page1)
	}
	if page1[0].TargetID != "dm/"+peer || page1[0].PayloadCID != "cid-"+dmEventHex(5) {
		t.Fatalf("投影列不符: %+v", page1[0])
	}

	// 第二页：用 (created_at, event_id) 复合游标继续
	page2, err := st.ListDMEvents(peer, page1[1].CreatedAt, page1[1].EventID, 2)
	if err != nil {
		t.Fatalf("ListDMEvents page2: %v", err)
	}
	if len(page2) != 2 || page2[0].EventID != dmEventHex(2) || page2[1].EventID != dmEventHex(1) {
		t.Fatalf("第二页不符: %+v", page2)
	}

	// 别人的私信与别的类型的事件都不许串进来
	for _, e := range append(page1, page2...) {
		if e.EventID == dmEventHex(4) || e.EventID == dmEventHex(6) {
			t.Fatalf("串了别的收件人或别的类型: %+v", e)
		}
	}
}

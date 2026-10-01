package store

import (
	"reflect"
	"testing"
)

func TestPutProgressProjectionFirstWriteAndCheckin(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	if err := st.PutProgressProjection(ProgressEvent{
		ID: "actor1", ItemID: "article/a", Position: 640, Done: false,
		Day: "2026-10-01", CreatedAt: 100, EventID: "ev1",
	}); err != nil {
		t.Fatalf("PutProgressProjection: %v", err)
	}

	rows, err := st.ListProgressByID("actor1")
	if err != nil || len(rows) != 1 {
		t.Fatalf("progress 行数 err=%v rows=%+v", err, rows)
	}
	want := ProgressRow{ItemID: "article/a", Position: 640, Done: false, Day: "2026-10-01", UpdatedAt: 100, EventID: "ev1"}
	if !reflect.DeepEqual(rows[0], want) {
		t.Fatalf("progress 行: got=%+v want=%+v", rows[0], want)
	}

	days, err := st.CheckinDaysOf("actor1")
	if err != nil || len(days) != 1 {
		t.Fatalf("checkin 行数 err=%v days=%+v", err, days)
	}
	if days[0].Day != "2026-10-01" || days[0].FirstEventID != "ev1" || days[0].CreatedAt != 100 {
		t.Fatalf("checkin 行: %+v", days[0])
	}
}

// LWW（#8 册子 §3.4）：created_at 降序、平局取 event_id 升序，首条即胜者。
func TestPutProgressProjectionLWW(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	seed := func(createdAt int64, eventID string, position int64) {
		t.Helper()
		if err := st.PutProgressProjection(ProgressEvent{
			ID: "actor1", ItemID: "article/a", Position: position, Done: false,
			Day: "2026-10-01", CreatedAt: createdAt, EventID: eventID,
		}); err != nil {
			t.Fatalf("PutProgressProjection(%s): %v", eventID, err)
		}
	}

	// 更晚的 created_at 胜
	seed(100, "ev1", 100)
	seed(200, "ev2", 200)
	rows, _ := st.ListProgressByID("actor1")
	if rows[0].Position != 200 || rows[0].EventID != "ev2" || rows[0].UpdatedAt != 200 {
		t.Fatalf("更晚者未胜: %+v", rows[0])
	}
	// 更早的 created_at 不覆盖（即使后到达）
	seed(150, "ev3", 300)
	rows, _ = st.ListProgressByID("actor1")
	if rows[0].Position != 200 || rows[0].EventID != "ev2" {
		t.Fatalf("更早者不应覆盖: %+v", rows[0])
	}
	// 平局取 event_id 升序（更小者胜）
	seed(200, "ev0", 999)
	rows, _ = st.ListProgressByID("actor1")
	if rows[0].EventID != "ev0" || rows[0].Position != 999 {
		t.Fatalf("平局应取 event_id 升序更小者: %+v", rows[0])
	}
	// 平局取 event_id 升序（更大者不覆盖）
	seed(200, "ev9", 777)
	rows, _ = st.ListProgressByID("actor1")
	if rows[0].EventID != "ev0" {
		t.Fatalf("平局更大者不应覆盖: %+v", rows[0])
	}
}

// 同 event_id 重放必须幂等（反熵每轮会重拉同一事件）。
func TestPutProgressProjectionReplayIsIdempotent(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	e := ProgressEvent{
		ID: "actor1", ItemID: "article/a", Position: 500, Done: false,
		Day: "2026-10-01", CreatedAt: 100, EventID: "ev1",
	}
	for i := 0; i < 3; i++ {
		if err := st.PutProgressProjection(e); err != nil {
			t.Fatalf("第 %d 次 PutProgressProjection: %v", i+1, err)
		}
	}
	rows, _ := st.ListProgressByID("actor1")
	if len(rows) != 1 || rows[0].Position != 500 {
		t.Fatalf("重放不得产生第二行 / 不得改值: %+v", rows)
	}
	days, _ := st.CheckinDaysOf("actor1")
	if len(days) != 1 || days[0].FirstEventID != "ev1" {
		t.Fatalf("checkin 重放应保持 1 行且首次值不变: %+v", days)
	}
}

// 打卡日是 insert-or-ignore 的只增集合（#8 册子 §3.5）：
// 同一天的第二条事件（哪怕 LWW 更晚）不得改写 first_event_id。
func TestCheckinDaysKeepsFirstEvent(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	if err := st.PutProgressProjection(ProgressEvent{
		ID: "actor1", ItemID: "article/a", Position: 100, Done: false,
		Day: "2026-10-01", CreatedAt: 100, EventID: "ev1",
	}); err != nil {
		t.Fatalf("首次: %v", err)
	}
	if err := st.PutProgressProjection(ProgressEvent{
		ID: "actor1", ItemID: "article/b", Position: 200, Done: false,
		Day: "2026-10-01", CreatedAt: 999, EventID: "ev2",
	}); err != nil {
		t.Fatalf("同日第二条: %v", err)
	}

	days, err := st.CheckinDaysOf("actor1")
	if err != nil || len(days) != 1 {
		t.Fatalf("同日应只 1 行 err=%v days=%+v", err, days)
	}
	if days[0].FirstEventID != "ev1" || days[0].CreatedAt != 100 {
		t.Fatalf("打卡日应保留首次: %+v", days[0])
	}
	// 但 progress 是**两个不同条目的两个寄存器**，都应各留一行。
	rows, _ := st.ListProgressByID("actor1")
	if len(rows) != 2 || rows[0].ItemID != "article/a" || rows[1].ItemID != "article/b" {
		t.Fatalf("两个 item_id 应各一行: %+v", rows)
	}
}
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

// §3.5 核心：打卡日是**独立**的只增集合，不能从折叠后的 progress 表派生。
// 一条输掉 LWW（created_at 更早）的事件不得改写 progress 寄存器，
// 但它携带的 day 仍必须被记进 checkin_days——否则该条目历史上的打卡日会被冲掉。
func TestCheckinDaysRecordsLoserEventDay(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	const (
		tLate  = int64(200)
		tEarly = int64(100)
	)
	// 先投 LWW 胜者：更晚的 created_at。
	if err := st.PutProgressProjection(ProgressEvent{
		ID: "actor1", ItemID: "article/a", Position: 100, Done: false,
		Day: "2026-10-01", CreatedAt: tLate, EventID: "ev9",
	}); err != nil {
		t.Fatalf("胜者: %v", err)
	}
	// 再投同一 (id,item_id) 但更早、day 不同的事件：它输掉 LWW，day 仍须被记下。
	if err := st.PutProgressProjection(ProgressEvent{
		ID: "actor1", ItemID: "article/a", Position: 999, Done: true,
		Day: "2026-09-30", CreatedAt: tEarly, EventID: "ev1",
	}); err != nil {
		t.Fatalf("败者: %v", err)
	}

	// ① progress 仍是第一条（LWW 胜者未变）。
	rows, err := st.ListProgressByID("actor1")
	if err != nil || len(rows) != 1 {
		t.Fatalf("progress 行数 err=%v rows=%+v", err, rows)
	}
	if rows[0].Position != 100 || rows[0].Day != "2026-10-01" || rows[0].UpdatedAt != tLate || rows[0].EventID != "ev9" {
		t.Fatalf("LWW 胜者被败者覆盖: %+v", rows[0])
	}

	// ② checkin_days 同时存在 D1(2026-10-01) 与 D2(2026-09-30)——D2 虽输 LWW 仍被记下。
	days, err := st.CheckinDaysOf("actor1")
	if err != nil || len(days) != 2 {
		t.Fatalf("应记下两个打卡日 err=%v days=%+v", err, days)
	}
	if days[0].Day != "2026-09-30" || days[0].FirstEventID != "ev1" {
		t.Fatalf("D2 应被记下: %+v", days[0])
	}
	if days[1].Day != "2026-10-01" || days[1].FirstEventID != "ev9" {
		t.Fatalf("D1 应被记下: %+v", days[1])
	}

	// ③ 重放败者事件幂等：寄存器不变、D2 的 first_event_id 保持不变。
	if err := st.PutProgressProjection(ProgressEvent{
		ID: "actor1", ItemID: "article/a", Position: 999, Done: true,
		Day: "2026-09-30", CreatedAt: tEarly, EventID: "ev1",
	}); err != nil {
		t.Fatalf("重放: %v", err)
	}
	rows, _ = st.ListProgressByID("actor1")
	if len(rows) != 1 || rows[0].EventID != "ev9" {
		t.Fatalf("重放不应改变寄存器: %+v", rows)
	}
	days, _ = st.CheckinDaysOf("actor1")
	if len(days) != 2 || days[0].Day != "2026-09-30" || days[0].FirstEventID != "ev1" {
		t.Fatalf("重放不应改变打卡日: %+v", days)
	}
}

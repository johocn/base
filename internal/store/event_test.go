package store

import "testing"

func TestEventPutIsIdempotentAndListed(t *testing.T) {
	st := openTemp(t)
	e := Event{EventID: "e1", ID: "id-1", Type: "progress.v1", BodyJSON: `{"a":1}`, CreatedAt: 100, ReceivedAt: 200}
	if err := st.PutEvent(e); err != nil {
		t.Fatalf("PutEvent: %v", err)
	}
	e.BodyJSON = `{"a":2}`
	e.CreatedAt = 300
	if err := st.PutEvent(e); err != nil {
		t.Fatalf("PutEvent(覆盖): %v", err)
	}
	if err := st.PutEvent(Event{EventID: "e2", ID: "id-1", Type: "progress.v1", BodyJSON: `{}`, CreatedAt: 400}); err != nil {
		t.Fatalf("PutEvent(e2): %v", err)
	}

	evs, err := st.ListEvents("id-1", 10)
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if len(evs) != 2 {
		t.Fatalf("事件数 = %d, want 2（同 event_id 幂等）", len(evs))
	}
	if evs[0].EventID != "e2" || evs[1].EventID != "e1" {
		t.Fatalf("排序应为 created_at 倒序: %+v", evs)
	}
	if evs[1].BodyJSON != `{"a":2}` || evs[1].CreatedAt != 300 {
		t.Fatalf("覆盖未生效: %+v", evs[1])
	}
	if evs[1].ReceivedAt != 200 {
		t.Fatalf("ReceivedAt 不应被覆盖: %+v", evs[1])
	}

	empty, err := st.ListEvents("nobody", 10)
	if err != nil || len(empty) != 0 {
		t.Fatalf("无事件应返回空切片 err=%v evs=%+v", err, empty)
	}
}

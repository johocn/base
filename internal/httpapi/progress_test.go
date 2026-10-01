package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
)

// progressEventBody 造一条 progress.v1 事件体，并按 §3.4 签内容签名
// canonical({event_id,type,created_at,body})——与节点侧重建的待验字节同口径。
func progressEventBody(t *testing.T, seed, eventID, itemID string, position int64, done bool, day string) string {
	t.Helper()
	body := map[string]any{"item_id": itemID, "position": position, "done": done, "day": day}
	payload := map[string]any{
		"event_id": eventID, "type": "progress.v1",
		"created_at": time.Now().UnixMilli(), "body": body,
	}
	canon, err := protocol.Canonicalize(payload)
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	sig, err := protocol.Sign(seed, canon)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	payload["sig"] = sig
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(raw)
}

func TestProgressEventPersistsBothProjections(t *testing.T) {
	st, _, ts := newFullServer(t)
	id, _ := identityFromSeed(t, testSeed)

	body := progressEventBody(t, testSeed, strings.Repeat("1", 32), "article/hello-world", 640, false, "2026-10-01")
	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", body))
	if status != http.StatusOK {
		t.Fatalf("发进度 status=%d out=%v", status, out)
	}

	rows, err := st.ListProgressByID(id)
	if err != nil || len(rows) != 1 {
		t.Fatalf("progress 投影 err=%v rows=%+v", err, rows)
	}
	if rows[0].ItemID != "article/hello-world" || rows[0].Position != 640 || rows[0].Done {
		t.Fatalf("progress 投影不符: %+v", rows[0])
	}
	if rows[0].Day != "2026-10-01" || rows[0].EventID != strings.Repeat("1", 32) {
		t.Fatalf("progress 的 day/event_id 不符: %+v", rows[0])
	}
	days, err := st.CheckinDaysOf(id)
	if err != nil || len(days) != 1 || days[0].Day != "2026-10-01" {
		t.Fatalf("checkin 投影 err=%v days=%+v", err, days)
	}

	// 事件行必须存**客户端原始键集**（不是减化形态）：反熵侧要据它重投影。
	evs, err := st.ListEvents(id, 10)
	if err != nil || len(evs) != 1 {
		t.Fatalf("事件行 err=%v evs=%+v", err, evs)
	}
	if evs[0].Type != "progress.v1" || evs[0].TargetID != "article/hello-world" {
		t.Fatalf("事件行不符: %+v", evs[0])
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(evs[0].BodyJSON), &m); err != nil {
		t.Fatalf("body_json 不是对象: %s", evs[0].BodyJSON)
	}
	for _, k := range []string{"item_id", "position", "done", "day"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("body_json 丢键 %q: %s", k, evs[0].BodyJSON)
		}
	}
}

func TestProgressEventRejectsBadBody(t *testing.T) {
	_, _, ts := newFullServer(t)

	cases := []struct {
		name    string
		rawBody string
	}{
		{"day 形态非法", `{"item_id":"article/a","position":1,"done":false,"day":"2026/10/01"}`},
		{"position 为负", `{"item_id":"article/a","position":-1,"done":false,"day":"2026-10-01"}`},
		{"position 非整数", `{"item_id":"article/a","position":"1","done":false,"day":"2026-10-01"}`},
		{"done 非布尔", `{"item_id":"article/a","position":1,"done":"false","day":"2026-10-01"}`},
		{"item_id 为空", `{"item_id":"","position":1,"done":false,"day":"2026-10-01"}`},
		{"item_id 超 256 字节", `{"item_id":"` + strings.Repeat("a", 257) + `","position":1,"done":false,"day":"2026-10-01"}`},
		{"item_id 非 ASCII", `{"item_id":"文章/a","position":1,"done":false,"day":"2026-10-01"}`},
		{"多一个未知键", `{"item_id":"article/a","position":1,"done":false,"day":"2026-10-01","x":1}`},
		{"缺 day", `{"item_id":"article/a","position":1,"done":false}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// 校验在验签**之前**发生，故这里不需要合法签名：非法 body 必须 400 event_param_invalid。
			body := `{"event_id":"` + strings.Repeat("2", 32) + `","type":"progress.v1","created_at":1,"body":` + c.rawBody + `,"sig":"` + strings.Repeat("ab", 64) + `"}`
			status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", body))
			if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
				t.Fatalf("status=%d out=%v, want 400/event_param_invalid", status, out)
			}
		})
	}
}

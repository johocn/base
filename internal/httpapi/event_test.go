package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// newFullServer 用真实 srv.Handler()，因此同时覆盖「路由是否挂上」。
func newFullServer(t *testing.T) (*store.Store, *Server, *inprocServer) {
	t.Helper()
	st, err := store.Open(t.TempDir(), store.WithStoreKey(identityTestStoreKey))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	srv, err := New(st, Options{Issuer: "base-node-1", SignKeyHex: testSeed, Version: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := newInprocServer(srv.Handler())
	t.Cleanup(ts.Close)

	id, pub := identityFromSeed(t, testSeed)
	if status, body := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(id, pub)); status != http.StatusOK {
		t.Fatalf("预登记 status=%d body=%v", status, body)
	}
	return st, srv, ts
}

func TestRoutesAreWiredOnRealHandler(t *testing.T) {
	_, _, ts := newFullServer(t)
	id, _ := identityFromSeed(t, testSeed)

	status, body := sendAuth(t, signedRequest(t, testSeed, http.MethodGet, ts.URL+"/v1/me", ""))
	if status != http.StatusOK || body["id"] != id {
		t.Fatalf("GET /v1/me 未挂上真实路由: status=%d body=%v", status, body)
	}

	status, _ = doIdentityJSON(t, http.MethodGet, ts.URL+"/v1/catalog", "", "")
	if status != http.StatusOK {
		t.Fatalf("GET /v1/catalog status=%d，公开读被鉴权误伤", status)
	}
}

func TestEventUnknownTypeRejectedKnownTypePersisted(t *testing.T) {
	_, srv, ts := newFullServer(t)
	id, _ := identityFromSeed(t, testSeed)
	// 用一个**不会**被注册的类型当未知类型的样本；`progress.v1` 已被本册放行，不能再当反例。
	body := `{"event_id":"` + strings.Repeat("7", 32) + `","type":"bogus.v1","created_at":1,"body":{"n":1}}`

	status, out := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/event", "", body)
	if status != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("未签名 status=%d out=%v, want 400/auth_missing_header", status, out)
	}

	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", body))
	if status != http.StatusBadRequest || out["error"] != "event_type_unknown" {
		t.Fatalf("未登记类型 status=%d out=%v, want 400/event_type_unknown", status, out)
	}

	srv.knownEventTypes["bogus.v1"] = struct{}{}
	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", body))
	if status != http.StatusOK {
		t.Fatalf("登记类型后 status=%d out=%v", status, out)
	}
	evs, err := srv.st.ListEvents(id, 10)
	if err != nil || len(evs) != 1 || evs[0].Type != "bogus.v1" || evs[0].BodyJSON != `{"n":1}` {
		t.Fatalf("落库结果 err=%v evs=%+v", err, evs)
	}

	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event",
		`{"event_id":"zz","type":"bogus.v1","created_at":1}`))
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("event_id 非法 status=%d out=%v, want 400/event_param_invalid", status, out)
	}
}

// ---------- #79 §3.3：like.v1 / report.v1 写面验收（Task 2） ----------
// 事件限速是令牌桶（30/min，burst 10），单个节点上 POST /v1/event 次数必须留在桶内，
// 因此按场景拆成三个用例、各自起节点；签事件复用 circleEventBody（同 canonical 签名口径）。

// postLikeReport 发一条已签名的 like.v1 / report.v1 事件，返回 (status, 响应 map)。
func postLikeReport(t *testing.T, n *commentNode, eventID, eventType string, createdAt int64, body map[string]any) (int, map[string]any) {
	t.Helper()
	raw := circleEventBody(t, testSeed, eventID, eventType, createdAt, body)
	return sendAuth(t, signedRequest(t, testSeed, http.MethodPost, n.public+"/v1/event", raw))
}

// ① like 评论成功落行（投影只填 target_id）＋②幂等＋⑧重复举报不拒＋⑨未登记类型回归。
func TestHandleEventLikeReport(t *testing.T) {
	n := newCommentNode(t, "review-key")
	postComment(t, n, eventIDOf(1), "article/a", "被赞评论", "")

	// ① like 评论：200 {event_id, received_at}，无 payload_cid 键。
	like1 := map[string]any{"target_id": eventIDOf(1), "action": "like"}
	status, out := postLikeReport(t, n, eventIDOf(11), "like.v1", 1000, like1)
	if status != http.StatusOK || out["event_id"] != eventIDOf(11) {
		t.Fatalf("like 评论 status=%d out=%v", status, out)
	}
	if _, has := out["payload_cid"]; has {
		t.Fatalf("like 响应不应带 payload_cid: %v", out)
	}
	if out["received_at"] == nil {
		t.Fatalf("like 响应缺 received_at: %v", out)
	}
	ev, ok, err := n.st.GetEventByID(eventIDOf(11))
	if err != nil || !ok {
		t.Fatalf("like 未落行 err=%v ok=%v", err, ok)
	}
	if ev.TargetID != eventIDOf(1) || ev.PayloadCID != "" || ev.ReplyTo != "" {
		t.Fatalf("like 投影列错误: %+v", ev)
	}

	// ② 幂等：同 event_id 重发 → 200 同 received_at。
	status, out2 := postLikeReport(t, n, eventIDOf(11), "like.v1", 1000, like1)
	if status != http.StatusOK || out2["received_at"] != out["received_at"] {
		t.Fatalf("幂等重发 status=%d out=%v, want received_at=%v", status, out2, out["received_at"])
	}

	// ⑧ 重复举报两条不同 event_id → 均 200（重复举报本身是信号，节点不拒）。
	for i, reason := range []string{"spam", "abuse"} {
		status, out = postLikeReport(t, n, eventIDOf(21+i), "report.v1", int64(2000+i),
			map[string]any{"target_id": eventIDOf(1), "reason": reason})
		if status != http.StatusOK {
			t.Fatalf("report %s status=%d out=%v", reason, status, out)
		}
	}
	ev, ok, err = n.st.GetEventByID(eventIDOf(21))
	if err != nil || !ok || ev.TargetID != eventIDOf(1) || ev.PayloadCID != "" || ev.ReplyTo != "" {
		t.Fatalf("report 未落行或投影错误 err=%v ok=%v ev=%+v", err, ok, ev)
	}
	if !strings.Contains(ev.BodyJSON, `"reason":"spam"`) ||
		!strings.Contains(ev.BodyJSON, `"target_id":"`+eventIDOf(1)+`"`) {
		t.Fatalf("report body_json 应存 reason/target_id: %s", ev.BodyJSON)
	}

	// ⑨ 未登记类型回归：type=like.v2 → 400 event_type_unknown。
	status, out = postLikeReport(t, n, eventIDOf(23), "like.v2", 1,
		map[string]any{"target_id": eventIDOf(1), "action": "like"})
	if status != http.StatusBadRequest || out["error"] != "event_type_unknown" {
		t.Fatalf("未登记类型 status=%d out=%v", status, out)
	}
}

// ③评论 target 不存在 404＋④墓碑 410＋⑤条目 target 存在性校验＋⑥like body 严格键集。
func TestHandleEventLikeTargetCheck(t *testing.T) {
	n := newCommentNode(t, "review-key")
	hdr := map[string]string{"X-Base-Review-Key": "review-key"}
	postComment(t, n, eventIDOf(1), "article/a", "会被删的评论", "")

	// ③ 评论 target 不存在 → 404 target_not_found。
	status, out := postLikeReport(t, n, eventIDOf(12), "like.v1", 1001,
		map[string]any{"target_id": eventIDOf(30), "action": "like"})
	if status != http.StatusNotFound || out["error"] != "target_not_found" {
		t.Fatalf("target 不存在 status=%d out=%v", status, out)
	}

	// ④ target 已墓碑（review reject 产生）→ 410 target_gone（like 与 report 同口径）。
	if status, out := doJSONMap(t, http.MethodPost, n.public+"/v1/admin/review/reject",
		`{"event_id":"`+eventIDOf(1)+`","reason":"违规"}`, hdr); status != http.StatusOK {
		t.Fatalf("reject status=%d out=%v", status, out)
	}
	status, out = postLikeReport(t, n, eventIDOf(13), "like.v1", 1002,
		map[string]any{"target_id": eventIDOf(1), "action": "like"})
	if status != http.StatusGone || out["error"] != "target_gone" {
		t.Fatalf("墓碑 target status=%d out=%v", status, out)
	}

	// ⑤ 条目 target：不存在 → 404；active → 200；下架（removed）→ 404。
	status, out = postLikeReport(t, n, eventIDOf(14), "like.v1", 1003,
		map[string]any{"target_id": "article/nope", "action": "like"})
	if status != http.StatusNotFound || out["error"] != "target_not_found" {
		t.Fatalf("条目不存在 status=%d out=%v", status, out)
	}
	artBody := "测试正文\n"
	if err := n.st.UpsertArticle(store.Article{ItemID: "article/a1", Title: "测试", BodyMD: artBody,
		ContentHash: protocol.SHA256Hex([]byte(artBody)), SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z"}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	status, out = postLikeReport(t, n, eventIDOf(15), "like.v1", 1004,
		map[string]any{"target_id": "article/a1", "action": "like"})
	if status != http.StatusOK {
		t.Fatalf("条目 like status=%d out=%v", status, out)
	}
	if err := n.st.RetireItem("article/a1", 1); err != nil {
		t.Fatalf("RetireItem: %v", err)
	}
	status, out = postLikeReport(t, n, eventIDOf(16), "like.v1", 1005,
		map[string]any{"target_id": "article/a1", "action": "unlike"})
	if status != http.StatusNotFound || out["error"] != "target_not_found" {
		t.Fatalf("条目下架 status=%d out=%v", status, out)
	}

	// ⑥ like body：非法 action / 多未知键 → 400 event_param_invalid。
	status, out = postLikeReport(t, n, eventIDOf(17), "like.v1", 1006,
		map[string]any{"target_id": eventIDOf(1), "action": "love"})
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("非法 action status=%d out=%v", status, out)
	}
	status, out = postLikeReport(t, n, eventIDOf(18), "like.v1", 1007,
		map[string]any{"target_id": eventIDOf(1), "action": "like", "text": "多余键"})
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("多未知键 status=%d out=%v", status, out)
	}
}

// ⑦report 四值 reason / 缺键 / 多键 / 非评论形态 target 严格校验＋report 的 target 404。
func TestHandleEventReportBodyCheck(t *testing.T) {
	n := newCommentNode(t, "review-key")
	postComment(t, n, eventIDOf(2), "article/b", "被举报评论", "")

	// 非法 reason（严格四值 spam/abuse/illegal/other）→ 400 event_param_invalid。
	status, out := postLikeReport(t, n, eventIDOf(24), "report.v1", 2003,
		map[string]any{"target_id": eventIDOf(2), "reason": "hate"})
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("非法 reason status=%d out=%v", status, out)
	}
	// 缺 reason 键 → 400。
	status, out = postLikeReport(t, n, eventIDOf(25), "report.v1", 2004,
		map[string]any{"target_id": eventIDOf(2)})
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("缺 reason status=%d out=%v", status, out)
	}
	// 多未知键 → 400。
	status, out = postLikeReport(t, n, eventIDOf(26), "report.v1", 2005,
		map[string]any{"target_id": eventIDOf(2), "reason": "spam", "text": "多余键"})
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("多未知键 status=%d out=%v", status, out)
	}
	// report 只收评论 target（16 hex）：路径式 → 400 event_param_invalid。
	status, out = postLikeReport(t, n, eventIDOf(27), "report.v1", 2006,
		map[string]any{"target_id": "article/b", "reason": "spam"})
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("条目形态 target status=%d out=%v", status, out)
	}
	// report 的 target 不存在 → 404 target_not_found（与 like 同口径）。
	status, out = postLikeReport(t, n, eventIDOf(28), "report.v1", 2007,
		map[string]any{"target_id": eventIDOf(31), "reason": "spam"})
	if status != http.StatusNotFound || out["error"] != "target_not_found" {
		t.Fatalf("report target 不存在 status=%d out=%v", status, out)
	}
}

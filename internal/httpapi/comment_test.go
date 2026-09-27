package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// commentNode 是评论验收用的测试节点：客户端监听与对端监听分开登记，
// 因此可以断言「event-sync 只在 peer 上存在」这类路由红线。
type commentNode struct {
	st     *store.Store
	public string
	peer   string
}

func newCommentNode(t *testing.T, reviewKey string) *commentNode {
	t.Helper()
	st, err := store.Open(t.TempDir(), store.WithStoreKey(identityTestStoreKey))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	srv, err := New(st, Options{Issuer: "base-node-1", SignKeyHex: testSeed, Version: "test", ReviewKey: reviewKey})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	pub := newInprocServer(srv.Handler())
	peer := newInprocServer(srv.PeerHandler())
	t.Cleanup(pub.Close)
	t.Cleanup(peer.Close)

	id, pk := identityFromSeed(t, testSeed)
	if status, body := doIdentityJSON(t, http.MethodPost, pub.URL+"/v1/identity/register", "", registerBody(id, pk)); status != http.StatusOK {
		t.Fatalf("预登记 status=%d body=%v", status, body)
	}
	return &commentNode{st: st, public: pub.URL, peer: peer.URL}
}

// commentEventBody 造一条 comment.v1 事件体，并按 §3.4 签内容签名
// canonical({event_id,type,created_at,body})——与节点侧重建的待验字节同口径。
func commentEventBody(t *testing.T, seed, eventID, target, text, replyTo string) string {
	t.Helper()
	body := map[string]any{"target_id": target, "text": text}
	if replyTo != "" {
		body["reply_to"] = replyTo
	}
	payload := map[string]any{
		"event_id": eventID, "type": "comment.v1",
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

func eventIDOf(i int) string { return fmt.Sprintf("%032x", i) }

func doRaw(t *testing.T, method, rawURL, body string, headers map[string]string) (int, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, rawURL, rdr)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	return res.StatusCode, raw
}

func doJSONMap(t *testing.T, method, rawURL, body string, headers map[string]string) (int, map[string]any) {
	t.Helper()
	code, raw := doRaw(t, method, rawURL, body, headers)
	out := map[string]any{}
	if len(raw) > 0 {
		// 未命中的路由由 Go 默认 NotFound 输出纯文本，这里容忍非 JSON 体。
		_ = json.Unmarshal(raw, &out)
	}
	return code, out
}

// postComment 发一条评论并返回 (payload_cid, event_id)。
func postComment(t *testing.T, n *commentNode, eventID, target, text, replyTo string) string {
	t.Helper()
	body := commentEventBody(t, testSeed, eventID, target, text, replyTo)
	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, n.public+"/v1/event", body))
	if status != http.StatusOK {
		t.Fatalf("发表评论 status=%d out=%v", status, out)
	}
	cid, _ := out["payload_cid"].(string)
	if !protocol.IsBlobID(cid) {
		t.Fatalf("payload_cid 不合法: %v", out)
	}
	return cid
}

func listComments(t *testing.T, baseURL, query string) ([]map[string]any, any) {
	t.Helper()
	status, out := doJSONMap(t, http.MethodGet, baseURL+"/v1/comment"+query, "", nil)
	if status != http.StatusOK {
		t.Fatalf("GET /v1/comment%s status=%d out=%v", query, status, out)
	}
	raw, _ := out["comments"].([]any)
	items := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		m, ok := r.(map[string]any)
		if !ok {
			t.Fatalf("comments 元素形状异常: %v", r)
		}
		items = append(items, m)
	}
	return items, out["next_cursor"]
}

// 验收 1/2/3：类型登记、正文落块、同 event_id 幂等。
func TestCommentWriteBlobAndIdempotent(t *testing.T) {
	n := newCommentNode(t, "")
	cid := postComment(t, n, eventIDOf(1), "article/hello", "中文评论正文", "")

	status, raw := doRaw(t, http.MethodGet, n.public+"/v1/blob/"+cid, "", nil)
	if status != http.StatusOK || string(raw) != "中文评论正文" {
		t.Fatalf("取回正文 status=%d raw=%q", status, raw)
	}

	// 同 event_id 重发（重新签请求头，sig 不变）
	body := commentEventBody(t, testSeed, eventIDOf(1), "article/hello", "中文评论正文", "")
	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, n.public+"/v1/event", body))
	if status != http.StatusOK || out["payload_cid"] != cid {
		t.Fatalf("幂等重发 status=%d out=%v", status, out)
	}
	actor, _ := identityFromSeed(t, testSeed)
	evs, err := n.st.ListEvents(actor, 10)
	if err != nil || len(evs) != 1 {
		t.Fatalf("同 event_id 应只有一行 err=%v evs=%+v", err, evs)
	}
	items, _ := listComments(t, n.public, "?target_id=article/hello")
	if len(items) != 1 || items[0]["event_id"] != eventIDOf(1) {
		t.Fatalf("公开读应只出现一条: %v", items)
	}

	// 未登记类型仍 400 event_type_unknown
	bad := `{"event_id":"` + eventIDOf(9) + `","type":"like.v1","created_at":1,"body":{}}`
	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, n.public+"/v1/event", bad))
	if status != http.StatusBadRequest || out["error"] != "event_type_unknown" {
		t.Fatalf("未登记类型 status=%d out=%v", status, out)
	}
}

// 验收 4：篡改 text 后重签请求头（sig 不重签）→ 403 event_sig_invalid。
func TestCommentSigCoversBody(t *testing.T) {
	n := newCommentNode(t, "")
	body := commentEventBody(t, testSeed, eventIDOf(2), "article/a", "原始正文", "")
	tampered := strings.Replace(body, "原始正文", "篡改正文", 1)
	if tampered == body {
		t.Fatal("替换失败，测试自身有误")
	}
	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, n.public+"/v1/event", tampered))
	if status != http.StatusForbidden || out["code"] != "event_sig_invalid" {
		t.Fatalf("内容签名不覆盖正文 status=%d out=%v", status, out)
	}

	// 缺 sig → 同样是 403（内容签名必填）
	noSig := `{"event_id":"` + eventIDOf(2) + `","type":"comment.v1","created_at":1,"body":{"target_id":"article/a","text":"x"}}`
	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, n.public+"/v1/event", noSig))
	if status != http.StatusForbidden || out["code"] != "event_sig_invalid" {
		t.Fatalf("缺 sig status=%d out=%v", status, out)
	}
}

// 验收 6/7：按 target_id 分页读与全站混合读。
func TestCommentListByTargetAndSiteWide(t *testing.T) {
	n := newCommentNode(t, "")
	postComment(t, n, eventIDOf(1), "article/a", "第一条", "")
	postComment(t, n, eventIDOf(2), "article/a", "第二条", eventIDOf(1))
	postComment(t, n, eventIDOf(3), "article/b", "第三条", "")

	items, _ := listComments(t, n.public, "?target_id=article/a")
	if len(items) != 2 {
		t.Fatalf("按内容读 = %v", items)
	}
	if items[0]["event_id"] != eventIDOf(2) || items[1]["event_id"] != eventIDOf(1) {
		t.Fatalf("应按 created_at 倒序: %v", items)
	}
	if items[0]["reply_to"] != eventIDOf(1) || items[1]["reply_to"] != nil {
		t.Fatalf("reply_to 投影错误: %v", items)
	}
	if items[0]["target_id"] != "article/a" || items[0]["actor"] == nil {
		t.Fatalf("投影字段缺失: %v", items[0])
	}

	all, _ := listComments(t, n.public, "")
	if len(all) != 3 {
		t.Fatalf("全站读应 3 条: %v", all)
	}

	// 分页：limit=2 → 有 next_cursor；带回后取到剩下那条
	page1, next := listComments(t, n.public, "?target_id=article/a&limit=2")
	if len(page1) != 2 || next == nil {
		t.Fatalf("第一页 limit=2 items=%v next=%v", page1, next)
	}
	page2, _ := listComments(t, n.public, "?target_id=article/a&limit=2&cursor="+next.(string))
	if len(page2) != 0 {
		t.Fatalf("两页已取完，第二页应为空: %v", page2)
	}

	// 全站分页：limit=2 → 第二页 1 条
	all1, nextAll := listComments(t, n.public, "?limit=2")
	if len(all1) != 2 || nextAll == nil {
		t.Fatalf("全站第一页 items=%v next=%v", all1, nextAll)
	}
	all2, _ := listComments(t, n.public, "?limit=2&cursor="+nextAll.(string))
	if len(all2) != 1 {
		t.Fatalf("全站第二页应为 1 条: %v", all2)
	}
}

// 验收 9/11：审核取正文、reject 后列表消失且块 404。
func TestReviewFetchAndRejectCloseLoop(t *testing.T) {
	n := newCommentNode(t, "review-key")
	cid := postComment(t, n, eventIDOf(1), "article/a", "待审正文", "")
	postComment(t, n, eventIDOf(2), "article/a", "保留正文", "")
	hdr := map[string]string{"X-Base-Review-Key": "review-key"}

	status, out := doJSONMap(t, http.MethodPost, n.public+"/v1/admin/review/fetch",
		`{"payload_cid":"`+cid+`"}`, hdr)
	if status != http.StatusOK || out["text"] != "待审正文" {
		t.Fatalf("review/fetch status=%d out=%v", status, out)
	}
	status, out = doJSONMap(t, http.MethodPost, n.public+"/v1/admin/review/fetch",
		`{"payload_cid":"`+strings.Repeat("0", 32)+`"}`, hdr)
	if status != http.StatusNotFound || out["error"] != "blob_not_found" {
		t.Fatalf("不存在的块 status=%d out=%v", status, out)
	}

	status, out = doJSONMap(t, http.MethodPost, n.public+"/v1/admin/review/reject",
		`{"event_id":"`+eventIDOf(1)+`","reason":"违规"}`, hdr)
	if status != http.StatusOK || out["payload_cid"] != cid {
		t.Fatalf("review/reject status=%d out=%v", status, out)
	}
	// 列表不再返回该条
	items, _ := listComments(t, n.public, "?target_id=article/a")
	if len(items) != 1 || items[0]["event_id"] != eventIDOf(2) {
		t.Fatalf("审核删后列表 = %v", items)
	}
	// 块已删
	if status, _ := doRaw(t, http.MethodGet, n.public+"/v1/blob/"+cid, "", nil); status != http.StatusNotFound {
		t.Fatalf("审核删后取块 status=%d, want 404", status)
	}
	// 同一条重发 → 400 event_revoked
	body := commentEventBody(t, testSeed, eventIDOf(1), "article/a", "待审正文", "")
	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, n.public+"/v1/event", body))
	if status != http.StatusBadRequest || out["code"] != "event_revoked" {
		t.Fatalf("已删评论重发 status=%d out=%v", status, out)
	}
	// 不存在的 event_id → 404
	status, out = doJSONMap(t, http.MethodPost, n.public+"/v1/admin/review/reject",
		`{"event_id":"`+eventIDOf(8)+`"}`, hdr)
	if status != http.StatusNotFound || out["error"] != "event_not_found" {
		t.Fatalf("未知 event_id status=%d out=%v", status, out)
	}
}

// 验收 10：未配 BASE_REVIEW_KEY → 404；配了但密钥不符 → 同样 404（不暴露存在性）。
func TestReviewRoutesAbsentWithoutKey(t *testing.T) {
	noKey := newCommentNode(t, "")
	status, _ := doJSONMap(t, http.MethodPost, noKey.public+"/v1/admin/review/fetch", `{"payload_cid":"`+strings.Repeat("a", 32)+`"}`, nil)
	if status != http.StatusNotFound {
		t.Fatalf("未配密钥 status=%d, want 404", status)
	}
	status, _ = doJSONMap(t, http.MethodPost, noKey.public+"/v1/admin/review/reject", `{"event_id":"`+eventIDOf(1)+`"}`, nil)
	if status != http.StatusNotFound {
		t.Fatalf("未配密钥 reject status=%d, want 404", status)
	}

	withKey := newCommentNode(t, "review-key")
	status, _ = doJSONMap(t, http.MethodPost, withKey.public+"/v1/admin/review/fetch",
		`{"payload_cid":"`+strings.Repeat("a", 32)+`"}`, map[string]string{"X-Base-Review-Key": "wrong"})
	if status != http.StatusNotFound {
		t.Fatalf("密钥不符 status=%d, want 404", status)
	}
}

// 验收 17（路由红线 + 游标）：event-sync 只在 peer 监听上存在，游标推进不重复拉取。
func TestEventSyncOnlyOnPeerHandler(t *testing.T) {
	n := newCommentNode(t, "review-key")
	postComment(t, n, eventIDOf(1), "article/a", "一", "")
	hdr := map[string]string{"X-Base-Review-Key": "review-key"}

	// 客户端监听上这条路由根本不存在
	if status, _ := doJSONMap(t, http.MethodPost, n.public+"/v1/event-sync", `{"kind":"event"}`, nil); status != http.StatusNotFound {
		t.Fatalf("event-sync 出现在客户端监听上 status=%d", status)
	}

	status, out := doJSONMap(t, http.MethodPost, n.peer+"/v1/event-sync", `{"kind":"event","after":{"ts":0,"id":""}}`, nil)
	if status != http.StatusOK {
		t.Fatalf("peer event-sync status=%d out=%v", status, out)
	}
	items, _ := out["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("应拉到 1 条事件: %v", out)
	}
	it, _ := items[0].(map[string]any)
	if it["type"] != "comment.v1" || it["event_id"] != eventIDOf(1) || it["body_json"] == nil {
		t.Fatalf("事件项形状: %v", it)
	}

	// 用末条游标续拉 → 空页
	after := fmt.Sprintf(`{"kind":"event","after":{"ts":%.0f,"id":%q}}`, it["received_at"], it["event_id"])
	status, out = doJSONMap(t, http.MethodPost, n.peer+"/v1/event-sync", after, nil)
	if status != http.StatusOK {
		t.Fatalf("续拉 status=%d out=%v", status, out)
	}
	if items, _ := out["items"].([]any); len(items) != 0 {
		t.Fatalf("游标推进后不应重复拉取: %v", out)
	}

	// kind 非法 → 400
	if status, _ := doJSONMap(t, http.MethodPost, n.peer+"/v1/event-sync", `{"kind":"nope"}`, nil); status != http.StatusBadRequest {
		t.Fatalf("非法 kind status=%d, want 400", status)
	}

	// 墓碑增量
	doJSONMap(t, http.MethodPost, n.public+"/v1/admin/review/reject", `{"event_id":"`+eventIDOf(1)+`"}`, hdr)
	status, out = doJSONMap(t, http.MethodPost, n.peer+"/v1/event-sync", `{"kind":"tombstone","limit":10}`, nil)
	if status != http.StatusOK {
		t.Fatalf("tombstone sync status=%d out=%v", status, out)
	}
	tombs, _ := out["items"].([]any)
	if len(tombs) != 1 {
		t.Fatalf("应拉到 1 条墓碑: %v", out)
	}
	tm, _ := tombs[0].(map[string]any)
	if tm["event_id"] != eventIDOf(1) || tm["reason"] == nil {
		t.Fatalf("墓碑项形状: %v", tm)
	}
}

// 验收 12（护栏 1）：fetch 不返回墓碑中的块。
func TestFetchSkipsRevokedPayload(t *testing.T) {
	n := newCommentNode(t, "review-key")
	keep := postComment(t, n, eventIDOf(1), "article/a", "保留", "")
	dead := postComment(t, n, eventIDOf(2), "article/a", "删除", "")
	hdr := map[string]string{"X-Base-Review-Key": "review-key"}

	status, _ := doRaw(t, http.MethodPost, n.peer+"/v1/fetch",
		`{"blob_ids":["`+keep+`","`+dead+`"]}`, nil)
	if status != http.StatusOK {
		t.Fatalf("fetch status=%d", status)
	}
	status, raw := doRaw(t, http.MethodPost, n.peer+"/v1/fetch", `{"blob_ids":["`+keep+`","`+dead+`"]}`, nil)
	if status != http.StatusOK || len(raw) == 0 {
		t.Fatalf("未删块的正常 fetch status=%d len=%d", status, len(raw))
	}

	if status, out := doJSONMap(t, http.MethodPost, n.public+"/v1/admin/review/reject",
		`{"event_id":"`+eventIDOf(2)+`"}`, hdr); status != http.StatusOK {
		t.Fatalf("reject status=%d out=%v", status, out)
	}
	// 只剩被撤销的块 → 响应里一帧都没有
	status, raw = doRaw(t, http.MethodPost, n.peer+"/v1/fetch", `{"blob_ids":["`+dead+`"]}`, nil)
	if status != http.StatusOK || len(raw) != 0 {
		t.Fatalf("被撤块不应被返回 status=%d len=%d", status, len(raw))
	}
	// 未删的块不受影响
	status, raw = doRaw(t, http.MethodPost, n.peer+"/v1/fetch", `{"blob_ids":["`+keep+`"]}`, nil)
	if status != http.StatusOK || len(raw) == 0 {
		t.Fatalf("未撤块应照常返回 status=%d len=%d", status, len(raw))
	}
}

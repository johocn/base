package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

func trimSpace(s string) string { return strings.TrimSpace(s) }

func TestValidProposalAction(t *testing.T) {
	for _, a := range []string{"remove", "edit", "revive"} {
		if !validProposalAction(a) {
			t.Fatalf("应合法: %q", a)
		}
	}
	for _, a := range []string{"", "REMOVE", "delete", "add", "remove "} {
		if validProposalAction(a) {
			t.Fatalf("应非法: %q", a)
		}
	}
}

func TestValidProposalReason(t *testing.T) {
	// 缺省（空串）走「未给定」分支，由 handler 判；此处的判定只针对「已给定」。
	for _, raw := range []string{"", "   ", "\t\n", repeat("文", 201), "有\x00控制符", "有\x7f控制符"} {
		if _, ok := validProposalReason(raw); ok {
			t.Fatalf("应非法: %q", raw)
		}
	}
	for _, raw := range []string{"错别字", "  两边有空白  ", repeat("文", 200)} {
		s, ok := validProposalReason(raw)
		if !ok {
			t.Fatalf("应合法: %q", raw)
		}
		if s != trimSpace(raw) {
			t.Fatalf("应返回去空白后的值: %q → %q", raw, s)
		}
	}
}

func TestParseProposalID(t *testing.T) {
	for raw, want := range map[string]int64{"1": 1, "42": 42, "9007199254740993": 9007199254740993} {
		got, ok := parseProposalID(raw)
		if !ok || got != want {
			t.Fatalf("parseProposalID(%q)=(%d,%v) want (%d,true)", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", "0", "-1", "1.0", "abc", "1 ", " 1", "0x1"} {
		if got, ok := parseProposalID(raw); ok {
			t.Fatalf("parseProposalID(%q) 应失败，得 %d", raw, got)
		}
	}
}

// 四个治理者 + 一个只有身份、没有内容的非治理者。全部为 32 字节测试种子。
const (
	govSeedA = "1111111111111111111111111111111111111111111111111111111111111111"
	govSeedB = "2222222222222222222222222222222222222222222222222222222222222222"
	govSeedC = "3333333333333333333333333333333333333333333333333333333333333333"
	govSeedD = "4444444444444444444444444444444444444444444444444444444444444444"
	govSeedX = "5555555555555555555555555555555555555555555555555555555555555555"
)

// governNode 是治理验收用的测试节点。
type governNode struct {
	st     *store.Store
	public string
}

// newGovernNode 起一个真 httpapi 节点（进程内），并预登记 A/B/C/D/X 五个身份。
// 注意不登记 testSeed：本册的名册完全由 A/B/C/D 的投稿构成。
func newGovernNode(t *testing.T) *governNode {
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
	pub := newInprocServer(srv.Handler())
	t.Cleanup(pub.Close)
	n := &governNode{st: st, public: pub.URL}
	for _, seed := range []string{govSeedA, govSeedB, govSeedC, govSeedD, govSeedX} {
		id, pk := identityFromSeed(t, seed)
		if status, body := doIdentityJSON(t, http.MethodPost, n.public+"/v1/identity/register", "", registerBody(id, pk)); status != http.StatusOK {
			t.Fatalf("登记身份 %s status=%d body=%v", id, status, body)
		}
	}
	return n
}

// fourGovernors 造 4 个达门槛的作者 → 名册 4 人（AC 1 的前置，Task 5/6 用例共用）。
// 目标条目固定归 B：article/gb。
func fourGovernors(t *testing.T) *governNode {
	t.Helper()
	n := newGovernNode(t)
	n.publishArticle(t, govSeedA, "article/a1", "甲")
	n.publishArticle(t, govSeedB, "article/gb", "乙")
	n.publishArticle(t, govSeedC, "article/gc", "丙")
	n.publishArticle(t, govSeedD, "article/gd", "丁")
	return n
}

// post 发一个已签名的 POST。
func (n *governNode) post(t *testing.T, seed, path, body string) (int, map[string]any) {
	t.Helper()
	return sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+path, body))
}

// publishArticle 用 seed 投一篇 ≥200 rune 的 article，返回正文（供 edit 用例原样回传）。
func (n *governNode) publishArticle(t *testing.T, seed, itemID, title string) string {
	t.Helper()
	body := title + repeat("文", 200)
	code, out := n.post(t, seed, "/v1/submit", submitBody(t, seed, "article", itemID, title, "body_md", body))
	if code != http.StatusOK {
		t.Fatalf("投稿 %s 失败: code=%d out=%v", itemID, code, out)
	}
	return body
}

// rosterCount 读匿名名册里某个 id 的条数；不在名册返回 0。
func (n *governNode) rosterCount(t *testing.T, id string) int {
	t.Helper()
	code, body := getJSON(t, n.public+"/v1/contributors")
	if code != http.StatusOK {
		t.Fatalf("GET /v1/contributors code=%d", code)
	}
	list, _ := body["contributors"].([]any)
	for _, item := range list {
		m, _ := item.(map[string]any)
		if m["id"] == id {
			c, _ := m["count"].(float64)
			return int(c)
		}
	}
	return 0
}

// proposalBody 造一份提案体：action + item_id，再并入 extra。
func proposalBody(t *testing.T, action, itemID string, extra map[string]any) string {
	t.Helper()
	m := map[string]any{"action": action, "item_id": itemID}
	for k, v := range extra {
		m[k] = v
	}
	return mustJSON(t, m)
}

func TestProposalRejectsIdentityFieldsInBody(t *testing.T) {
	n := fourGovernors(t)
	// 目标归 B、提案人 A：本来能受理，只因请求体带了身份字段才被拒。
	for _, key := range []string{"proposer_id", "author_id"} {
		raw := proposalBody(t, "remove", "article/gb", map[string]any{key: "00000000000000000000000000000000"})
		code, out := n.post(t, govSeedA, "/v1/proposal", raw)
		if code != http.StatusBadRequest || out["code"] != "author_id_forbidden" {
			t.Fatalf("%s: code=%d out=%v", key, code, out)
		}
	}
	if _, ok, _ := n.st.GetProposal(1); ok {
		t.Fatal("拒绝时不得落库")
	}
}

func TestProposalRejectsBadActionReasonAndEditPayload(t *testing.T) {
	n := fourGovernors(t)
	cases := []struct {
		name string
		body string
		code int
		want string
	}{
		{"action", proposalBody(t, "delete", "article/gb", nil), http.StatusBadRequest, "proposal_action_unsupported"},
		{"reason-空", proposalBody(t, "remove", "article/gb", map[string]any{"reason": "   "}), http.StatusBadRequest, "proposal_reason_invalid"},
		{"reason-超长", proposalBody(t, "remove", "article/gb", map[string]any{"reason": repeat("文", 201)}), http.StatusBadRequest, "proposal_reason_invalid"},
		{"edit-无载荷", proposalBody(t, "edit", "article/gb", nil), http.StatusBadRequest, "proposal_edit_invalid"},
		{"edit-无 body_md", proposalBody(t, "edit", "article/gb", map[string]any{"edit": map[string]any{"title": "新"}}), http.StatusBadRequest, "proposal_edit_invalid"},
		{"edit-坏 title", proposalBody(t, "edit", "article/gb", map[string]any{"edit": map[string]any{"title": "  ", "body_md": "x"}}), http.StatusBadRequest, "proposal_edit_invalid"},
		{"edit-超限", proposalBody(t, "edit", "article/gb", map[string]any{"edit": map[string]any{"title": "新", "body_md": repeat("a", maxSubmitBytes+1)}}), http.StatusRequestEntityTooLarge, "proposal_too_large"},
	}
	for _, c := range cases {
		code, out := n.post(t, govSeedA, "/v1/proposal", c.body)
		if code != c.code || out["code"] != c.want {
			t.Fatalf("%s: code=%d out=%v want %d/%s", c.name, code, out, c.code, c.want)
		}
	}
	if _, ok, _ := n.st.GetProposal(1); ok {
		t.Fatal("拒绝时不得落库")
	}
}

func TestProposalRejectsItemNotFoundSelfOwnedAndStateMismatch(t *testing.T) {
	n := fourGovernors(t)
	// 404：目标不存在。
	if code, out := n.post(t, govSeedA, "/v1/proposal", proposalBody(t, "remove", "article/nope", nil)); code != http.StatusNotFound || out["code"] != "item_not_found" {
		t.Fatalf("不存在: code=%d out=%v", code, out)
	}
	// 403：目标是自己的条目（自己改自己走 POST /v1/submit）。
	if code, out := n.post(t, govSeedB, "/v1/proposal", proposalBody(t, "remove", "article/gb", nil)); code != http.StatusForbidden || out["code"] != "item_self_owned" {
		t.Fatalf("自己条目: code=%d out=%v", code, out)
	}
	// 400：active 条目提 revive。
	if code, out := n.post(t, govSeedA, "/v1/proposal", proposalBody(t, "revive", "article/gb", nil)); code != http.StatusBadRequest || out["code"] != "item_state_mismatch" {
		t.Fatalf("state 不匹配: code=%d out=%v", code, out)
	}
}

// 册子 §0.3：edit 仅限 article 载体；同一目标提 remove 则正常受理。
func TestProposalEditOnlyForArticleCarrier(t *testing.T) {
	n := fourGovernors(t)
	qj := `{"schema_version":1,"questions":[{"q":"1","options":["a"],"answer":0,"explain":""}]}`
	if err := n.st.UpsertQuiz(store.Quiz{
		ItemID: "quiz/z1", Title: "题组", QuestionJSON: qj,
		ContentHash: protocol.SHA256Hex([]byte(qj)), SourceRev: "rev-1",
	}); err != nil {
		t.Fatalf("UpsertQuiz: %v", err)
	}
	edit := proposalBody(t, "edit", "quiz/z1", map[string]any{"edit": map[string]any{"title": "新", "body_md": "正文"}})
	if code, out := n.post(t, govSeedA, "/v1/proposal", edit); code != http.StatusBadRequest || out["code"] != "proposal_edit_invalid" {
		t.Fatalf("非 article 载体提 edit: code=%d out=%v", code, out)
	}
	if code, out := n.post(t, govSeedA, "/v1/proposal", proposalBody(t, "remove", "quiz/z1", nil)); code != http.StatusCreated {
		t.Fatalf("非 article 载体提 remove 应受理: code=%d out=%v", code, out)
	}
}

func TestProposalRejectsNonGovernor(t *testing.T) {
	n := fourGovernors(t)
	// X 有身份但没内容 → 不在名册（等价于「名册第 11 名」）。
	if code, out := n.post(t, govSeedX, "/v1/proposal", proposalBody(t, "remove", "article/gb", nil)); code != http.StatusForbidden || out["code"] != "proposer_not_governor" {
		t.Fatalf("非治理者: code=%d out=%v", code, out)
	}
	if _, ok, _ := n.st.GetProposal(1); ok {
		t.Fatal("拒绝时不得落库")
	}
}

func TestProposalAuthAndRateLimit(t *testing.T) {
	n := fourGovernors(t)
	body := proposalBody(t, "remove", "article/gb", nil)

	// 无签名头：requireAuth 第 1 步。
	if code, out := doJSONMap(t, http.MethodPost, n.public+"/v1/proposal", body, nil); code != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("无签名头 code=%d out=%v", code, out)
	}
	// 限速：按身份的 burst 是 3，第 4 条必须 429。
	var code int
	var out map[string]any
	for i := 0; i <= proposalBurstPerID; i++ {
		code, out = n.post(t, govSeedA, "/v1/proposal", body)
		if i < proposalBurstPerID && code != http.StatusCreated {
			t.Fatalf("第 %d 条应 201: code=%d out=%v", i+1, code, out)
		}
	}
	if code != http.StatusTooManyRequests || out["code"] != "govern_rate_limited" {
		t.Fatalf("超限应 429: code=%d out=%v", code, out)
	}
}

// 受理成功：201 且带 threshold（remove 为 3）、status=pending、vote_count=1。
func TestProposalCreated(t *testing.T) {
	n := fourGovernors(t)
	code, out := n.post(t, govSeedA, "/v1/proposal", proposalBody(t, "remove", "article/gb", map[string]any{"reason": "明显违规"}))
	if code != http.StatusCreated {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if out["action"] != "remove" || out["item_id"] != "article/gb" ||
		out["threshold"] != float64(3) || out["status"] != "pending" || out["vote_count"] != float64(1) {
		t.Fatalf("响应不对: %v", out)
	}
	if _, ok := out["proposal_id"].(string); !ok {
		t.Fatalf("proposal_id 必须是字符串: %v", out["proposal_id"])
	}
}

// propose 发一个提案并返回 proposal_id（断言 201）。
func (n *governNode) propose(t *testing.T, seed, action, itemID string, extra map[string]any) string {
	t.Helper()
	code, out := n.post(t, seed, "/v1/proposal", proposalBody(t, action, itemID, extra))
	if code != http.StatusCreated {
		t.Fatalf("提案 %s %s: code=%d out=%v", action, itemID, code, out)
	}
	id, _ := out["proposal_id"].(string)
	return id
}

// vote 投一票（空请求体）并返回响应。
func (n *governNode) vote(t *testing.T, seed, proposalID string) (int, map[string]any) {
	t.Helper()
	return n.post(t, seed, "/v1/proposal/"+proposalID+"/vote", "")
}

// proposals 拉匿名列表。
func (n *governNode) proposals(t *testing.T) []map[string]any {
	t.Helper()
	code, body := getJSON(t, n.public+"/v1/proposal")
	if code != http.StatusOK {
		t.Fatalf("GET /v1/proposal code=%d", code)
	}
	list, _ := body["proposals"].([]any)
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		m, _ := item.(map[string]any)
		out = append(out, m)
	}
	return out
}

// longBody 造 ≥200 rune 的正文（供 edit 用例直写 articles）。
func (n *governNode) longBody(marker string) string { return marker + repeat("文", 200) }

func TestVoteRejectsUnknownProposalNonGovernorAndDuplicate(t *testing.T) {
	n := fourGovernors(t)

	// 404：提案不存在（含非数字路径段）。
	if code, out := n.vote(t, govSeedA, "999"); code != http.StatusNotFound || out["code"] != "proposal_not_found" {
		t.Fatalf("不存在: code=%d out=%v", code, out)
	}
	if code, out := n.vote(t, govSeedA, "abc"); code != http.StatusNotFound || out["code"] != "proposal_not_found" {
		t.Fatalf("非数字 id: code=%d out=%v", code, out)
	}
	// 403：投票人不在名册（X 无内容）。
	id := n.propose(t, govSeedA, "remove", "article/gb", nil)
	if code, out := n.vote(t, govSeedX, id); code != http.StatusForbidden || out["code"] != "voter_not_governor" {
		t.Fatalf("非治理者投票: code=%d out=%v", code, out)
	}
	// 409：提案人给自己已投的提案再投。
	if code, out := n.vote(t, govSeedA, id); code != http.StatusConflict || out["code"] != "already_voted" {
		t.Fatalf("提案人重复投票: code=%d out=%v", code, out)
	}
	// 400：请求体携带身份字段。
	if code, out := n.post(t, govSeedB, "/v1/proposal/"+id+"/vote", `{"voter_id":"00000000000000000000000000000000"}`); code != http.StatusBadRequest || out["code"] != "author_id_forbidden" {
		t.Fatalf("携带 voter_id: code=%d out=%v", code, out)
	}
}

// remove 分档：第 2 票仍 pending、第 3 票才生效（册子 §2.1 的关键分界）。
func TestVoteRemoveThresholdIsThree(t *testing.T) {
	n := fourGovernors(t)
	id := n.propose(t, govSeedA, "remove", "article/gb", nil)

	code, out := n.vote(t, govSeedC, id)
	if code != http.StatusOK || out["vote_count"] != float64(2) || out["threshold"] != float64(3) || out["status"] != "pending" {
		t.Fatalf("第 2 票: code=%d out=%v", code, out)
	}
	if it, _, _ := n.st.GetItem("article/gb"); it.State != "active" {
		t.Fatalf("第 2 票不得下架: %s", it.State)
	}
	code, out = n.vote(t, govSeedD, id)
	if code != http.StatusOK || out["vote_count"] != float64(3) || out["status"] != "effective" {
		t.Fatalf("第 3 票: code=%d out=%v", code, out)
	}
	if it, _, _ := n.st.GetItem("article/gb"); it.State != "removed" {
		t.Fatalf("应已下架: %s", it.State)
	}
}

// 匿名列表：不需签名头即 200；阈值随动作；votes 随名册实时增减。
func TestProposalListAnonymousAndRealtimeVotes(t *testing.T) {
	n := fourGovernors(t)
	id := n.propose(t, govSeedA, "remove", "article/gb", nil)
	if _, out := n.vote(t, govSeedC, id); out["status"] != "pending" {
		t.Fatalf("第 2 票应 pending: %v", out)
	}
	list := n.proposals(t)
	if len(list) != 1 {
		t.Fatalf("应有 1 条提案: %v", list)
	}
	p := list[0]
	if p["threshold"] != float64(3) || p["vote_count"] != float64(2) || p["status"] != "pending" {
		t.Fatalf("列表字段不对: %v", p)
	}
	votes, _ := p["votes"].([]any)
	if len(votes) != 2 {
		t.Fatalf("有效票应为 2: %v", votes)
	}

	// C 出榜：把它的文章改成不足门槛的短正文 → C 的条数归零。
	if err := n.st.UpsertArticle(store.Article{
		ItemID: "article/gc", Title: "短", BodyMD: "短",
		ContentHash: protocol.SHA256Hex([]byte("短")), SourceRev: "rev-2",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	p = n.proposals(t)[0]
	if p["vote_count"] != float64(1) || p["status"] != "pending" {
		t.Fatalf("C 出榜后票数应回退到 1: %v", p)
	}
	// C 重新入榜 → 票恢复（UpsertArticle 不动 author_id，归属仍在）。
	if err := n.st.UpsertArticle(store.Article{
		ItemID: "article/gc", Title: "丙", BodyMD: n.longBody("丙"),
		ContentHash: protocol.SHA256Hex([]byte(n.longBody("丙"))), SourceRev: "rev-3",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	p = n.proposals(t)[0]
	if p["vote_count"] != float64(2) {
		t.Fatalf("C 重新入榜后票应恢复: %v", p)
	}
	// edit 档门槛是 2。
	eid := n.propose(t, govSeedA, "edit", "article/gb", map[string]any{
		"edit": map[string]any{"title": "新标题", "body_md": n.longBody("乙")},
	})
	for _, item := range n.proposals(t) {
		if item["proposal_id"] != eid {
			continue
		}
		if item["threshold"] != float64(2) {
			t.Fatalf("edit 门槛应为 2: %v", item)
		}
	}
}

func TestVoteRateLimited(t *testing.T) {
	n := fourGovernors(t)
	n.propose(t, govSeedA, "remove", "article/gb", nil)
	// 限速在鉴权与 404 之后、落库之前，用不存在提案更干净：
	var code int
	var out map[string]any
	for i := 0; i <= voteBurstPerID; i++ {
		code, out = n.vote(t, govSeedC, "999")
		if i < voteBurstPerID && code != http.StatusNotFound {
			t.Fatalf("第 %d 次应 404: code=%d out=%v", i+1, code, out)
		}
	}
	if code != http.StatusTooManyRequests || out["code"] != "govern_rate_limited" {
		t.Fatalf("超限应 429: code=%d out=%v", code, out)
	}
}

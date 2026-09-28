package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"

	"github.com/johocn/base/internal/packexport"
	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

func TestValidSlug(t *testing.T) {
	ok := []string{"a", "abc", "a1", "0", "a-b-c", "a" + repeat("b", 63)}
	bad := []string{"", "-a", "A", "a_b", "a b", "é", "a" + repeat("b", 64), "a/b"}
	for _, s := range ok {
		if !validSlug(s) {
			t.Fatalf("应合法: %q", s)
		}
	}
	for _, s := range bad {
		if validSlug(s) {
			t.Fatalf("应非法: %q", s)
		}
	}
}

func TestSplitSubmitItemID(t *testing.T) {
	cases := []struct {
		itemID, typ, wantSlug, wantCode string
	}{
		{"article/hello", "article", "hello", ""},
		{"quiz/q-1", "quiz", "q-1", ""},
		{"article/hello", "quiz", "", "item_type_mismatch"},
		{"quiz/q-1", "article", "", "item_type_mismatch"},
		{"course/c1", "article", "", "item_id_invalid"},
		{"course/c1/lesson/l1/quiz/q1", "quiz", "", "item_id_invalid"},
		{"article/", "article", "", "item_id_invalid"},
		{"article/Bad", "article", "", "item_id_invalid"},
		{"article/a/b", "article", "", "item_id_invalid"},
		{"lesson/x", "article", "", "item_id_invalid"},
	}
	for _, c := range cases {
		slug, code := splitSubmitItemID(c.itemID, c.typ)
		if slug != c.wantSlug || code != c.wantCode {
			t.Fatalf("splitSubmitItemID(%q, %q) = (%q, %q), want (%q, %q)",
				c.itemID, c.typ, slug, code, c.wantSlug, c.wantCode)
		}
	}
}

func TestValidItemTitle(t *testing.T) {
	if !validItemTitle("a") {
		t.Fatal("1 rune 应合法")
	}
	if !validItemTitle("  标题  ") {
		t.Fatal("去首尾空白后非空应合法")
	}
	if !validItemTitle(repeat("文", 200)) {
		t.Fatal("200 rune 应合法")
	}
	bad := []string{"", "   ", repeat("文", 201), "标\x00题", "标\x1f题", "标\x7f题"}
	for _, s := range bad {
		if validItemTitle(s) {
			t.Fatalf("应非法: %q", s)
		}
	}
}

func TestValidQuestionJSON(t *testing.T) {
	ok := `{"schema_version":1,"questions":[{"q":"1","options":["a"],"answer":0,"explain":""}]}`
	if !validQuestionJSON(ok) {
		t.Fatal("合法题组应通过")
	}
	// 未知键不参与判定（与内部解析器同口径：只看 schema_version 与 questions）。
	if !validQuestionJSON(`{"schema_version":1,"questions":[{"q":"1"}],"extra":1}`) {
		t.Fatal("额外键不应导致拒绝")
	}
	bad := []string{
		"",
		"不是 JSON",
		`{"questions":[{"q":"1"}]}`,
		`{"schema_version":2,"questions":[{"q":"1"}]}`,
		`{"schema_version":1}`,
		`{"schema_version":1,"questions":[]}`,
		`{"schema_version":1,"questions":"x"}`,
	}
	for _, s := range bad {
		if validQuestionJSON(s) {
			t.Fatalf("应非法: %q", s)
		}
	}
}

// content_hash 必须与导入器逐字节同构：UTF-8 字节的 sha256，不走 canonicalize。
func TestSubmissionContentHash(t *testing.T) {
	body := "中文正文\n"
	if got, want := submissionContentHash("article", body, ""), protocol.SHA256Hex([]byte(body)); got != want {
		t.Fatalf("article content_hash = %s, want %s", got, want)
	}
	qj := `{"schema_version":1,"questions":[]}`
	if got, want := submissionContentHash("quiz", "", qj), protocol.SHA256Hex([]byte(qj)); got != want {
		t.Fatalf("quiz content_hash = %s, want %s", got, want)
	}
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

const (
	// subOtherSeed 是第二个身份（「他人」场景）。
	subOtherSeed = "6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6"
	// subUnregSeed 未在任何节点登记过（authmw 的 identity_unregistered 场景）。
	subUnregSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f61"
)

// submitNode 是投稿验收用的测试节点。
type submitNode struct {
	st     *store.Store
	public string
}

// newSubmitNode 起一个真 httpapi 节点（进程内），并预登记 testSeed 的身份。
func newSubmitNode(t *testing.T) *submitNode {
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
	n := &submitNode{st: st, public: pub.URL}
	n.registerSeed(t, testSeed)
	return n
}

// registerSeed 登记一个身份（testSeed 已由 newSubmitNode 登记）。
func (n *submitNode) registerSeed(t *testing.T, seed string) string {
	t.Helper()
	id, pk := identityFromSeed(t, seed)
	if status, body := doIdentityJSON(t, http.MethodPost, n.public+"/v1/identity/register", "", registerBody(id, pk)); status != http.StatusOK {
		t.Fatalf("登记身份 status=%d body=%v", status, body)
	}
	return id
}

// rosterCount 读匿名名册里某个 id 的条数；不在名册返回 0。
func (n *submitNode) rosterCount(t *testing.T, id string) int {
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

// submitBody 造一份投稿体：content_hash 按册子 §2.2 算、author_sig 按 §2.3 签。
// contentKey 取 "body_md" 或 "question_json"。
func submitBody(t *testing.T, seed, typ, itemID, title, contentKey, content string) string {
	t.Helper()
	id, _ := identityFromSeed(t, seed)
	hash := protocol.SHA256Hex([]byte(content))
	signBytes, err := protocol.AuthorSignBytes(itemID, hash, id)
	if err != nil {
		t.Fatalf("AuthorSignBytes: %v", err)
	}
	sig, err := protocol.Sign(seed, signBytes)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return mustJSON(t, map[string]any{
		"type": typ, "item_id": itemID, "title": title, contentKey: content, "author_sig": sig,
	})
}

// withExtraKey 在已造好的投稿体上追加一个键（用于「请求体携带 author_id」与「携带 content_hash」场景）。
func withExtraKey(t *testing.T, body, key string, val any) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	m[key] = val
	return mustJSON(t, m)
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(raw)
}

// postSubmit 发一条投稿，返回 (HTTP 状态, 响应体)。
func postSubmit(t *testing.T, n *submitNode, seed, body string) (int, map[string]any) {
	t.Helper()
	return sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", body))
}

func TestSubmitRejectsAuthorIDInBody(t *testing.T) {
	n := newSubmitNode(t)
	body := withExtraKey(t, submitBody(t, testSeed, "article", "article/a1", "标题", "body_md", "正文\n"), "author_id", "00000000000000000000000000000000")
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusBadRequest || out["code"] != "author_id_forbidden" {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if _, ok, _ := n.st.GetItem("article/a1"); ok {
		t.Fatal("拒绝时不得写入")
	}
}

func TestSubmitRejectsTypeAndItemID(t *testing.T) {
	n := newSubmitNode(t)
	cases := []struct {
		body string
		want string
	}{
		{submitBody(t, testSeed, "video", "article/a1", "标题", "body_md", "正文\n"), "item_type_unsupported"},
		{submitBody(t, testSeed, "article", "course/c1", "标题", "body_md", "正文\n"), "item_id_invalid"},
		{submitBody(t, testSeed, "article", "article/Bad", "标题", "body_md", "正文\n"), "item_id_invalid"},
		{submitBody(t, testSeed, "quiz", "article/a1", "标题", "question_json", `{"schema_version":1,"questions":[{"q":"1"}]}`), "item_type_mismatch"},
	}
	for _, c := range cases {
		code, out := postSubmit(t, n, testSeed, c.body)
		if code != http.StatusBadRequest || out["code"] != c.want {
			t.Fatalf("want %s, got code=%d out=%v", c.want, code, out)
		}
	}
}

func TestSubmitRejectsInvalidTitle(t *testing.T) {
	n := newSubmitNode(t)
	for _, title := range []string{"", "   ", repeat("文", 201), "标\x00题"} {
		body := submitBody(t, testSeed, "article", "article/a2", title, "body_md", "正文\n")
		code, out := postSubmit(t, n, testSeed, body)
		if code != http.StatusBadRequest || out["code"] != "item_title_invalid" {
			t.Fatalf("title=%q code=%d out=%v", title, code, out)
		}
	}
}

func TestSubmitRejectsOversizeBody(t *testing.T) {
	n := newSubmitNode(t)
	body := submitBody(t, testSeed, "article", "article/a3", "标题", "body_md", repeat("a", maxSubmitBytes+1))
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusRequestEntityTooLarge || out["code"] != "item_body_too_large" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}

func TestSubmitRejectsInvalidQuestionJSON(t *testing.T) {
	n := newSubmitNode(t)
	for _, qj := range []string{"", "不是 JSON", `{"schema_version":2,"questions":[{"q":"1"}]}`, `{"schema_version":1,"questions":[]}`} {
		body := submitBody(t, testSeed, "quiz", "quiz/q2", "题组", "question_json", qj)
		code, out := postSubmit(t, n, testSeed, body)
		if code != http.StatusBadRequest || out["code"] != "item_question_invalid" {
			t.Fatalf("qj=%q code=%d out=%v", qj, code, out)
		}
	}
}

// 正文改动但沿用旧签名 → 服务端按新字节算 content_hash → 验签必然失败（册子 §3.2）。
func TestSubmitRejectsStaleSigAfterBodyChange(t *testing.T) {
	n := newSubmitNode(t)
	first := submitBody(t, testSeed, "article", "article/a4", "标题", "body_md", "第一版正文\n")
	if code, out := postSubmit(t, n, testSeed, first); code != http.StatusOK {
		t.Fatalf("首投 code=%d out=%v", code, out)
	}
	// 只换正文，author_sig 仍是第一版的。
	tampered := withExtraKey(t, first, "body_md", "第二版正文\n")
	code, out := postSubmit(t, n, testSeed, tampered)
	if code != http.StatusBadRequest || out["code"] != "author_sig_invalid" {
		t.Fatalf("code=%d out=%v", code, out)
	}
	a, _, _ := n.st.GetArticle("article/a4")
	if a.BodyMD != "第一版正文\n" {
		t.Fatalf("拒绝时不得覆盖: %q", a.BodyMD)
	}
}

// author_sig 不是 hex 同样按 author_sig_invalid 拒绝。
func TestSubmitRejectsMalformedSig(t *testing.T) {
	n := newSubmitNode(t)
	body := withExtraKey(t, submitBody(t, testSeed, "article", "article/a5", "标题", "body_md", "正文\n"), "author_sig", "zz")
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusBadRequest || out["code"] != "author_sig_invalid" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}

// 请求体若携带 content_hash 一律忽略：错的 hash 只会让验签失败，绕不过去（册子 §2.1）。
func TestSubmitIgnoresContentHashInBody(t *testing.T) {
	n := newSubmitNode(t)
	body := withExtraKey(t, submitBody(t, testSeed, "article", "article/a6", "标题", "body_md", "正文\n"), "content_hash", "00")
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusOK {
		t.Fatalf("携带 content_hash 应被忽略并正常通过: code=%d out=%v", code, out)
	}
	it, _, _ := n.st.GetItem("article/a6")
	if it.ContentHash != protocol.SHA256Hex([]byte("正文\n")) {
		t.Fatalf("落库的 content_hash 应为服务端算出的值: %q", it.ContentHash)
	}
}

func TestSubmitAuthPaths(t *testing.T) {
	n := newSubmitNode(t)
	body := submitBody(t, testSeed, "article", "article/a7", "标题", "body_md", "正文\n")

	// 无签名头：requireAuth 第 1 步。
	code, out := doJSONMap(t, http.MethodPost, n.public+"/v1/submit", body, nil)
	if code != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("无签名头 code=%d out=%v", code, out)
	}
	// 未登记身份：requireAuth 第 3 步。
	code, out = postSubmit(t, n, subUnregSeed, body)
	if code != http.StatusForbidden || out["code"] != "identity_unregistered" {
		t.Fatalf("未登记身份 code=%d out=%v", code, out)
	}
}

// 限速：按身份的 burst 是 3，第 4 条必须 429 item_rate_limited。
func TestSubmitRateLimited(t *testing.T) {
	n := newSubmitNode(t)
	var code int
	var out map[string]any
	for i := 0; i < submitBurstPerID+1; i++ {
		body := submitBody(t, testSeed, "article", fmt.Sprintf("article/rl%d", i), "标题", "body_md", "正文\n")
		code, out = postSubmit(t, n, testSeed, body)
		if i < submitBurstPerID && code != http.StatusOK {
			t.Fatalf("第 %d 条应通过: code=%d out=%v", i+1, code, out)
		}
	}
	if code != http.StatusTooManyRequests || out["code"] != "item_rate_limited" {
		t.Fatalf("超限应 429: code=%d out=%v", code, out)
	}
}

// longBody 造一段 ≥ 200 rune 的正文（跨过名册的 article 质量门槛）。
func longBody(marker string) string { return marker + repeat("文", 200) }

const quizJSON3 = `{"schema_version":1,"questions":[{"q":"1","options":["a"],"answer":0,"explain":""},{"q":"2","options":["b"],"answer":0,"explain":""},{"q":"3","options":["c"],"answer":0,"explain":""}]}`
const quizJSON2 = `{"schema_version":1,"questions":[{"q":"1","options":["a"],"answer":0,"explain":""},{"q":"2","options":["b"],"answer":0,"explain":""}]}`

// AC 1：投 article/<aid>（body_md ≥ 200 rune）→ 200，归属落库，名册 +1。
func TestSubmitAC1Create(t *testing.T) {
	n := newSubmitNode(t)
	id, _ := identityFromSeed(t, testSeed)
	body := submitBody(t, testSeed, "article", "article/ac1", "标题", "body_md", longBody("甲"))
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusOK || out["created"] != true || out["author_id"] != id {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if out["content_hash"] != protocol.SHA256Hex([]byte(longBody("甲"))) {
		t.Fatalf("content_hash=%v", out["content_hash"])
	}
	it, ok, _ := n.st.GetItem("article/ac1")
	if !ok || it.AuthorID != id {
		t.Fatalf("归属未落库: ok=%v it=%+v", ok, it)
	}
	if got := n.rosterCount(t, id); got != 1 {
		t.Fatalf("名册条数=%d want 1", got)
	}
}

// AC 2：同请求体重复提交 → 200、content_hash 不变、名册仍 1 条。
func TestSubmitAC2Idempotent(t *testing.T) {
	n := newSubmitNode(t)
	id, _ := identityFromSeed(t, testSeed)
	body := submitBody(t, testSeed, "article", "article/ac2", "标题", "body_md", longBody("乙"))
	code, first := postSubmit(t, n, testSeed, body)
	if code != http.StatusOK || first["created"] != true {
		t.Fatalf("首投 code=%d out=%v", code, first)
	}
	code, second := postSubmit(t, n, testSeed, body)
	if code != http.StatusOK || second["created"] != false {
		t.Fatalf("重投 code=%d out=%v", code, second)
	}
	if second["content_hash"] != first["content_hash"] {
		t.Fatalf("content_hash 变了: %v → %v", first["content_hash"], second["content_hash"])
	}
	if got := n.rosterCount(t, id); got != 1 {
		t.Fatalf("名册条数=%d want 1", got)
	}
}

// AC 3 / AC 4：改正文不重签必失败；改正文并重签则通过且名册仍 1 条。
func TestSubmitAC3AC4Resign(t *testing.T) {
	n := newSubmitNode(t)
	id, _ := identityFromSeed(t, testSeed)
	oldBody := longBody("丙")
	body := submitBody(t, testSeed, "article", "article/ac3", "标题", "body_md", oldBody)
	if code, out := postSubmit(t, n, testSeed, body); code != http.StatusOK {
		t.Fatalf("首投 code=%d out=%v", code, out)
	}

	// AC 3：换正文、沿用旧签名。
	stale := withExtraKey(t, body, "body_md", longBody("丁"))
	code, out := postSubmit(t, n, testSeed, stale)
	if code != http.StatusBadRequest || out["code"] != "author_sig_invalid" {
		t.Fatalf("AC3 code=%d out=%v", code, out)
	}
	a, _, _ := n.st.GetArticle("article/ac3")
	if a.BodyMD != oldBody {
		t.Fatalf("AC3 拒绝时不得覆盖: %q", a.BodyMD)
	}

	// AC 4：换正文并重签。
	re := submitBody(t, testSeed, "article", "article/ac3", "标题", "body_md", longBody("丁"))
	code, out = postSubmit(t, n, testSeed, re)
	if code != http.StatusOK || out["created"] != false {
		t.Fatalf("AC4 code=%d out=%v", code, out)
	}
	if out["content_hash"] != protocol.SHA256Hex([]byte(longBody("丁"))) {
		t.Fatalf("AC4 content_hash=%v", out["content_hash"])
	}
	if got := n.rosterCount(t, id); got != 1 {
		t.Fatalf("AC4 名册条数=%d want 1", got)
	}
}

// AC 5：他人投同一 item_id → 403，原条目与归属不变。
func TestSubmitAC5OtherAuthorRejected(t *testing.T) {
	n := newSubmitNode(t)
	idA, _ := identityFromSeed(t, testSeed)
	idB := n.registerSeed(t, subOtherSeed)
	bodyA := submitBody(t, testSeed, "article", "article/ac5", "甲标题", "body_md", longBody("甲"))
	if code, out := postSubmit(t, n, testSeed, bodyA); code != http.StatusOK {
		t.Fatalf("甲投稿 code=%d out=%v", code, out)
	}
	bodyB := submitBody(t, subOtherSeed, "article", "article/ac5", "乙标题", "body_md", longBody("乙"))
	code, out := postSubmit(t, n, subOtherSeed, bodyB)
	if code != http.StatusForbidden || out["code"] != "item_id_taken" {
		t.Fatalf("AC5 code=%d out=%v", code, out)
	}
	it, _, _ := n.st.GetItem("article/ac5")
	if it.AuthorID != idA || it.Title != "甲标题" {
		t.Fatalf("AC5 原条目被改: %+v", it)
	}
	if n.rosterCount(t, idB) != 0 {
		t.Fatal("AC5 被拒的投稿不得计入名册")
	}
}

// AC 6：占用导入器产出的空归属存量条目 → 403。
func TestSubmitAC6LegacyUnattributedRejected(t *testing.T) {
	n := newSubmitNode(t)
	legacy := "运营导入的正文\n"
	if err := n.st.UpsertArticle(store.Article{
		ItemID: "article/ac6", Title: "存量", BodyMD: legacy,
		ContentHash: protocol.SHA256Hex([]byte(legacy)), SourceRev: "rev-1",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	body := submitBody(t, testSeed, "article", "article/ac6", "认领", "body_md", longBody("认领"))
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusForbidden || out["code"] != "item_id_taken" {
		t.Fatalf("AC6 code=%d out=%v", code, out)
	}
	a, _, _ := n.st.GetArticle("article/ac6")
	if a.BodyMD != legacy {
		t.Fatalf("AC6 存量正文被覆盖: %q", a.BodyMD)
	}
}

// AC 8：无签名头 400；未登记身份 403（AC 8 的第二半）。
func TestSubmitAC8AuthErrors(t *testing.T) {
	n := newSubmitNode(t)
	body := submitBody(t, testSeed, "article", "article/ac8", "标题", "body_md", longBody("戊"))
	code, out := doJSONMap(t, http.MethodPost, n.public+"/v1/submit", body, nil)
	if code != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("AC8 无签名头 code=%d out=%v", code, out)
	}
	code, out = postSubmit(t, n, subUnregSeed, body)
	if code != http.StatusForbidden || out["code"] != "identity_unregistered" {
		t.Fatalf("AC8 未登记 code=%d out=%v", code, out)
	}
	if _, ok, _ := n.st.GetItem("article/ac8"); ok {
		t.Fatal("AC8 拒绝时不得写入")
	}
}

// AC 9：3 题题库计贡献；2 题题库入库但不计贡献（名册条数仍为 1）。
func TestSubmitAC9QuizGate(t *testing.T) {
	n := newSubmitNode(t)
	id, _ := identityFromSeed(t, testSeed)
	body3 := submitBody(t, testSeed, "quiz", "quiz/ac9a", "三题", "question_json", quizJSON3)
	if code, out := postSubmit(t, n, testSeed, body3); code != http.StatusOK {
		t.Fatalf("AC9 三题 code=%d out=%v", code, out)
	}
	if got := n.rosterCount(t, id); got != 1 {
		t.Fatalf("AC9 三题名册条数=%d want 1", got)
	}
	body2 := submitBody(t, testSeed, "quiz", "quiz/ac9b", "两题", "question_json", quizJSON2)
	code, out := postSubmit(t, n, testSeed, body2)
	if code != http.StatusOK || out["created"] != true {
		t.Fatalf("AC9 两题 code=%d out=%v", code, out)
	}
	if _, ok, _ := n.st.GetQuiz("quiz/ac9b"); !ok {
		t.Fatal("AC9 两题题库应已入库")
	}
	if got := n.rosterCount(t, id); got != 1 {
		t.Fatalf("AC9 两题不应计贡献: 名册条数=%d want 1", got)
	}
}

// AC 10：导出后 entries[] 带作者归属、contributors 带公钥，且用包内公钥可独立复验通过。
func TestSubmitAC10ExportCarriesAttribution(t *testing.T) {
	n := newSubmitNode(t)
	id, pub := identityFromSeed(t, testSeed)
	body := submitBody(t, testSeed, "article", "article/ac10", "标题", "body_md", longBody("己"))
	if code, out := postSubmit(t, n, testSeed, body); code != http.StatusOK {
		t.Fatalf("投稿 code=%d out=%v", code, out)
	}
	res, err := packexport.Export(n.st, packexport.Options{Issuer: "base-node-1", SignKeyHex: testSeed})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	raw, err := os.ReadFile(res.ManifestPath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var mf protocol.Manifest
	if err := json.Unmarshal(raw, &mf); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if mf.Contributors[id] != pub {
		t.Fatalf("contributors 缺该 id 的公钥: %v", mf.Contributors)
	}
	found := false
	for _, e := range mf.Entries {
		if e.ItemID != "article/ac10" {
			continue
		}
		found = true
		if e.AuthorID != id || !isHexN(e.AuthorSig, 64) {
			t.Fatalf("entries 归属未回填: %+v", e)
		}
		ok, err := protocol.VerifyAuthorSig(mf.Contributors[e.AuthorID], e.ItemID, e.ContentHash, e.AuthorID, e.AuthorSig)
		if err != nil || !ok {
			t.Fatalf("用包内公钥复验应通过: ok=%v err=%v", ok, err)
		}
	}
	if !found {
		t.Fatal("manifest 里没有 article/ac10")
	}
}

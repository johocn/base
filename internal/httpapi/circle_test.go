package httpapi

import (
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// newCircleTest 造一个已登记身份的完整 server；actor 用默认 testSeed。
func newCircleTest(t *testing.T) (*store.Store, *Server, *inprocServer, string) {
	t.Helper()
	st, srv, ts := newFullServer(t)
	id, _ := identityFromSeed(t, testSeed)
	return st, srv, ts, id
}

// seedItemWithAuthor 造一条带 author_id 的 active article（用于 form 正例）。
// 归属缓存列由 httpapi 侧 submit 产生，测试直写库更简单。
func seedItemWithAuthor(t *testing.T, st *store.Store, itemID, authorID string) {
	t.Helper()
	body := "测试正文\n"
	if err := st.UpsertArticle(store.Article{
		ItemID: itemID, Title: "测试", BodyMD: body,
		ContentHash: protocol.SHA256Hex([]byte(body)), SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	// 直接走 store.db.Exec 设置 author_id —— httpapi 没有公开写路径。
	if _, err := execStoreSQL(t, st, `UPDATE items SET author_id=?, author_sig='00' WHERE item_id=?`, authorID, itemID); err != nil {
		t.Fatalf("set author: %v", err)
	}
}

// execStoreSQL 在 store.db 上跑一条语句（测试工具，不通过 store 的公开方法）。
func execStoreSQL(t *testing.T, st *store.Store, q string, args ...any) (sql.Result, error) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(st.DataDir(), "base.db"))+"?mode=rw")
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	return db.Exec(q, args...)
}

// circleBodyAssign 返回 assign action 的 body map（用于 canonicalize 签名）。
func circleBodyAssignMap(itemID, circleID, contentHash string) map[string]any {
	m := map[string]any{
		"action":    "assign",
		"item_id":   itemID,
		"circle_id": circleID,
	}
	if contentHash != "" {
		m["content_hash"] = contentHash
	}
	return m
}

// circleBodyFormMap 返回 form action 的 body map（用于 canonicalize 签名）。
func circleBodyFormMap(itemID, circleID, origin, contentHash string) map[string]any {
	m := map[string]any{
		"action":    "form",
		"item_id":   itemID,
		"circle_id": circleID,
	}
	if origin != "" {
		m["origin"] = origin
	}
	if contentHash != "" {
		m["content_hash"] = contentHash
	}
	return m
}

// circleEventBody 造一条 circle.v1 事件体，按 §3.4 签内容签名 canonical({event_id,type,created_at,body})。
// 与节点侧 verifyEventSig 重建的待验字节同口径。
func circleEventBody(t *testing.T, seed, eventID, eventType string, createdAt int64, body map[string]any) string {
	t.Helper()
	payload := map[string]any{
		"event_id":   eventID,
		"type":       eventType,
		"created_at": createdAt,
		"body":       body,
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

// fakeSig 返回一个固定的 64 hex 假签名（用于坏签名测试）。
func fakeSig() string {
	return strings.Repeat("0", 64)
}

// sha256Of 返回 s 的 SHA-256 hex（用于 content_hash 合法值）。
func sha256Of(s string) string {
	return hex.EncodeToString(protocol.SHA256Sum([]byte(s)))
}

const (
	testCircleID   = "11111111111111111111111111111111" // 16 字节 hex
	testItemID     = "article/circle-test"
	testCircleType = "circle.v1"
)

// TestCircleAssignPositive 是 assign 正例：落 circle_assignments 行 + 事件骨架。
func TestCircleAssignPositive(t *testing.T) {
	st, _, ts, _ := newCircleTest(t)
	eventID := strings.Repeat("a", 32)
	body := circleBodyAssignMap(testItemID, testCircleID, sha256Of("payload"))
	reqBody := circleEventBody(t, testSeed, eventID, testCircleType, 1000, body)

	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", reqBody))
	if status != http.StatusOK {
		t.Fatalf("status=%d out=%v", status, out)
	}
	if out["event_id"] != eventID {
		t.Fatalf("响应 event_id=%v", out["event_id"])
	}

	// 断言投影表有行。
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(st.DataDir(), "base.db"))+"?mode=rw")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var origin string
	var createdAt int64
	err = db.QueryRow(`SELECT origin,created_at FROM circle_assignments WHERE item_id=? AND circle_id=?`, testItemID, testCircleID).
		Scan(&origin, &createdAt)
	if err != nil {
		t.Fatalf("circle_assignments 查询: %v", err)
	}
	if origin != "fusion" {
		t.Fatalf("origin want fusion got %q", origin)
	}
	if createdAt != 1000 {
		t.Fatalf("created_at want 1000 got %d", createdAt)
	}
}

// TestCircleFormPositive 是 form 正例：造 group + 落 circle_assignments + 事件骨架。
func TestCircleFormPositive(t *testing.T) {
	st, _, ts, id := newCircleTest(t)
	// 造带归属的条目（author_id = 测试身份）。
	seedItemWithAuthor(t, st, testItemID, id)

	eventID := strings.Repeat("b", 32)
	body := circleBodyFormMap(testItemID, testCircleID, "user", "")
	reqBody := circleEventBody(t, testSeed, eventID, testCircleType, 2000, body)

	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", reqBody))
	if status != http.StatusOK {
		t.Fatalf("status=%d out=%v", status, out)
	}
	if out["event_id"] != eventID {
		t.Fatalf("响应 event_id=%v", out["event_id"])
	}

	// 断言 groups 行被创建。
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(st.DataDir(), "base.db"))+"?mode=rw")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var creatorID string
	var epoch, rosterRev, encrypted int64
	var memberJSON, origin, evID string
	err = db.QueryRow(`SELECT creator_id,epoch,roster_rev,encrypted,member_ids_json,origin,event_id FROM groups WHERE group_id=?`, testCircleID).
		Scan(&creatorID, &epoch, &rosterRev, &encrypted, &memberJSON, &origin, &evID)
	if err != nil {
		t.Fatalf("groups 查询: %v", err)
	}
	if creatorID != id {
		t.Fatalf("creator_id want %s got %s", id, creatorID)
	}
	if epoch != 1 || rosterRev != 0 || encrypted != 1 {
		t.Fatalf("group 字段 epoch=%d rev=%d enc=%d", epoch, rosterRev, encrypted)
	}
	if memberJSON != `["`+id+`"]` {
		t.Fatalf("member_ids_json=%s", memberJSON)
	}
	if origin != "user" {
		t.Fatalf("origin want user got %s", origin)
	}
	if evID != testCircleID {
		t.Fatalf("event_id want %s got %s", testCircleID, evID)
	}

	// 断言 circle_assignments 也有行。
	var aOrigin string
	err = db.QueryRow(`SELECT origin FROM circle_assignments WHERE item_id=? AND circle_id=?`, testItemID, testCircleID).
		Scan(&aOrigin)
	if err != nil {
		t.Fatalf("circle_assignments 查询: %v", err)
	}
	if aOrigin != "user" {
		t.Fatalf("assignment origin want user got %s", aOrigin)
	}
}

// TestCircleFormItemNotFound 是 fail-closed 格：条目不存在 → 400 item_not_found。
func TestCircleFormItemNotFound(t *testing.T) {
	_, _, ts, _ := newCircleTest(t)
	eventID := strings.Repeat("c", 32)
	body := circleBodyFormMap("article/does-not-exist", testCircleID, "", "")
	reqBody := circleEventBody(t, testSeed, eventID, testCircleType, 3000, body)

	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", reqBody))
	if status != http.StatusBadRequest {
		t.Fatalf("status=%d out=%v want 400/item_not_found", status, out)
	}
	if out["error"] != "item_not_found" {
		t.Fatalf("error want item_not_found got %v", out["error"])
	}
}

// TestCircleUnknownAction 是未知 action：parseCircleBody 返回 false → 400 event_param_invalid。
func TestCircleUnknownAction(t *testing.T) {
	_, _, ts, _ := newCircleTest(t)
	eventID := strings.Repeat("d", 32)
	body := map[string]any{"action": "destroy", "item_id": testItemID, "circle_id": testCircleID}
	reqBody := circleEventBody(t, testSeed, eventID, testCircleType, 4000, body)

	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", reqBody))
	if status != http.StatusBadRequest {
		t.Fatalf("status=%d out=%v want 400/event_param_invalid", status, out)
	}
	if out["error"] != "event_param_invalid" {
		t.Fatalf("error want event_param_invalid got %v", out["error"])
	}
}

// TestCircleUnknownType 是未知 type：注册表拒绝 → 400 event_type_unknown。
// 注意：这个在注册表检查阶段就被拒，不会走到验签管线，但还是构造正确签名以隔离变量。
func TestCircleUnknownType(t *testing.T) {
	_, _, ts, _ := newCircleTest(t)
	eventID := strings.Repeat("e", 32)
	body := circleBodyAssignMap(testItemID, testCircleID, "")
	reqBody := circleEventBody(t, testSeed, eventID, "circle_unknown.v1", 5000, body)

	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", reqBody))
	if status != http.StatusBadRequest {
		t.Fatalf("status=%d out=%v want 400/event_type_unknown", status, out)
	}
	if out["error"] != "event_type_unknown" {
		t.Fatalf("error want event_type_unknown got %v", out["error"])
	}
}

// TestCircleBadSig 是坏事件体签名：HTTP 头签名正确但事件体 sig 字段伪造 → 403 event_sig_invalid。
func TestCircleBadSig(t *testing.T) {
	_, _, ts, _ := newCircleTest(t)
	eventID := strings.Repeat("f", 32)
	body := circleBodyAssignMap(testItemID, testCircleID, "")
	reqBody := circleEventBody(t, testSeed, eventID, testCircleType, 6000, body)

	// 把事件体里的 sig 换成假值，但 HTTP 头签名保持正确。
	var payload map[string]any
	if err := json.Unmarshal([]byte(reqBody), &payload); err != nil {
		t.Fatal(err)
	}
	payload["sig"] = fakeSig()
	tampered, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}

	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", string(tampered)))
	if status != http.StatusForbidden {
		t.Fatalf("status=%d out=%v want 403/event_sig_invalid", status, out)
	}
	if out["code"] != "event_sig_invalid" {
		t.Fatalf("code want event_sig_invalid got %v (error=%v)", out["code"], out["error"])
	}
}

// TestCircleExtraUnknownKey 是未知白名单外键：多一个键即拒 → 400 event_param_invalid。
// assign 键集里没有 origin，给它加一个 → parseCircleBody 返回 false。
func TestCircleExtraUnknownKey(t *testing.T) {
	_, _, ts, _ := newCircleTest(t)
	eventID := strings.Repeat("9", 32)
	body := map[string]any{
		"action":    "assign",
		"item_id":   testItemID,
		"circle_id": testCircleID,
		"origin":    "fusion", // assign 白名单没有这个键
	}
	reqBody := circleEventBody(t, testSeed, eventID, testCircleType, 7000, body)

	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", reqBody))
	if status != http.StatusBadRequest {
		t.Fatalf("status=%d out=%v want 400/event_param_invalid", status, out)
	}
	if out["error"] != "event_param_invalid" {
		t.Fatalf("error want event_param_invalid got %v", out["error"])
	}
}

// 让 time 包即使没有直接使用也被引入（保持 import 整洁）。
var _ = time.Now

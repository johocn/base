package httpapi

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// groupIDOf 造一个 group_id（契约：16 字节 = 32 hex，与 event_id 同形）。
func groupIDOf(n int) string { return fmt.Sprintf("%032x", n) }

// newGroupNode 复用既有测试节点，并登记 testSeed 身份（写事件必须先登记）。
func newGroupNode(t *testing.T) (*store.Store, string) {
	t.Helper()
	st, _, ts := newTestServer(t)
	registerIdentitySeed(t, ts.URL, testSeed)
	return st, ts.URL
}

func registerIdentitySeed(t *testing.T, baseURL, seed string) string {
	t.Helper()
	id, pub := identityFromSeed(t, seed)
	if status, body := doIdentityJSON(t, http.MethodPost, baseURL+"/v1/identity/register", "", registerBody(id, pub)); status != http.StatusOK {
		t.Fatalf("登记身份 status=%d body=%v", status, body)
	}
	return id
}

// groupEventBody 造一条 group.v1 事件体并签内容签名 canonical({event_id,type,created_at,body})，
// 与 commentEventBody 同口径（节点侧重建的待验字节必须一致）。
func groupEventBody(t *testing.T, seed, eventID string, body map[string]any) string {
	t.Helper()
	payload := map[string]any{
		"event_id": eventID, "type": "group.v1",
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

func postGroupBody(t *testing.T, seed, baseURL, eventID string, body map[string]any) (int, map[string]any) {
	t.Helper()
	raw := groupEventBody(t, seed, eventID, body)
	return sendAuth(t, signedRequest(t, seed, http.MethodPost, baseURL+"/v1/event", raw))
}

func postGroupRoster(t *testing.T, seed, baseURL, eventID, groupID string, epoch int64, members []string, name string, encrypted int64) {
	t.Helper()
	body := map[string]any{"group_id": groupID, "action": "roster", "epoch": epoch, "member_ids": members, "encrypted": encrypted}
	if name != "" {
		body["name"] = name
	}
	if status, out := postGroupBody(t, seed, baseURL, eventID, body); status != http.StatusOK {
		t.Fatalf("roster 事件 status=%d out=%v", status, out)
	}
}

func postGroupMsg(t *testing.T, seed, baseURL, eventID, groupID string, epoch int64, cipher, replyTo string) string {
	t.Helper()
	body := map[string]any{"group_id": groupID, "action": "msg", "epoch": epoch, "text_cipher": cipher}
	if replyTo != "" {
		body["reply_to"] = replyTo
	}
	status, out := postGroupBody(t, seed, baseURL, eventID, body)
	if status != http.StatusOK {
		t.Fatalf("msg 事件 status=%d out=%v", status, out)
	}
	cid, _ := out["payload_cid"].(string)
	if !protocol.IsBlobID(cid) {
		t.Fatalf("payload_cid 不合法: %v", out)
	}
	return cid
}

// 验收 3：节点侧无明文——块里存的就是客户端密文，事件行与块目录原始字节都不含明文。
func TestGroupMsgStoresCipherNotPlaintext(t *testing.T) {
	st, base := newGroupNode(t)
	gid := groupIDOf(1)
	plain := "小组消息明文-绝不出现在节点"
	// 密文形态照 §3.2：nonceHex:ctHex，确保既不等于也不包含明文
	cipher := strings.Repeat("ab", 12) + ":" + hex.EncodeToString([]byte(plain))
	if cipher == plain || strings.Contains(cipher, plain) {
		t.Fatal("测试自身有误：密文不得等于或包含明文")
	}

	cid := postGroupMsg(t, testSeed, base, eventIDOf(1), gid, 1, cipher, "")

	// 块内容等于客户端给的密文（节点不解密、不解释）
	got, err := st.GetBlobBytes(cid)
	if err != nil || string(got) != cipher {
		t.Fatalf("块内容应等于客户端密文 err=%v got=%q", err, got)
	}
	// 块目录的原始字节（at-rest 加密）里不得出现明文
	rawBlob, err := os.ReadFile(st.BlobPath(cid))
	if err != nil {
		t.Fatalf("读块文件: %v", err)
	}
	if strings.Contains(string(rawBlob), plain) {
		t.Fatal("块目录原始字节里出现了小组明文")
	}
	// 事件行（节点库）只留 payload_cid，不含密文也不含明文
	ev, ok, err := st.GetEventByID(eventIDOf(1))
	if err != nil || !ok {
		t.Fatalf("读事件行 err=%v ok=%v", err, ok)
	}
	if strings.Contains(ev.BodyJSON, cipher) || strings.Contains(ev.BodyJSON, plain) {
		t.Fatalf("events.body_json 泄漏了密文或明文: %s", ev.BodyJSON)
	}
	if ev.PayloadCID != cid || ev.Type != "group.v1" {
		t.Fatalf("事件行投影异常: %+v", ev)
	}
}

// 验收 5：非创建者签名提交 roster → 403 group_owner_mismatch，且投影不动。
func TestGroupRosterOwnerMismatch(t *testing.T) {
	st, base := newGroupNode(t)
	idA, _ := identityFromSeed(t, testSeed)
	seedB := strings.Repeat("ab", 32) // 另一把确定性测试私钥
	idB := registerIdentitySeed(t, base, seedB)
	gid := groupIDOf(2)

	postGroupRoster(t, testSeed, base, eventIDOf(1), gid, 1, []string{idA}, "甲组", 1)

	status, out := postGroupBody(t, seedB, base, eventIDOf(2),
		map[string]any{"group_id": gid, "action": "roster", "epoch": 2, "member_ids": []string{idB}})
	if status != http.StatusForbidden || out["code"] != "group_owner_mismatch" {
		t.Fatalf("非创建者 roster status=%d out=%v, want 403/group_owner_mismatch", status, out)
	}
	g, ok, err := st.GetGroup(gid)
	if err != nil || !ok || g.CreatorID != idA || g.Epoch != 1 {
		t.Fatalf("被拒后投影被改动: %+v ok=%v err=%v", g, ok, err)
	}
}

// 验收 6：epoch 不大于当前值的 roster → 409 group_epoch_stale。
func TestGroupRosterEpochStale(t *testing.T) {
	st, base := newGroupNode(t)
	idA, _ := identityFromSeed(t, testSeed)
	gid := groupIDOf(3)

	postGroupRoster(t, testSeed, base, eventIDOf(1), gid, 3, []string{idA}, "甲组", 1)

	for _, tc := range []struct {
		name    string
		eventID string
		epoch   int64
	}{
		{"相等", eventIDOf(2), 3},
		{"更小", eventIDOf(3), 2},
	} {
		status, out := postGroupBody(t, testSeed, base, tc.eventID,
			map[string]any{"group_id": gid, "action": "roster", "epoch": tc.epoch, "member_ids": []string{idA}})
		if status != http.StatusConflict || out["code"] != "group_epoch_stale" {
			t.Fatalf("%s epoch status=%d out=%v, want 409/group_epoch_stale", tc.name, status, out)
		}
	}
	g, ok, err := st.GetGroup(gid)
	if err != nil || !ok || g.Epoch != 3 || g.EventID != eventIDOf(1) {
		t.Fatalf("被拒后投影被改动: %+v ok=%v err=%v", g, ok, err)
	}
}

// §3.4 严格键集：msg 多带 member_ids / roster 多带 text_cipher 都要 400。
func TestGroupUnknownKeyRejected(t *testing.T) {
	_, base := newGroupNode(t)
	idA, _ := identityFromSeed(t, testSeed)
	gid := groupIDOf(4)

	// msg 里混入 member_ids
	status, out := postGroupBody(t, testSeed, base, eventIDOf(1), map[string]any{
		"group_id": gid, "action": "msg", "epoch": 1, "text_cipher": "aabb",
		"member_ids": []string{idA},
	})
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("msg 未知键 status=%d out=%v, want 400/event_param_invalid", status, out)
	}

	// roster 里混入 text_cipher
	status, out = postGroupBody(t, testSeed, base, eventIDOf(2), map[string]any{
		"group_id": gid, "action": "roster", "epoch": 1, "member_ids": []string{idA},
		"text_cipher": "aabb",
	})
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("roster 未知键 status=%d out=%v, want 400/event_param_invalid", status, out)
	}

	// 未登记的 action 同样拒
	status, out = postGroupBody(t, testSeed, base, eventIDOf(3), map[string]any{
		"group_id": gid, "action": "kick", "epoch": 1,
	})
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("未登记 action status=%d out=%v, want 400/event_param_invalid", status, out)
	}
}

// 验收 9（索引侧）：未入组者无需任何签名头即可读到名单与发言索引。
func TestGroupGetAnonymousListing(t *testing.T) {
	_, base := newGroupNode(t)
	idA, _ := identityFromSeed(t, testSeed)
	idB := registerIdentitySeed(t, base, strings.Repeat("ab", 32))
	gid := groupIDOf(5)

	postGroupRoster(t, testSeed, base, eventIDOf(1), gid, 1, []string{idA, idB}, "读书组", 0)
	cid1 := postGroupMsg(t, testSeed, base, eventIDOf(2), gid, 1, "aa:01", "")
	cid2 := postGroupMsg(t, testSeed, base, eventIDOf(3), gid, 1, "bb:02", eventIDOf(2))

	// 匿名：不带任何 X-Base-* 头
	status, out := doJSONMap(t, http.MethodGet, base+"/v1/group/"+gid, "", nil)
	if status != http.StatusOK {
		t.Fatalf("匿名读 status=%d out=%v", status, out)
	}
	grp, ok := out["group"].(map[string]any)
	if !ok {
		t.Fatalf("响应缺 group: %v", out)
	}
	if grp["group_id"] != gid || grp["creator_id"] != idA || grp["epoch"].(float64) != 1 || grp["name"] != "读书组" {
		t.Fatalf("group 投影异常: %v", grp)
	}
	members, _ := grp["member_ids"].([]any)
	if len(members) != 2 || members[0] != idA || members[1] != idB {
		t.Fatalf("member_ids = %v, want [%s %s]", members, idA, idB)
	}

	// events 只含 msg（roster 不进会话流），reply_to 两种形态都要对
	events, _ := out["events"].([]any)
	if len(events) != 2 {
		t.Fatalf("events 应只含 2 条 msg: %v", events)
	}
	byID := map[string]map[string]any{}
	for _, e := range events {
		m, _ := e.(map[string]any)
		byID[m["event_id"].(string)] = m
	}
	first, ok1 := byID[eventIDOf(2)]
	second, ok2 := byID[eventIDOf(3)]
	if !ok1 || !ok2 {
		t.Fatalf("events 缺 msg 事件: %v", events)
	}
	if first["payload_cid"] != cid1 || first["reply_to"] != nil {
		t.Fatalf("无回复的 msg 形状异常: %v", first)
	}
	if second["payload_cid"] != cid2 || second["reply_to"] != eventIDOf(2) {
		t.Fatalf("带回复的 msg 形状异常: %v", second)
	}
	if first["action"] != "msg" || first["actor"] != idA || first["epoch"].(float64) != 1 {
		t.Fatalf("msg 投影字段异常: %v", first)
	}
}

// 验收 9 边界：未建组（尚无任何 roster）→ 404 group_not_found。
func TestGroupGetNotFound(t *testing.T) {
	_, base := newGroupNode(t)
	status, out := doJSONMap(t, http.MethodGet, base+"/v1/group/"+groupIDOf(99), "", nil)
	if status != http.StatusNotFound || out["code"] != "group_not_found" {
		t.Fatalf("未建组 status=%d out=%v, want 404/group_not_found", status, out)
	}
}

// 补充 5 的宽松口径：没有任何 roster 时也接受 msg（节点不为组内状态把关）。
func TestGroupMsgWithoutRosterAccepted(t *testing.T) {
	_, base := newGroupNode(t)
	gid := groupIDOf(6)
	cid := postGroupMsg(t, testSeed, base, eventIDOf(1), gid, 1, "cc:03", "")
	if !protocol.IsBlobID(cid) {
		t.Fatalf("payload_cid 非法: %s", cid)
	}
}

// 读接口分页与 GET /v1/comment 同口径：满页给 next_cursor，不满页给 null。
func TestGroupGetPagination(t *testing.T) {
	_, base := newGroupNode(t)
	idA, _ := identityFromSeed(t, testSeed)
	gid := groupIDOf(7)
	postGroupRoster(t, testSeed, base, eventIDOf(1), gid, 1, []string{idA}, "分页组", 0)
	for i := 11; i <= 14; i++ { // 4 条 msg + 1 条 roster = 5 行；limit=3
		postGroupMsg(t, testSeed, base, eventIDOf(i), gid, 1, fmt.Sprintf("dd:%02d", i), "")
	}

	status, page1 := doJSONMap(t, http.MethodGet, base+"/v1/group/"+gid+"?limit=3", "", nil)
	if status != http.StatusOK {
		t.Fatalf("第一页 status=%d out=%v", status, page1)
	}
	if events, _ := page1["events"].([]any); len(events) != 3 {
		t.Fatalf("第一页应满 3 条: %v", page1)
	}
	next, _ := page1["next_cursor"].(string)
	if next == "" {
		t.Fatalf("满页必须给 next_cursor: %v", page1)
	}

	status, page2 := doJSONMap(t, http.MethodGet, base+"/v1/group/"+gid+"?limit=3&cursor="+next, "", nil)
	if status != http.StatusOK {
		t.Fatalf("第二页 status=%d out=%v", status, page2)
	}
	if events, _ := page2["events"].([]any); len(events) != 1 {
		t.Fatalf("第二页应只剩 1 条 msg: %v", page2)
	}
	if page2["next_cursor"] != nil {
		t.Fatalf("不满页必须给 null 游标: %v", page2)
	}
}

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// rosterDomainWant 是测试侧**独立重建**的签名域常量（实现里另有一份 rosterApprovalDomain；
// 两处独立写，不一致就红——照抄实现就没有独立价值）。
const rosterDomainWant = "base/group-roster-v2"

// rosterPayloadWant 用测试侧的键集重建待签载荷（与实现同构）。
// b 里除 body 键外还必须带 event_id / created_at（多签载荷复用外层信封的这两个值）。
func rosterPayloadWant(b map[string]any) []byte {
	f := map[string]any{
		"domain":     rosterDomainWant,
		"event_id":   b["event_id"],
		"group_id":   b["group_id"],
		"action":     "roster",
		"sub":        b["sub"],
		"epoch":      b["epoch"],
		"roster_rev": b["roster_rev"],
		"member_ids": b["member_ids"],
		"encrypted":  b["encrypted"],
		"created_at": b["created_at"],
	}
	if name, ok := b["name"]; ok && name != "" {
		f["name"] = name
	}
	raw, err := protocol.Canonicalize(f)
	if err != nil {
		panic(err)
	}
	return raw
}

// approvalOf 用给定种子对载荷签名，返回 sigs 的一项。
func approvalOf(t *testing.T, seed string, payload []byte) map[string]any {
	t.Helper()
	sig, err := protocol.Sign(seed, payload)
	if err != nil {
		t.Fatal(err)
	}
	kp, err := protocol.KeyPairFromSeed(seed)
	if err != nil {
		t.Fatal(err)
	}
	id, err := protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"id": id, "sig": sig}
}

// postRosterV2 发一条 group.v1 事件：内容签名覆盖 canonical({event_id,type,created_at,body})。
// 不能用 groupEventBody——它内部用 time.Now()，而多签载荷要复用同一个 created_at。
func postRosterV2(t *testing.T, seed, baseURL, eventID string, createdAt int64, body map[string]any) (int, map[string]any) {
	t.Helper()
	payload := map[string]any{
		"event_id": eventID, "type": "group.v1",
		"created_at": createdAt, "body": body,
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
	return sendAuth(t, signedRequest(t, seed, http.MethodPost, baseURL+"/v1/event", string(raw)))
}

// submitRosterV2 先按 body 重建多签载荷并附上 sigs，再走 postRosterV2 提交。
func submitRosterV2(t *testing.T, baseURL, seed, eventID string, createdAt int64, body map[string]any, signerSeeds ...string) (int, map[string]any) {
	t.Helper()
	p := map[string]any{"event_id": eventID, "created_at": createdAt}
	for k, v := range body {
		p[k] = v
	}
	payload := rosterPayloadWant(p)
	sigs := make([]any, 0, len(signerSeeds))
	for _, s := range signerSeeds {
		sigs = append(sigs, approvalOf(t, s, payload))
	}
	body["sigs"] = sigs
	return postRosterV2(t, seed, baseURL, eventID, createdAt, body)
}

// memberSeed 返回 64 hex 的确定性种子。
func memberSeed(i int) string { return fmt.Sprintf("%064x", i+1) }

// seedGroupV2 直接写投影 + 造 1 条 msg 事件（k>1 时席位才可判定）。
// 返回 ids：ids[0] 是创建者，其余对应 memberSeed(1..m-1)。
func seedGroupV2(t *testing.T, st *store.Store, baseURL, gid, creatorSeed string, m int, encrypted int64) []string {
	t.Helper()
	ids := make([]string, 0, m)
	ids = append(ids, registerIdentitySeed(t, baseURL, creatorSeed))
	for i := 1; i < m; i++ {
		ids = append(ids, registerIdentitySeed(t, baseURL, memberSeed(i)))
	}
	membersJSON, err := json.Marshal(ids)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.PutGroupRosterV2(store.GroupRoster{
		GroupID: gid, CreatorID: ids[0], Epoch: 1, RosterRev: 1,
		Encrypted: encrypted, MemberIDsJSON: string(membersJSON), EventID: eventIDOf(900),
	}); err != nil {
		t.Fatalf("PutGroupRosterV2: %v", err)
	}
	if err := st.PutEvent(store.Event{
		EventID: eventIDOf(901), ID: ids[0], Type: "group.v1",
		BodyJSON:  `{"action":"msg","epoch":1,"group_id":"` + gid + `"}`,
		CreatedAt: 1000, ReceivedAt: 1000, TargetID: "group/" + gid,
	}); err != nil {
		t.Fatalf("PutEvent: %v", err)
	}
	return ids
}

// governorsOf 用真实派生取当前治者集合（测试要给出「够门槛的签名者」，不能靠猜名次）。
func governorsOf(t *testing.T, st *store.Store, gid string, members []string, rosterRev, epoch int64) []string {
	t.Helper()
	events, err := st.ListGroupMsgEvents(gid)
	if err != nil {
		t.Fatal(err)
	}
	return store.DeriveSeats(members, members[0], rosterRev, epoch, events).Governors
}

func TestRosterV2RemoveQuorumMissing(t *testing.T) {
	st, _, ts := newTestServer(t)
	gid := groupIDOf(101)
	ids := seedGroupV2(t, st, ts.URL, gid, testSeed, 11, 1)

	// k=3（m=11）⇒ 移出需 ⌈2k/3⌉=2 名治者签；只给创建者 1 签 ⇒ 门槛不足。
	body := map[string]any{
		"group_id": gid, "action": "roster", "sub": "remove",
		"epoch": 2, "roster_rev": 2, "member_ids": append([]string{}, ids[:10]...),
		"encrypted": 1,
	}
	status, out := submitRosterV2(t, ts.URL, testSeed, eventIDOf(1001), int64(1790000000000), body, testSeed)
	if status != http.StatusForbidden || out["code"] != "group_roster_quorum_missing" {
		t.Fatalf("want 403 group_roster_quorum_missing, got %d %v", status, out)
	}
	g, ok, err := st.GetGroup(gid)
	if err != nil || !ok || g.Epoch != 1 {
		t.Fatalf("被拒不留半态：%+v ok=%v err=%v", g, ok, err)
	}
}

func TestRosterV2DissolveQuorums(t *testing.T) {
	for _, tc := range []struct {
		name     string
		members  int
		wantCode string
	}{
		{"m=3 只给发起不给票", 3, "group_roster_quorum_missing"},
		{"m=11 只给 1 名治者发起", 11, "group_proposal_proposer_missing"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, _, ts := newTestServer(t)
			gid := groupIDOf(102)
			seedGroupV2(t, st, ts.URL, gid, testSeed, tc.members, 1)

			body := map[string]any{
				"group_id": gid, "action": "roster", "sub": "dissolve",
				"epoch": 2, "roster_rev": 2, "member_ids": []string{},
				"encrypted": 1,
			}
			status, out := submitRosterV2(t, ts.URL, testSeed, eventIDOf(1002), int64(1790000001000), body, testSeed)
			if out["code"] != tc.wantCode {
				t.Fatalf("want %s, got %d %v", tc.wantCode, status, out)
			}
		})
	}
}

func TestRosterV2DissolveQuorumSatisfied(t *testing.T) {
	st, _, ts := newTestServer(t)
	gid := groupIDOf(103)
	seedGroupV2(t, st, ts.URL, gid, testSeed, 3, 1)

	// m=3：发起 1 名治者（创建者）+ 成员 2 签（创建者 + 另 2 名成员）⇒ 通过。member_ids 传空数组。
	// Spec v2 §6 DissolveVoteQuorumV2(3,0,0)=3（enhanced 门槛 + GovernQuorum 裁切到 m），需要全 3 成员签名。
	body := map[string]any{
		"group_id": gid, "action": "roster", "sub": "dissolve",
		"epoch": 2, "roster_rev": 2, "member_ids": []string{},
		"encrypted": 1,
	}
	status, out := submitRosterV2(t, ts.URL, testSeed, eventIDOf(1003), int64(1790000002000), body, testSeed, memberSeed(1), memberSeed(2))
	if status != http.StatusOK {
		t.Fatalf("want 200, got %d %v", status, out)
	}
	g, ok, err := st.GetGroup(gid)
	if err != nil || !ok || g.MemberIDsJSON != "[]" {
		t.Fatalf("解散后名单应清空（补充 11）：%+v ok=%v err=%v", g, ok, err)
	}
}

func TestRosterV2SignerNotGovernor(t *testing.T) {
	st, _, ts := newTestServer(t)
	gid := groupIDOf(104)
	ids := seedGroupV2(t, st, ts.URL, gid, testSeed, 11, 1)
	// 已登记但不在 member_ids 里的身份：否则会先撞 identity_unregistered。
	outsiderSeed := memberSeed(500)
	registerIdentitySeed(t, ts.URL, outsiderSeed)

	body := map[string]any{
		"group_id": gid, "action": "roster", "sub": "remove",
		"epoch": 2, "roster_rev": 2, "member_ids": append([]string{}, ids[:10]...),
		"encrypted": 1,
	}
	status, out := submitRosterV2(t, ts.URL, testSeed, eventIDOf(1004), int64(1790000003000), body, testSeed, outsiderSeed)
	if out["code"] != "group_roster_quorum_missing" {
		t.Fatalf("非治者签名应被拒，得 %d %v", status, out)
	}
}

func TestRosterV2RevStale(t *testing.T) {
	st, _, ts := newTestServer(t)
	gid := groupIDOf(105)
	ids := seedGroupV2(t, st, ts.URL, gid, testSeed, 11, 1)

	govs := governorsOf(t, st, gid, ids, 1, 1)
	if len(govs) < 3 {
		t.Fatalf("m=11 应有 3 名治者，得 %v", govs)
	}
	seedByID := map[string]string{ids[0]: testSeed}
	for i := 1; i < len(ids); i++ {
		seedByID[ids[i]] = memberSeed(i)
	}
	signers := []string{testSeed}
	for _, g := range govs {
		if g == ids[0] {
			continue
		}
		signers = append(signers, seedByID[g])
		if len(signers) == 3 {
			break
		}
	}

	// epoch 递增但 roster_rev 未递增 ⇒ 409 group_roster_epoch_stale。
	// Spec v2 §6 RemoveQuorumV2(11,0,0)=13 被治者数 k=3 裁切到 3，3 个治者签名刚过 quorum 检查，
	// 但 PutGroupRosterV2 内的 rev stale 检查会在后续拒绝。
	body := map[string]any{
		"group_id": gid, "action": "roster", "sub": "remove",
		"epoch": 2, "roster_rev": 1, "member_ids": append([]string{}, ids[:10]...),
		"encrypted": 1,
	}
	status, out := submitRosterV2(t, ts.URL, testSeed, eventIDOf(1005), int64(1790000004000), body, signers...)
	if status != http.StatusConflict || out["code"] != "group_roster_epoch_stale" {
		t.Fatalf("want 409 group_roster_epoch_stale, got %d %v", status, out)
	}
	g, ok, err := st.GetGroup(gid)
	if err != nil || !ok || g.Epoch != 1 || g.RosterRev != 1 {
		t.Fatalf("被拒后投影不应改动：%+v ok=%v err=%v", g, ok, err)
	}
}

func TestRosterV2JoinOpenOnly(t *testing.T) {
	st, _, ts := newTestServer(t)
	creatorID := registerIdentitySeed(t, ts.URL, testSeed)

	// 开放圈：v1 形态建圈（无 sigs），encrypted:0
	gid := groupIDOf(106)
	status, out := postGroupBody(t, testSeed, ts.URL, eventIDOf(2001), map[string]any{
		"group_id": gid, "action": "roster", "epoch": 1,
		"member_ids": []string{creatorID}, "name": "开放组", "encrypted": 0,
	})
	if status != http.StatusOK {
		t.Fatalf("v1 开放圈建圈 status=%d out=%v", status, out)
	}
	if g, _, _ := st.GetGroup(gid); g.Encrypted != 0 {
		t.Fatalf("开放圈 encrypted 应为 0，得 %d", g.Encrypted)
	}

	joinerSeed := memberSeed(1)
	joinerID := registerIdentitySeed(t, ts.URL, joinerSeed)

	joinBody := func(epoch, rev int64, members []string) map[string]any {
		return map[string]any{
			"group_id": gid, "action": "roster", "sub": "join",
			"epoch": epoch, "roster_rev": rev, "member_ids": members,
			"encrypted": 0,
		}
	}
	status, out = submitRosterV2(t, ts.URL, joinerSeed, eventIDOf(2002), int64(1790000010000),
		joinBody(2, 2, []string{creatorID, joinerID}), joinerSeed)
	if status != http.StatusOK {
		t.Fatalf("开放圈自加入 status=%d out=%v", status, out)
	}
	g, _, _ := st.GetGroup(gid)
	var members []string
	if err := json.Unmarshal([]byte(g.MemberIDsJSON), &members); err != nil || len(members) != 2 || members[1] != joinerID {
		t.Fatalf("加入后名单异常：%v err=%v", members, err)
	}

	// 非本人签名者 ⇒ group_roster_quorum_missing（换 epoch/rev 以越过 epoch 检查）
	status, out = submitRosterV2(t, ts.URL, joinerSeed, eventIDOf(2003), int64(1790000011000),
		joinBody(3, 3, []string{creatorID, joinerID}), testSeed)
	if out["code"] != "group_roster_quorum_missing" {
		t.Fatalf("非本人签名应被拒，得 %d %v", status, out)
	}

	// 封闭圈发 join ⇒ 403 group_invite_required
	closedGID := groupIDOf(107)
	status, out = postGroupBody(t, testSeed, ts.URL, eventIDOf(2004), map[string]any{
		"group_id": closedGID, "action": "roster", "epoch": 1,
		"member_ids": []string{creatorID}, "encrypted": 1,
	})
	if status != http.StatusOK {
		t.Fatalf("封闭圈建圈 status=%d out=%v", status, out)
	}
	status, out = submitRosterV2(t, ts.URL, joinerSeed, eventIDOf(2005), int64(1790000012000), map[string]any{
		"group_id": closedGID, "action": "roster", "sub": "join",
		"epoch": 2, "roster_rev": 2, "member_ids": []string{creatorID, joinerID},
		"encrypted": 0,
	}, joinerSeed)
	if status != http.StatusForbidden || out["code"] != "group_invite_required" {
		t.Fatalf("封闭圈 join 应 403 group_invite_required，得 %d %v", status, out)
	}
}

func TestRosterV2V1EncryptedDefault(t *testing.T) {
	st, _, ts := newTestServer(t)
	creatorID := registerIdentitySeed(t, ts.URL, testSeed)

	gidOpen := groupIDOf(108)
	if status, out := postGroupBody(t, testSeed, ts.URL, eventIDOf(3001), map[string]any{
		"group_id": gidOpen, "action": "roster", "epoch": 1,
		"member_ids": []string{creatorID}, "encrypted": 0,
	}); status != http.StatusOK {
		t.Fatalf("带 encrypted:0 status=%d out=%v", status, out)
	}
	if g, _, _ := st.GetGroup(gidOpen); g.Encrypted != 0 {
		t.Fatalf("encrypted:0 应落 0，得 %d", g.Encrypted)
	}

	gidClosed := groupIDOf(109)
	if status, out := postGroupBody(t, testSeed, ts.URL, eventIDOf(3002), map[string]any{
		"group_id": gidClosed, "action": "roster", "epoch": 1,
		"member_ids": []string{creatorID},
	}); status != http.StatusOK {
		t.Fatalf("不带 encrypted status=%d out=%v", status, out)
	}
	if g, _, _ := st.GetGroup(gidClosed); g.Encrypted != 1 {
		t.Fatalf("缺省应落 1，得 %d", g.Encrypted)
	}
}

func TestRosterV2KeySetStrict(t *testing.T) {
	_, _, ts := newTestServer(t)
	registerIdentitySeed(t, ts.URL, testSeed) // 先过验签中间件，才能到 body 解析
	gid := groupIDOf(110)
	idA := groupIDOf(1)
	createdAt := int64(1790000020000)
	validSig := []any{map[string]any{"id": idA, "sig": strings.Repeat("ab", 32)}}

	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"未知键", map[string]any{
			"group_id": gid, "action": "roster", "sub": "rename",
			"epoch": 2, "roster_rev": 2, "member_ids": []string{idA},
			"encrypted": 0, "evil": 1, "sigs": validSig,
		}},
		{"未登记的 sub", map[string]any{
			"group_id": gid, "action": "roster", "sub": "kick",
			"epoch": 2, "roster_rev": 2, "member_ids": []string{idA},
			"encrypted": 0, "sigs": validSig,
		}},
		{"sigs 为空数组", map[string]any{
			"group_id": gid, "action": "roster", "sub": "rename",
			"epoch": 2, "roster_rev": 2, "member_ids": []string{idA},
			"encrypted": 0, "sigs": []any{},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, out := postRosterV2(t, testSeed, ts.URL, eventIDOf(4001), createdAt, tc.body)
			if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
				t.Fatalf("want 400 event_param_invalid, got %d %v", status, out)
			}
		})
	}
}

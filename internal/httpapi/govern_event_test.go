package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// govEventNode 是治理事件验收用的节点：客户端监听与对端监听分开登记。
type govEventNode struct {
	st     *store.Store
	public string
	peer   string
}

// newGovEventNode 起一个真 httpapi 节点（进程内），预登记 A/B/C/D/X 五个身份。
func newGovEventNode(t *testing.T) *govEventNode {
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
	peer := newInprocServer(srv.PeerHandler())
	t.Cleanup(pub.Close)
	t.Cleanup(peer.Close)
	n := &govEventNode{st: st, public: pub.URL, peer: peer.URL}
	for _, seed := range []string{govSeedA, govSeedB, govSeedC, govSeedD, govSeedX} {
		id, pk := identityFromSeed(t, seed)
		if status, body := doIdentityJSON(t, http.MethodPost, n.public+"/v1/identity/register", "", registerBody(id, pk)); status != http.StatusOK {
			t.Fatalf("登记身份 %s status=%d body=%v", id, status, body)
		}
	}
	return n
}

// publish 用 seed 投一篇 ≥200 rune 的 article（供名册派生）。
func (n *govEventNode) publish(t *testing.T, seed, itemID, title string) {
	t.Helper()
	body := title + repeat("文", 200)
	code, out := sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit",
		submitBody(t, seed, "article", itemID, title, "body_md", body)))
	if code != http.StatusOK {
		t.Fatalf("投稿 %s 失败: code=%d out=%v", itemID, code, out)
	}
}

// postGovernEvent 发一条 govern.v1 事件：内容签名覆盖 canonical({event_id,type,created_at,body})。
// 与 core/group.ts 的 buildEventWire 逐字同构（复用通用事件内容签名，无签名域分隔）。
func postGovernEvent(t *testing.T, seed, baseURL, eventID string, createdAt int64, body map[string]any) (int, map[string]any) {
	t.Helper()
	payload := map[string]any{
		"event_id": eventID, "type": "govern.v1",
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

// drainGovernFromPeer 拉对端一整轮 event-sync 并把事件落进 dst（含 govern.v1 投影）。
//
// 这是 peersync.applySyncedGovernEvent 的**测试镜像**：httpapi 包不能 import peersync
// （peersync → httpapi 成环），故这里复刻同一条落库 + 投影路径，验证「B 只靠 A 的事件收敛」。
func drainGovernFromPeer(t *testing.T, peerURL string, dst *store.Store) []map[string]any {
	t.Helper()
	code, out := doJSONMap(t, http.MethodPost, peerURL+"/v1/event-sync", `{"kind":"event"}`, nil)
	if code != http.StatusOK {
		t.Fatalf("event-sync status=%d out=%v", code, out)
	}
	items, _ := out["items"].([]any)
	mirrored := make([]map[string]any, 0, len(items))
	for _, raw := range items {
		it, _ := raw.(map[string]any)
		eventID, _ := it["event_id"].(string)
		actor, _ := it["id"].(string)
		typ, _ := it["type"].(string)
		bodyJSON, _ := it["body_json"].(string)
		createdAt := int64(it["created_at"].(float64))
		if err := dst.PutEvent(store.Event{
			EventID: eventID, ID: actor, Type: typ, BodyJSON: bodyJSON,
			CreatedAt: createdAt, ReceivedAt: time.Now().UnixMilli(),
		}); err != nil {
			t.Fatalf("PutEvent: %v", err)
		}
		mirrored = append(mirrored, it)
		if typ != "govern.v1" {
			continue
		}
		var m struct {
			Action         string `json:"action"`
			ProposalID     string `json:"proposal_id"`
			TargetItemID   string `json:"target_item_id"`
			Verb           string `json:"verb"`
			ContentHash    string `json:"content_hash"`
			ContentVersion int64  `json:"content_version"`
			RevokedRev     int64  `json:"revoked_rev"`
			Reason         string `json:"reason"`
			Title          string `json:"title"`
			BodyMD         string `json:"body_md"`
			Choice         string `json:"choice"`
		}
		if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil || m.ProposalID == "" {
			continue
		}
		pid, ok := parseProposalID(m.ProposalID)
		if !ok {
			continue
		}
		switch m.Action {
		case "proposal":
			if err := dst.ProjectGovernProposal(store.GovernProposalEvent{
				ProposalID: pid, TargetItemID: m.TargetItemID, Verb: m.Verb, ContentHash: m.ContentHash,
				Reason: m.Reason, Title: m.Title, BodyMD: m.BodyMD,
				ContentVersion: m.ContentVersion, RevokedRev: m.RevokedRev,
				CreatedAt: createdAt, EventID: eventID, Actor: actor,
			}); err != nil && err != store.ErrGovernEventConflict {
				t.Fatalf("ProjectGovernProposal: %v", err)
			}
		case "vote":
			if err := dst.ProjectGovernVote(store.GovernVoteEvent{
				ProposalID: pid, Choice: m.Choice,
				CreatedAt: createdAt, EventID: eventID, Actor: actor,
			}); err != nil {
				t.Fatalf("ProjectGovernVote: %v", err)
			}
		default:
			continue
		}
		// **必须与 applySyncedGovernEvent 的真实行为一致**：投影后 settle（proposal / vote 两支都要）。
		// 镜像失真会让 AC 11 等用例验不到事件路径的生效闭环（缺陷 1 的洞）。
		if err := dst.SettleGovernProposal(pid, testRoster(t, dst)); err != nil {
			t.Fatalf("SettleGovernProposal: %v", err)
		}
	}
	return mirrored
}

// testRoster 复刻 peersync 从 ContributorRoster 派生名册（map[string]bool）的口径。
func testRoster(t *testing.T, st *store.Store) map[string]bool {
	t.Helper()
	rows, err := st.ContributorRoster()
	if err != nil {
		t.Fatalf("ContributorRoster: %v", err)
	}
	set := make(map[string]bool, len(rows))
	for _, c := range rows {
		set[c.ID] = true
	}
	return set
}

// rosterCount 读匿名名册里某个 id 的条数；不在名册返回 0（govEventNode 用）。
func (n *govEventNode) rosterCount(t *testing.T, id string) int {
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

// targetItem 读某条目的 (content_hash, state)，供事件体带上乐观锁哈希。
func (n *govEventNode) targetItem(t *testing.T, itemID string) (hash, state string) {
	t.Helper()
	it, ok, err := n.st.GetItem(itemID)
	if err != nil || !ok {
		t.Fatalf("GetItem %s: ok=%v err=%v", itemID, ok, err)
	}
	return it.ContentHash, it.State
}

// proposalListRaw 拉匿名提案列表的原始 JSON（逐字比较用）。
func proposalListRaw(t *testing.T, baseURL string) string {
	t.Helper()
	code, raw := doRaw(t, http.MethodGet, baseURL+"/v1/proposal", "", nil)
	if code != http.StatusOK {
		t.Fatalf("GET /v1/proposal status=%d raw=%s", code, raw)
	}
	return string(raw)
}

// AC 11：两台节点**只靠反熵**（不做包导出 / 导入）收敛到同一提案结论。
//
// 说明：接收侧投影在这里用 drainGovernFromPeer 复刻（httpapi 不能 import peersync 成环），
// 但 B 的投影数据**全部来自 A 的 event-sync 事件**，不重新投递，故仍是「只靠反熵收敛」。
func TestGovernEventConvergesViaAntiEntropy(t *testing.T) {
	a := newGovEventNode(t)
	b := newGovEventNode(t)
	for _, n := range []*govEventNode{a, b} {
		n.publish(t, govSeedA, "article/ga", "甲")
		n.publish(t, govSeedC, "article/gc", "丙")
	}

	t1 := time.Now().UnixMilli()
	// A 提一条提案事件（提案人自投第 1 票），C 投一条票事件；两者都投给 A。
	proposal := map[string]any{
		"action": "proposal", "proposal_id": "1", "target_item_id": "article/x",
		"verb": "remove", "content_hash": "abcd", "content_version": 1, "revoked_rev": 0,
	}
	if code, out := postGovernEvent(t, govSeedA, a.public, eventIDOf(11), t1, proposal); code != http.StatusOK {
		t.Fatalf("提案事件 code=%d out=%v", code, out)
	}
	vote := map[string]any{"action": "vote", "proposal_id": "1", "choice": "yes"}
	if code, out := postGovernEvent(t, govSeedC, a.public, eventIDOf(12), t1+1, vote); code != http.StatusOK {
		t.Fatalf("投票事件 code=%d out=%v", code, out)
	}

	mirrored := drainGovernFromPeer(t, a.peer, b.st)
	got := 0
	for _, it := range mirrored {
		if it["type"] == "govern.v1" {
			got++
		}
	}
	if got != 2 {
		t.Fatalf("A 的 event-sync 应带出 2 条 govern.v1，得 %d（%v）", got, mirrored)
	}

	if ra, rb := proposalListRaw(t, a.public), proposalListRaw(t, b.public); ra != rb {
		t.Fatalf("两台节点未收敛:\nA=%s\nB=%s", ra, rb)
	}
	// 收敛后两边都是：1 条提案、2 张有效票（A 自投 + C）。
	code, body := getJSON(t, b.public+"/v1/proposal")
	if code != http.StatusOK {
		t.Fatalf("B 列表 code=%d", code)
	}
	list, _ := body["proposals"].([]any)
	if len(list) != 1 {
		t.Fatalf("B 应有 1 条提案: %v", body)
	}
	p, _ := list[0].(map[string]any)
	// status 必须一并断言（原先只比 vote_count / item_id，正是这个洞当年没被照出的原因之一）：
	// 本用例 2 票 < remove 门槛 3 ⇒ 事件路径 settle 后仍应停在 pending。
	if p["vote_count"] != float64(2) || p["item_id"] != "article/x" || p["status"] != "pending" {
		t.Fatalf("B 提案形状: %v", p)
	}
}

// 事件路径攒够门槛 → **生效且受审动作真的执行**（补住 AC 11 照不出的缺陷 1）。
//
// 用 remove（门槛 3）：名册 A/B/C/D，A 提案（自投第 1 票）+ C + D 三票达门槛，
// 目标 article/gb 必须真的被退役（墓碑 + state=removed）。
func TestGovernEventQuorumSettlesAction(t *testing.T) {
	n := newGovEventNode(t)
	for _, s := range []struct{ seed, item, title string }{
		{govSeedA, "article/ga", "甲"}, {govSeedB, "article/gb", "乙"},
		{govSeedC, "article/gc", "丙"}, {govSeedD, "article/gd", "丁"},
	} {
		n.publish(t, s.seed, s.item, s.title)
	}
	hash, _ := n.targetItem(t, "article/gb")
	t1 := time.Now().UnixMilli()
	if code, out := postGovernEvent(t, govSeedA, n.public, eventIDOf(31), t1, map[string]any{
		"action": "proposal", "proposal_id": "1", "target_item_id": "article/gb",
		"verb": "remove", "content_hash": hash, "content_version": 0, "revoked_rev": 0,
	}); code != http.StatusOK {
		t.Fatalf("提案事件 code=%d out=%v", code, out)
	}
	for i, seed := range []string{govSeedC, govSeedD} {
		if code, out := postGovernEvent(t, seed, n.public, eventIDOf(32+i), t1+int64(i)+1,
			map[string]any{"action": "vote", "proposal_id": "1", "choice": "yes"}); code != http.StatusOK {
			t.Fatalf("投票事件 %s code=%d out=%v", seed, code, out)
		}
	}
	list := proposalListOf(t, n.public)
	if len(list) != 1 || list[0]["status"] != "effective" || list[0]["vote_count"] != float64(3) {
		t.Fatalf("攒够门槛应生效: %v", list)
	}
	// 受审动作真的执行了：目标条目已被退役。
	if _, state := n.targetItem(t, "article/gb"); state != "removed" {
		t.Fatalf("remove 未落地: article/gb state=%q", state)
	}
	rev, ok := tombstoneRev(t, n.st, "article/gb")
	if !ok || rev <= 0 {
		t.Fatalf("remove 应写墓碑: rev=%d ok=%v", rev, ok)
	}
}

// 反熵**乱序**：vote 事件先于 proposal 事件到达，仍能生效（proposal / vote 两支都 settle）。
func TestGovernEventOutOfOrderSettle(t *testing.T) {
	a := newGovEventNode(t)
	b := newGovEventNode(t)
	for _, n := range []*govEventNode{a, b} {
		n.publish(t, govSeedA, "article/ga", "甲")
		n.publish(t, govSeedB, "article/gb", "乙")
		n.publish(t, govSeedC, "article/gc", "丙")
	}
	hash, _ := a.targetItem(t, "article/gb")
	t1 := time.Now().UnixMilli()
	// 先落 vote（C 先投），再落 proposal——乱序。
	if code, out := postGovernEvent(t, govSeedC, a.public, eventIDOf(33), t1,
		map[string]any{"action": "vote", "proposal_id": "1", "choice": "yes"}); code != http.StatusOK {
		t.Fatalf("投票事件 code=%d out=%v", code, out)
	}
	if code, out := postGovernEvent(t, govSeedA, a.public, eventIDOf(34), t1+1, map[string]any{
		"action": "proposal", "proposal_id": "1", "target_item_id": "article/gb",
		"verb": "edit", "content_hash": hash, "content_version": 0, "revoked_rev": 0,
		"title": "乱序新题", "body_md": "乱序" + repeat("文", 200),
	}); code != http.StatusOK {
		t.Fatalf("提案事件 code=%d out=%v", code, out)
	}
	if list := proposalListOf(t, a.public); len(list) != 1 || list[0]["status"] != "effective" {
		t.Fatalf("A 乱序后应生效: %v", list)
	}
	// B 只靠反熵（对端镜像）收敛，同样要生效。
	drainGovernFromPeer(t, a.peer, b.st)
	if list := proposalListOf(t, b.public); len(list) != 1 || list[0]["status"] != "effective" {
		t.Fatalf("B 反熵乱序后应生效: %v", list)
	}
}

// 同一批 govern.v1 事件**重放**（第二轮 drainGovernFromPeer 全量重拉）不重复执行动作。
func TestGovernEventReplayNoDoubleAction(t *testing.T) {
	a := newGovEventNode(t)
	b := newGovEventNode(t)
	for _, n := range []*govEventNode{a, b} {
		n.publish(t, govSeedA, "article/ga", "甲")
		n.publish(t, govSeedB, "article/gb", "乙")
		n.publish(t, govSeedC, "article/gc", "丙")
	}
	hash, _ := a.targetItem(t, "article/gb")
	t1 := time.Now().UnixMilli()
	if code, out := postGovernEvent(t, govSeedA, a.public, eventIDOf(35), t1, map[string]any{
		"action": "proposal", "proposal_id": "1", "target_item_id": "article/gb",
		"verb": "edit", "content_hash": hash, "content_version": 0, "revoked_rev": 0,
		"title": "重放新题", "body_md": "重放" + repeat("文", 200),
	}); code != http.StatusOK {
		t.Fatalf("提案事件 code=%d out=%v", code, out)
	}
	if code, out := postGovernEvent(t, govSeedC, a.public, eventIDOf(36), t1+1,
		map[string]any{"action": "vote", "proposal_id": "1", "choice": "yes"}); code != http.StatusOK {
		t.Fatalf("投票事件 code=%d out=%v", code, out)
	}

	// 第一轮：B 收敛并生效（edit 改动正文 ⇒ 清归属）。
	drainGovernFromPeer(t, a.peer, b.st)
	first, ok, err := b.st.GetProposal(1)
	if err != nil || !ok {
		t.Fatalf("GetProposal: ok=%v err=%v", ok, err)
	}
	if first.ExecutedAt == 0 || first.ExecutedResult != "edited_author_cleared" {
		t.Fatalf("首次应生效并记 executed: %+v", first)
	}
	// 第二轮：事件全量重拉（镜像不带游标）——投影幂等 + settle 幂等，动作不得重复执行。
	drainGovernFromPeer(t, a.peer, b.st)
	second, _, _ := b.st.GetProposal(1)
	if second.ExecutedAt != first.ExecutedAt || second.ExecutedResult != first.ExecutedResult || second.VoidedAt != 0 {
		t.Fatalf("重放不得重复执行: first=%+v second=%+v", first, second)
	}
	if list := proposalListOf(t, b.public); len(list) != 1 || list[0]["status"] != "effective" || list[0]["voided_at"] != float64(0) {
		t.Fatalf("重放后形状: %v", list)
	}
}

// tombstoneRev 读某条目的墓碑 revoked_rev；ok=false 表示没有墓碑。
func tombstoneRev(t *testing.T, st *store.Store, itemID string) (int64, bool) {
	t.Helper()
	rows, err := st.ListTombstones()
	if err != nil {
		t.Fatalf("ListTombstones: %v", err)
	}
	for _, r := range rows {
		if r.ItemID == itemID {
			return int64(r.RevokedRev), true
		}
	}
	return 0, false
}

// AC 12：提案建立后名册变化，结论**不改判**（按快照水位复算稳定）。
//
// 走**事件路径**（原版走老路径 n.propose / n.vote，恰是它当年没照出「事件路径从不写 executed_at」
// 的原因）。语义不变：名册 A/B/C/D，A 提 edit（门槛 2）、C 投第 2 票 → 生效；随后让 C 落榜，结论不改判。
func TestGovernEventVoteQuorumSnapshotWatermark(t *testing.T) {
	n := newGovEventNode(t)
	for _, s := range []struct{ seed, item, title string }{
		{govSeedA, "article/ga", "甲"}, {govSeedB, "article/gb", "乙"},
		{govSeedC, "article/gc", "丙"}, {govSeedD, "article/gd", "丁"},
	} {
		n.publish(t, s.seed, s.item, s.title)
	}
	hash, _ := n.targetItem(t, "article/gb")
	t1 := time.Now().UnixMilli()
	if code, out := postGovernEvent(t, govSeedA, n.public, eventIDOf(41), t1, map[string]any{
		"action": "proposal", "proposal_id": "1", "target_item_id": "article/gb",
		"verb": "edit", "content_hash": hash, "content_version": 0, "revoked_rev": 0,
		// 正文与原 gb 逐字节相同（只改标题）⇒ 作者归属保留，后续 C 落榜的水位语义更干净。
		"title": "新标题", "body_md": "乙" + repeat("文", 200),
	}); code != http.StatusOK {
		t.Fatalf("提案事件 code=%d out=%v", code, out)
	}
	if code, out := postGovernEvent(t, govSeedC, n.public, eventIDOf(42), t1+1,
		map[string]any{"action": "vote", "proposal_id": "1", "choice": "yes"}); code != http.StatusOK {
		t.Fatalf("投票事件 code=%d out=%v", code, out)
	}
	before := proposalListOf(t, n.public)
	if len(before) != 1 || before[0]["vote_count"] != float64(2) || before[0]["status"] != "effective" {
		t.Fatalf("事件路径提满门槛应生效: %v", before)
	}

	// 推高 content_version 并让 C「落榜」：退役 C 的条目（写墓碑 + state=removed）。
	rev, err := n.st.NextContentVersion()
	if err != nil {
		t.Fatalf("NextContentVersion: %v", err)
	}
	if err := n.st.RetireItem("article/gc", rev); err != nil {
		t.Fatalf("RetireItem: %v", err)
	}
	if got := n.rosterCount(t, mustID(t, govSeedC)); got != 0 {
		t.Fatalf("C 应已从当前名册落榜，得 %d", got)
	}

	// 快照水位复算：结论不改判（C 在水位下仍在名册内，票不消失）。
	after := proposalListOf(t, n.public)
	if len(after) != 1 || after[0]["vote_count"] != float64(2) || after[0]["status"] != "effective" {
		t.Fatalf("AC12 水位复算应不改判: %v", after)
	}
}

// 冲突收敛：同 proposal_id 的并发提案取 (created_at, event_id) 首个；第二个只告知不报错。
func TestGovernEventConflictFirstWins(t *testing.T) {
	n := newGovEventNode(t)
	base := func(target string) map[string]any {
		return map[string]any{
			"action": "proposal", "proposal_id": "7", "target_item_id": target,
			"verb": "remove", "content_hash": "abcd", "content_version": 1, "revoked_rev": 0,
		}
	}
	t0 := time.Now().UnixMilli()
	code, out := postGovernEvent(t, govSeedA, n.public, eventIDOf(21), t0, base("article/first"))
	if code != http.StatusOK || out["conflict"] != false {
		t.Fatalf("首条提案 code=%d out=%v", code, out)
	}
	// 同 proposal_id、不同 body、更晚的 (created_at, event_id) → 冲突，不覆盖。
	code, out = postGovernEvent(t, govSeedA, n.public, eventIDOf(22), t0+1, base("article/second"))
	if code != http.StatusOK || out["conflict"] != true {
		t.Fatalf("冲突提案 code=%d out=%v", code, out)
	}
	// 同一条事件重放 → 幂等，不算冲突。
	code, out = postGovernEvent(t, govSeedA, n.public, eventIDOf(21), t0, base("article/first"))
	if code != http.StatusOK || out["conflict"] != false {
		t.Fatalf("幂等重放 code=%d out=%v", code, out)
	}

	list := proposalListOf(t, n.public)
	if len(list) != 1 || list[0]["item_id"] != "article/first" {
		t.Fatalf("应展示首条胜出的提案: %v", list)
	}
}

// 补充 14 护栏：老路径不产事件（否则就是节点代用户产签名事件）。
func TestOldProposalPathProducesNoGovernEvent(t *testing.T) {
	n := newGovEventNode(t)
	n.publish(t, govSeedA, "article/ga", "甲")
	n.publish(t, govSeedB, "article/gb", "乙")

	// 老路径建一条提案并投一票。
	code, out := sendAuth(t, signedRequest(t, govSeedA, http.MethodPost, n.public+"/v1/proposal",
		proposalBody(t, "remove", "article/gb", nil)))
	if code != http.StatusCreated {
		t.Fatalf("老路径提案 code=%d out=%v", code, out)
	}
	pid, _ := out["proposal_id"].(string)
	if code, out = sendAuth(t, signedRequest(t, govSeedB, http.MethodPost, n.public+"/v1/proposal/"+pid+"/vote", "")); code != http.StatusOK {
		t.Fatalf("老路径投票 code=%d out=%v", code, out)
	}

	// 事件流里不得出现任何 govern.v1 行。
	mirrored := drainGovernFromPeer(t, n.peer, n.st)
	for _, it := range mirrored {
		if it["type"] == "govern.v1" {
			t.Fatalf("老路径产出了 govern.v1 事件: %v", it)
		}
	}
	// 投影路径没坏：老路径的提案仍可读。
	list := proposalListOf(t, n.public)
	if len(list) != 1 || list[0]["item_id"] != "article/gb" || list[0]["vote_count"] != float64(2) {
		t.Fatalf("老路径读接口应仍可读到提案: %v", list)
	}
}

// proposalListOf 读匿名提案列表为 []map。
func proposalListOf(t *testing.T, baseURL string) []map[string]any {
	t.Helper()
	code, body := getJSON(t, baseURL+"/v1/proposal")
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

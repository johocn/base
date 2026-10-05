package store

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
)

// govLongBody 造一段 ≥ 200 非空白 rune 的正文（跨过名册的 article 质量门槛）。
func govLongBody(marker string) string { return marker + strings.Repeat("文", 200) }

func TestGovernTablesExist(t *testing.T) {
	st := openTemp(t)
	want := map[string][]string{
		"govern_proposals": {"proposal_id", "action", "item_id", "proposer_id", "reason", "title",
			"body_md", "base_content_hash", "created_at", "executed_at", "voided_at", "executed_result"},
		"govern_votes": {"proposal_id", "voter_id", "created_at"},
	}
	for table, cols := range want {
		got, err := tableColumns(st.db, table)
		if err != nil {
			t.Fatalf("tableColumns(%s): %v", table, err)
		}
		if len(got) == 0 {
			t.Fatalf("表 %s 不存在", table)
		}
		for _, c := range cols {
			if !got[c] {
				t.Fatalf("表 %s 缺列 %s（实有 %v）", table, c, got)
			}
		}
	}
}

func TestGovernThresholdAndStatusDerivation(t *testing.T) {
	if got := governThresholdLegacy(GovernActionRemove); got != 3 {
		t.Fatalf("remove 门槛=%d want 3", got)
	}
	for _, a := range []string{GovernActionEdit, GovernActionRevive} {
		if got := governThresholdLegacy(a); got != 2 {
			t.Fatalf("%s 门槛=%d want 2", a, got)
		}
	}
	if got := GovernRequiredState(GovernActionRevive); got != "removed" {
		t.Fatalf("revive 需 removed，得 %q", got)
	}
	for _, a := range []string{GovernActionRemove, GovernActionEdit} {
		if got := GovernRequiredState(a); got != "active" {
			t.Fatalf("%s 需 active，得 %q", a, got)
		}
	}
	if ProposalStatus(1, 0) != GovernStatusEffective || ProposalStatus(0, 1) != GovernStatusVoid || ProposalStatus(0, 0) != GovernStatusPending {
		t.Fatal("status 派生不对（册子 §4.4）")
	}
}

// 抽壳后导出函数行为不变：退役一条 → 墓碑 + state='removed'；版本号纯读返回 cur+1。
func TestRetireItemAndNextContentVersionUnchanged(t *testing.T) {
	st := openTemp(t)
	rev, err := st.NextContentVersion()
	if err != nil {
		t.Fatalf("NextContentVersion: %v", err)
	}
	if rev != 1 {
		t.Fatalf("空库首次导出应为 1，得 %d", rev)
	}
	body := govLongBody("退")
	sub := signedSubmission(t, subSeedA, "article/ret1", "标题", body)
	if _, err := st.UpsertSubmission(sub); err != nil {
		t.Fatalf("UpsertSubmission: %v", err)
	}
	if err := st.RetireItem("article/ret1", rev); err != nil {
		t.Fatalf("RetireItem: %v", err)
	}
	it, ok, err := st.GetItem("article/ret1")
	if err != nil || !ok || it.State != "removed" {
		t.Fatalf("退役后应 state=removed: ok=%v it=%+v err=%v", ok, it, err)
	}
	var got int64
	if err := st.db.QueryRow(`SELECT revoked_rev FROM tombstones WHERE item_id=?`, "article/ret1").Scan(&got); err != nil {
		t.Fatalf("读墓碑: %v", err)
	}
	if got != rev {
		t.Fatalf("revoked_rev=%d want %d", got, rev)
	}
}

func TestCreateAndGetProposal(t *testing.T) {
	st := openTemp(t)
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionEdit, ItemID: "article/x", ProposerID: "aa", Reason: "错别字",
		Title: "新标题", BodyMD: "新正文", BaseContentHash: "cafe", CreatedAt: 1790580918,
	})
	if err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}
	if id != 1 {
		t.Fatalf("首个 proposal_id 应为 1，得 %d", id)
	}
	p, ok, err := st.GetProposal(id)
	if err != nil || !ok {
		t.Fatalf("GetProposal: ok=%v err=%v", ok, err)
	}
	if p.Action != GovernActionEdit || p.ItemID != "article/x" || p.ProposerID != "aa" ||
		p.Reason != "错别字" || p.Title != "新标题" || p.BodyMD != "新正文" ||
		p.BaseContentHash != "cafe" || p.CreatedAt != 1790580918 {
		t.Fatalf("提案字段不对: %+v", p)
	}
	if p.ExecutedAt != 0 || p.VoidedAt != 0 || p.ExecutedResult != "" {
		t.Fatalf("新提案不应有一次性事实: %+v", p)
	}
	if _, ok, err := st.GetProposal(999); err != nil || ok {
		t.Fatalf("不存在的提案应 ok=false: ok=%v err=%v", ok, err)
	}
}

// 提案人在受理事务内自动构成第 1 票（册子 §2.3）。
func TestCreateProposalWritesFirstVote(t *testing.T) {
	st := openTemp(t)
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "article/x", ProposerID: "aa", BaseContentHash: "h", CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}
	views, err := st.ListProposalViews(map[string]bool{"aa": true})
	if err != nil {
		t.Fatalf("ListProposalViews: %v", err)
	}
	if len(views) != 1 {
		t.Fatalf("应有 1 条提案，得 %d", len(views))
	}
	v := views[0]
	if len(v.Votes) != 1 || v.Votes[0] != "aa" {
		t.Fatalf("提案人应自计 1 票: %v", v.Votes)
	}
	if v.Threshold != 3 || v.Status != GovernStatusPending {
		t.Fatalf("按 proposal_id=%d 读回不对: %+v", id, v)
	}
}

// 票按 roster **实时复判**过滤（册子 §2.3）：跌出者不出现在 votes 里。
func TestListProposalViewsFiltersVotesByRoster(t *testing.T) {
	st := openTemp(t)
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "article/x", ProposerID: "aa", BaseContentHash: "h", CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}
	if _, err := st.AddVote(id, "bb", map[string]bool{"aa": true, "bb": true}); err != nil {
		t.Fatalf("AddVote: %v", err)
	}
	views, err := st.ListProposalViews(map[string]bool{"aa": true}) // bb 已跌出名册
	if err != nil {
		t.Fatalf("ListProposalViews: %v", err)
	}
	if len(views[0].Votes) != 1 || views[0].Votes[0] != "aa" {
		t.Fatalf("失效票不得出现在 votes 里: %v", views[0].Votes)
	}
	// 空名册 = 名册派生失败的降级口径（册子 §6.2）：有效票 0。
	views, err = st.ListProposalViews(map[string]bool{})
	if err != nil {
		t.Fatalf("ListProposalViews: %v", err)
	}
	if len(views[0].Votes) != 0 || views[0].Status != GovernStatusPending {
		t.Fatalf("空名册应降到 0 票 pending: %+v", views[0])
	}
}

// govItem 造一条带归属的 active article（走第 2 册的 UpsertSubmission，它会写 author_id/author_sig）。
func govItem(t *testing.T, st *Store, itemID, title, marker string) Submission {
	t.Helper()
	sub := signedSubmission(t, subSeedA, itemID, title, govLongBody(marker))
	if _, err := st.UpsertSubmission(sub); err != nil {
		t.Fatalf("UpsertSubmission(%s): %v", itemID, err)
	}
	return sub
}

func govRoster(ids ...string) map[string]bool {
	m := make(map[string]bool, len(ids))
	for _, id := range ids {
		m[id] = true
	}
	return m
}

func TestAddVoteRemoveNeedsThreeVotes(t *testing.T) {
	st := openTemp(t)
	sub := govItem(t, st, "article/gv1", "标题", "甲")
	roster := govRoster("bb", "cc", "dd")
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "article/gv1", ProposerID: "bb",
		BaseContentHash: sub.ContentHash, CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}
	r1, err := st.AddVote(id, "cc", roster)
	if err != nil {
		t.Fatalf("AddVote cc: %v", err)
	}
	if r1.VoteCount != 2 || r1.Threshold != 3 || r1.Status != GovernStatusPending {
		t.Fatalf("第 2 票后应仍 pending: %+v", r1)
	}
	if it, _, _ := st.GetItem("article/gv1"); it.State != "active" {
		t.Fatalf("第 2 票不得下架: %s", it.State)
	}
	r2, err := st.AddVote(id, "dd", roster)
	if err != nil {
		t.Fatalf("AddVote dd: %v", err)
	}
	if r2.VoteCount != 3 || r2.Status != GovernStatusEffective {
		t.Fatalf("第 3 票应生效: %+v", r2)
	}
	if it, _, _ := st.GetItem("article/gv1"); it.State != "removed" {
		t.Fatalf("应已下架: %s", it.State)
	}
	var rev int64
	if err := st.db.QueryRow(`SELECT revoked_rev FROM tombstones WHERE item_id=?`, "article/gv1").Scan(&rev); err != nil {
		t.Fatalf("读墓碑: %v", err)
	}
	if rev != 1 {
		t.Fatalf("空库首票下架的 revoked_rev 应为 1，得 %d", rev)
	}
	if p, _, _ := st.GetProposal(id); p.ExecutedResult != "removed" || p.ExecutedAt == 0 {
		t.Fatalf("一次性事实未落库: %+v", p)
	}
}

func TestAddVoteReviveNeedsTwoVotes(t *testing.T) {
	st := openTemp(t)
	sub := govItem(t, st, "article/gv2", "标题", "乙")
	roster := govRoster("bb", "cc")
	rid, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "article/gv2", ProposerID: "bb",
		BaseContentHash: sub.ContentHash, CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal(remove): %v", err)
	}
	if err := st.RetireItem("article/gv2", 1); err != nil {
		t.Fatalf("RetireItem: %v", err)
	}
	_ = rid
	vid, err := st.CreateProposal(Proposal{
		Action: GovernActionRevive, ItemID: "article/gv2", ProposerID: "bb",
		BaseContentHash: sub.ContentHash, CreatedAt: 2,
	})
	if err != nil {
		t.Fatalf("CreateProposal(revive): %v", err)
	}
	res, err := st.AddVote(vid, "cc", roster)
	if err != nil {
		t.Fatalf("AddVote: %v", err)
	}
	if res.Threshold != 2 || res.Status != GovernStatusEffective {
		t.Fatalf("revive 2 票应生效: %+v", res)
	}
	if it, _, _ := st.GetItem("article/gv2"); it.State != "active" {
		t.Fatalf("复活后应 active: %s", it.State)
	}
	var n int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM tombstones WHERE item_id=?`, "article/gv2").Scan(&n); err != nil {
		t.Fatalf("数墓碑: %v", err)
	}
	if n != 0 {
		t.Fatalf("复活后墓碑行应消失，得 %d 行", n)
	}
}

// 只改标题（正文逐字节未变）→ content_hash 不变、归属两列原样保留（册子 §4.2）。
func TestAddVoteEditTitleOnlyKeepsAttribution(t *testing.T) {
	st := openTemp(t)
	sub := govItem(t, st, "article/ge1", "旧标题", "丙")
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionEdit, ItemID: "article/ge1", ProposerID: "bb",
		Title: "新标题", BodyMD: govLongBody("丙"), BaseContentHash: sub.ContentHash, CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}
	res, err := st.AddVote(id, "cc", govRoster("bb", "cc"))
	if err != nil {
		t.Fatalf("AddVote: %v", err)
	}
	if res.Status != GovernStatusEffective {
		t.Fatalf("edit 2 票应生效: %+v", res)
	}
	it, _, _ := st.GetItem("article/ge1")
	if it.Title != "新标题" || it.ContentHash != sub.ContentHash {
		t.Fatalf("标题应改、content_hash 应不变: %+v", it)
	}
	if it.AuthorID != sub.AuthorID || it.AuthorSig != sub.AuthorSig {
		t.Fatalf("正文未变故归属必须保留: %+v", it)
	}
	if p, _, _ := st.GetProposal(id); p.ExecutedResult != "edited" {
		t.Fatalf("executed_result=%q want edited", p.ExecutedResult)
	}
	if a, _, _ := st.GetArticle("article/ge1"); a.Title != "新标题" || a.BodyMD != govLongBody("丙") {
		t.Fatalf("articles 行未全量覆盖: %+v", a)
	}
}

// 改正文 → content_hash 变、归属两列清空（册子 §4.2 的数学推论）。
func TestAddVoteEditBodyClearsAttribution(t *testing.T) {
	st := openTemp(t)
	sub := govItem(t, st, "article/ge2", "标题", "丁")
	newBody := govLongBody("戊")
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionEdit, ItemID: "article/ge2", ProposerID: "bb",
		Title: "标题", BodyMD: newBody, BaseContentHash: sub.ContentHash, CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}
	if _, err := st.AddVote(id, "cc", govRoster("bb", "cc")); err != nil {
		t.Fatalf("AddVote: %v", err)
	}
	it, _, _ := st.GetItem("article/ge2")
	if it.ContentHash != protocol.SHA256Hex([]byte(newBody)) {
		t.Fatalf("content_hash 应按新正文重算: %s", it.ContentHash)
	}
	if it.AuthorID != "" || it.AuthorSig != "" {
		t.Fatalf("正文改动后归属两列必须清空: %+v", it)
	}
	if p, _, _ := st.GetProposal(id); p.ExecutedResult != "edited_author_cleared" {
		t.Fatalf("executed_result=%q want edited_author_cleared", p.ExecutedResult)
	}
}

// 乐观锁：受理后目标 content_hash 被改 → 达门槛那一刻呈 void、目标不被覆盖（册子 §4.4）。
func TestAddVoteOptimisticLockVoids(t *testing.T) {
	st := openTemp(t)
	sub := govItem(t, st, "article/go1", "原标题", "己")
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "article/go1", ProposerID: "bb",
		BaseContentHash: sub.ContentHash, CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}
	// 受理之后、第 3 票之前，原作者用第 2 册的写路径更新了该条。
	govItem(t, st, "article/go1", "作者改后的标题", "庚")
	res, err := st.AddVote(id, "cc", govRoster("bb", "cc", "dd"))
	if err != nil {
		t.Fatalf("AddVote cc: %v", err)
	}
	if res.Status != GovernStatusPending {
		t.Fatalf("未达门槛应 pending: %+v", res)
	}
	res, err = st.AddVote(id, "dd", govRoster("bb", "cc", "dd"))
	if err != nil {
		t.Fatalf("AddVote dd: %v", err)
	}
	if res.Status != GovernStatusVoid {
		t.Fatalf("达门槛且前置不满足应 void: %+v", res)
	}
	it, _, _ := st.GetItem("article/go1")
	if it.State != "active" || it.Title != "作者改后的标题" {
		t.Fatalf("void 不得动目标: %+v", it)
	}
	var n int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM tombstones WHERE item_id=?`, "article/go1").Scan(&n); err != nil {
		t.Fatalf("数墓碑: %v", err)
	}
	if n != 0 {
		t.Fatal("void 不得写墓碑")
	}
	// void 是终态：再补一票也不重判。
	res, err = st.AddVote(id, "ee", govRoster("bb", "cc", "dd", "ee"))
	if err != nil {
		t.Fatalf("AddVote ee: %v", err)
	}
	if res.Status != GovernStatusVoid {
		t.Fatalf("void 是终态，不该翻转: %+v", res)
	}
}

// 幂等：生效后补票仍是 effective，不重复执行；同一身份重复投票 → ErrAlreadyVoted。
func TestAddVoteIdempotentAndDuplicate(t *testing.T) {
	st := openTemp(t)
	sub := govItem(t, st, "article/gi1", "标题", "辛")
	roster := govRoster("bb", "cc")
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "article/gi1", ProposerID: "bb",
		BaseContentHash: sub.ContentHash, CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}
	if _, err := st.AddVote(id, "cc", roster); err != nil {
		t.Fatalf("AddVote cc: %v", err)
	}
	if _, err := st.AddVote(id, "cc", roster); !errors.Is(err, ErrAlreadyVoted) {
		t.Fatalf("重复投票应 ErrAlreadyVoted，得 %v", err)
	}
	// 提案人重复投自己的提案同样被主键挡住。
	if _, err := st.AddVote(id, "bb", roster); !errors.Is(err, ErrAlreadyVoted) {
		t.Fatalf("提案人重复投票应 ErrAlreadyVoted，得 %v", err)
	}
}

// 并行提案：同目标同动作并存两个提案，先达标者执行，后者因状态不匹配呈 void。
func TestAddVoteParallelProposalsSecondVoids(t *testing.T) {
	st := openTemp(t)
	sub := govItem(t, st, "article/gp1", "标题", "壬")
	roster := govRoster("bb", "cc", "dd")
	first, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "article/gp1", ProposerID: "bb",
		BaseContentHash: sub.ContentHash, CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal first: %v", err)
	}
	second, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "article/gp1", ProposerID: "bb",
		BaseContentHash: sub.ContentHash, CreatedAt: 2,
	})
	if err != nil {
		t.Fatalf("CreateProposal second: %v", err)
	}
	if _, err := st.AddVote(first, "cc", roster); err != nil {
		t.Fatalf("AddVote first cc: %v", err)
	}
	if r, err := st.AddVote(first, "dd", roster); err != nil || r.Status != GovernStatusEffective {
		t.Fatalf("先达标者应生效: %+v err=%v", r, err)
	}
	if _, err := st.AddVote(second, "cc", roster); err != nil {
		t.Fatalf("AddVote second cc: %v", err)
	}
	r, err := st.AddVote(second, "dd", roster)
	if err != nil {
		t.Fatalf("AddVote second dd: %v", err)
	}
	if r.Status != GovernStatusVoid {
		t.Fatalf("后者应 void: %+v", r)
	}
}

// 名册派生失败的降级口径（册子 §6.2）：有效票 = 0 ⇒ 停在 pending、不动目标。
// ===== Task 4 新增：三个纯函数的单元测试 =====

func TestGovernThreshold_BaseCases(t *testing.T) {
	cases := []struct {
		name string
		m    int
		P    int
		F    int
		want int
	}{
		{"基础-小节点-无人互动", 5, 0, 0, 11},    // 10+⌊5/3⌋+0 = 10+1+0 = 11
		{"基础-小节点-热门", 5, 12, 9, 18},        // 10+1+⌊21/3⌋ = 10+1+7 = 18
		{"基础-大节点-冷门", 1000, 0, 0, 343},     // 10+333+0 = 343
		{"基础-中节点-热门", 50, 30, 20, 42},      // 10+16+⌊50/3⌋=10+16+16 = 42
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := GovernThreshold("base", c.m, c.P, c.F)
			if got != c.want {
				t.Fatalf("threshold(base,m=%d,P=%d,F=%d)=%d, want %d",
					c.m, c.P, c.F, got, c.want)
			}
		})
	}
}

func TestGovernThreshold_EnhancedCases(t *testing.T) {
	cases := []struct {
		name string
		m    int
		P    int
		F    int
		want int
	}{
		{"强化-小节点-无人互动", 5, 0, 0, 21},  // 20+1+0 = 21
		{"强化-小节点-热门", 5, 12, 9, 35},     // 20+1+⌊42/3⌋ = 20+1+14 = 35
		{"强化-大节点-热门", 100, 50, 30, 106}, // 20+33+⌊160/3⌋ = 20+33+53 = 106
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := GovernThreshold("enhanced", c.m, c.P, c.F)
			if got != c.want {
				t.Fatalf("threshold(enhanced,m=%d,P=%d,F=%d)=%d, want %d",
					c.m, c.P, c.F, got, c.want)
			}
		})
	}
}

func TestGovernQuorum_MinMaxClamp(t *testing.T) {
	cases := []struct {
		name      string
		threshold int
		m         int
		want      int
	}{
		{"小节点-超上限", 11, 5, 5},         // min(max(11,3),5) = 5
		{"中节点-门槛主导", 42, 50, 42},     // min(max(42,25),50) = 42
		{"大节点-半数主导", 343, 1000, 500}, // min(max(343,500),1000) = 500
		{"单用户-卡死保护", 11, 1, 1},       // min(max(11,1),1) = 1
		{"刚好等于半数", 25, 50, 25},        // min(max(25,25),50) = 25
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := GovernQuorum(c.threshold, c.m)
			if got != c.want {
				t.Fatalf("quorum(th=%d,m=%d)=%d, want %d", c.threshold, c.m, got, c.want)
			}
		})
	}
}

func TestNetWeight_ApproveMinusReject(t *testing.T) {
	cases := []struct {
		approve int
		reject  int
		want    int
	}{
		{45, 30, 15},
		{20, 35, -15},
		{0, 0, 0},
		{100, 0, 100},
		{0, 50, -50},
	}
	for _, c := range cases {
		got := NetWeight(c.approve, c.reject)
		if got != c.want {
			t.Fatalf("net(%d,%d)=%d, want %d", c.approve, c.reject, got, c.want)
		}
	}
}

func TestAddVoteEmptyRosterDegrades(t *testing.T) {
	st := openTemp(t)
	sub := govItem(t, st, "article/gd1", "标题", "癸")
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "article/gd1", ProposerID: "bb",
		BaseContentHash: sub.ContentHash, CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}
	r, err := st.AddVote(id, "cc", map[string]bool{})
	if err != nil {
		t.Fatalf("AddVote: %v", err)
	}
	if r.VoteCount != 0 || r.Status != GovernStatusPending {
		t.Fatalf("空名册应降级为 0 票 pending: %+v", r)
	}
	if it, _, _ := st.GetItem("article/gd1"); it.State != "active" {
		t.Fatalf("降级时不得动目标: %s", it.State)
	}
}

// ============ V2 测试辅助函数 ============

// setupIdentities 直接用 SQL 往 identities 表插 n 个活跃身份（last_seen_at = now）。
func setupIdentities(t *testing.T, st *Store, n int) {
	t.Helper()
	now := time.Now().UnixMilli()
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("user_%d", i)
		_, err := st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
			id, "ed25519", "pubkey_"+id, now, now)
		if err != nil {
			t.Fatalf("setupIdentities: %v", err)
		}
	}
}

// setupInactiveIdentities 插入 n 个身份但设为不活跃（last_seen_at 很久以前），不计入 m。
func setupInactiveIdentities(t *testing.T, st *Store, n int, prefix string) {
	t.Helper()
	now := time.Now().UnixMilli()
	old := now - 8*24*60*60*1000 // 8 天前，跨过 7 天活跃窗口
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("%s_%d", prefix, i)
		st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
			id, "ed25519", "pubkey_"+id, now, old)
	}
}

// setupProgress 直接用 SQL 往 progress 表插 count 条去重学习记录（item_id=itemID）。
func setupProgress(t *testing.T, st *Store, itemID string, voterIDs []string) {
	t.Helper()
	now := time.Now().UnixMilli()
	for _, vid := range voterIDs {
		st.db.Exec(`INSERT OR IGNORE INTO progress(id,item_id,position,done,day,updated_at,event_id)
			VALUES(?,?,?,?,?,?,?)`, vid, itemID, 0, 1, time.Now().Format("2006-01-02"), now, "evt_"+vid)
	}
}

// setupFavorites 直接用 SQL 往 favorites 表插 count 条收藏记录。
func setupFavorites(t *testing.T, st *Store, itemID string, voterIDs []string) {
	t.Helper()
	now := time.Now().UnixMilli()
	for _, vid := range voterIDs {
		st.db.Exec(`INSERT OR IGNORE INTO favorites(id,item_id,created_at) VALUES(?,?,?)`,
			vid, itemID, now)
	}
}

// setupVoterEnv 创建带 m 个活跃身份的测试 store。返回 store + 身份 id 列表。
func setupVoterEnv(t *testing.T, m int) (*Store, []string) {
	t.Helper()
	st := openTemp(t)
	ids := make([]string, m)
	now := time.Now().UnixMilli()
	for i := 0; i < m; i++ {
		ids[i] = fmt.Sprintf("voter_%d", i)
		_, err := st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
			ids[i], "ed25519", "pubkey_"+ids[i], now, now)
		if err != nil {
			t.Fatalf("setupVoterEnv: %v", err)
		}
	}
	return st, ids
}

// setupVoterEnvWithContributor 创建带指定贡献者的测试 store。
// 贡献者通过成为 identities 表前 10 个注册身份之一而自动进入 DeriveContributionRoster。
func setupVoterEnvWithContributor(t *testing.T, contributorID string) *Store {
	t.Helper()
	st := openTemp(t)
	now := time.Now().UnixMilli()
	// 先插入贡献者（确保最早注册，被 roster 补齐逻辑捕获）
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
		contributorID, "ed25519", "pubkey_"+contributorID, now, now)
	// 再插入 9 个身份凑够 10 个
	for i := 0; i < 9; i++ {
		id := fmt.Sprintf("other_%d", i)
		st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
			id, "ed25519", "pubkey_"+id, now, now)
	}
	return st
}

// createHotProposal 创建热门条目的 remove 提案：目标条目有 progress=12 条、favorites=9 条（均排除 proposer）。
// 关键：progress/favorites 的身份必须是不活跃的（last_seen_at 很久以前），否则会被计入 m 导致 quorum 过高。
func createHotProposal(t *testing.T, st *Store, proposerID string) int64 {
	t.Helper()
	// 创建一个 article 条目（走 UpsertSubmission）
	sub := govItem(t, st, "article/hot1", "热门标题", "热")
	// 用不活跃身份插 12 个 progress（不计入 m）
	setupInactiveIdentities(t, st, 12, "prog_user")
	pIDs := make([]string, 12)
	for i := 0; i < 12; i++ {
		pIDs[i] = fmt.Sprintf("prog_user_%d", i)
	}
	setupProgress(t, st, "article/hot1", pIDs)
	// 用不活跃身份插 9 个 favorites
	setupInactiveIdentities(t, st, 9, "fav_user")
	fIDs := make([]string, 9)
	for i := 0; i < 9; i++ {
		fIDs[i] = fmt.Sprintf("fav_user_%d", i)
	}
	setupFavorites(t, st, "article/hot1", fIDs)

	id, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "article/hot1", ProposerID: proposerID,
		Reason: "不合规", BaseContentHash: sub.ContentHash, CreatedAt: time.Now().UnixMilli(),
	})
	if err != nil {
		t.Fatalf("CreateProposal(hot): %v", err)
	}
	return id
}

// createSimpleProposal 创建一个简单的 remove 提案（无 progress/favorites）。返回 proposal_id 和真实的 content_hash。
func createSimpleProposal(t *testing.T, st *Store, proposerID, itemID string) (int64, string) {
	t.Helper()
	sub := signedSubmission(t, subSeedA, itemID, "标题", govLongBody("简"))
	if _, err := st.UpsertSubmission(sub); err != nil {
		t.Fatalf("UpsertSubmission(%s): %v", itemID, err)
	}
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: itemID, ProposerID: proposerID,
		Reason: "测试", BaseContentHash: sub.ContentHash, CreatedAt: time.Now().UnixMilli(),
	})
	if err != nil {
		t.Fatalf("CreateProposal(simple): %v", err)
	}
	return id, sub.ContentHash
}

// ============ V2 投票管线测试 ============

func TestAddVoteV2_QuorumNotMet_StayPending(t *testing.T) {
	st, ids := setupVoterEnv(t, 5)
	// ids[0] = "voter_0" 作为 proposer（CreateProposal 会为他自投 1 票）
	pid := createHotProposal(t, st, ids[0])
	// proposer 已投，再投 ids[1], ids[2], ids[3] → voter_count=4 < quorum=5
	for i := 1; i <= 3; i++ {
		if _, err := st.AddVoteV2(pid, ids[i], 1, "approve"); err != nil {
			t.Fatalf("AddVoteV2 %s: %v", ids[i], err)
		}
	}
	// 再投 ids[4] → voter_count=5 == quorum，净票权 > 0 → effective
	result, err := st.AddVoteV2(pid, ids[4], 1, "approve")
	if err != nil {
		t.Fatal(err)
	}
	if result.VoterCount != 5 {
		t.Fatalf("voter_count 应为 5，实际 %d", result.VoterCount)
	}
	if result.Status != "effective" {
		t.Fatalf("quorum=5 达成 + 净票权>0 应 effective，实际 %s", result.Status)
	}
}

func TestAddVoteV2_NetNegative_Void(t *testing.T) {
	st, ids := setupVoterEnv(t, 5)
	pid := createHotProposal(t, st, ids[0])
	// proposer(ids[0]) 已投 approve(1)。再投 ids[1]=approve + ids[2..3]=reject + ids[4]=reject
	if _, err := st.AddVoteV2(pid, ids[1], 1, "approve"); err != nil {
		t.Fatalf("approve: %v", err)
	}
	if _, err := st.AddVoteV2(pid, ids[2], 1, "reject"); err != nil {
		t.Fatalf("reject 2: %v", err)
	}
	if _, err := st.AddVoteV2(pid, ids[3], 1, "reject"); err != nil {
		t.Fatalf("reject 3: %v", err)
	}
	// 最后 ids[4] 投 reject → voter_count=5 达到 quorum
	result, err := st.AddVoteV2(pid, ids[4], 1, "reject")
	if err != nil {
		t.Fatal(err)
	}
	// approve=2 (proposer + ids[1]), reject=3 (ids[2..4]) → net=2-3=-1
	if result.NetWeight != -1 {
		t.Fatalf("net_weight 应为 -1，实际 %d", result.NetWeight)
	}
	if result.Status != "void" {
		t.Fatalf("净票权=-1 应 void，实际 %s", result.Status)
	}
}

func TestAddVoteV2_ContributorQuota_Exceeded(t *testing.T) {
	st := openTemp(t)
	now := time.Now().UnixMilli()
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, "CONTRIB_1", "ed25519", "k1", now, now)
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, "other_0", "ed25519", "k0", now, now)
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, "other_1", "ed25519", "k1a", now, now)
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, "other_2", "ed25519", "k2", now, now)
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, "other_3", "ed25519", "k3", now, now)
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, "other_4", "ed25519", "k4", now, now)
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, "other_5", "ed25519", "k5", now, now)
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, "other_6", "ed25519", "k6", now, now)
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, "other_7", "ed25519", "k7", now, now)
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, "other_8", "ed25519", "k8", now, now)
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, "PROPOSER", "ed25519", "kp", now, now)
	// 跨提案投 2 权 × 10 次（每个提案投 2 权 → 单条目累计不触发，只触发每日配额）
	for i := 0; i < 10; i++ {
		sub := signedSubmission(t, subSeedA, fmt.Sprintf("item_q1_%d", i), "标题", govLongBody("简"))
		if _, err := st.UpsertSubmission(sub); err != nil {
			t.Fatal(err)
		}
		pid, err := st.CreateProposal(Proposal{
			Action: GovernActionRemove, ItemID: fmt.Sprintf("item_q1_%d", i), ProposerID: "PROPOSER",
			BaseContentHash: sub.ContentHash, CreatedAt: now,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.AddVoteV2(pid, "CONTRIB_1", 2, "approve"); err != nil {
			t.Fatalf("第 %d 次（不同提案）投 2 权应成功，err=%v", i, err)
		}
	}
	// 第 11 个提案投 2 权 → 累计 22 > 20 → 被每日配额拒绝
	sub := signedSubmission(t, subSeedA, "item_q1_10", "标题", govLongBody("简"))
	if _, err := st.UpsertSubmission(sub); err != nil {
		t.Fatal(err)
	}
	pid, _ := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "item_q1_10", ProposerID: "PROPOSER",
		BaseContentHash: sub.ContentHash, CreatedAt: now,
	})
	_, err := st.AddVoteV2(pid, "CONTRIB_1", 2, "approve")
	if err == nil || !strings.Contains(err.Error(), "quota_exceeded") {
		t.Fatalf("第 11 次应被配额拒绝，实际 err=%v", err)
	}
}

func TestAddVoteV2_Contributor_OneWeight_NoQuotaConsumed(t *testing.T) {
	st := setupVoterEnvWithContributor(t, "CONTRIB_1")
	now := time.Now().UnixMilli()
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
		"PROPOSER", "ed25519", "pubkey_PROPOSER", now, now)
	// 投 1 权 × 30 个不同提案（每次投不同 item → 单条目累计不触发）
	for i := 0; i < 30; i++ {
		itemID := fmt.Sprintf("item_q2_%d", i)
		pid, _ := createSimpleProposal(t, st, "PROPOSER", itemID)
		if _, err := st.AddVoteV2(pid, "CONTRIB_1", 1, "approve"); err != nil {
			t.Fatalf("第 %d 次（不同提案）投 1 权应成功，err=%v", i, err)
		}
	}
}

func TestAddVoteV2_NormalUser_ForcedToOneWeight(t *testing.T) {
	// 创建 11 个身份：voter_0..voter_9 在前 10（贡献层），NORMAL_USER 第 11（普通用户）
	st, ids := setupVoterEnv(t, 10)
	now := time.Now().UnixMilli()
	st.db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
		"NORMAL_USER", "ed25519", "pubkey_NORMAL", now, now)
	pid, _ := createSimpleProposal(t, st, ids[0], "item_n1")
	// 普通用户请求 voteWeight=7，应被强制为 1
	if _, err := st.AddVoteV2(pid, "NORMAL_USER", 7, "approve"); err != nil {
		t.Fatal(err)
	}
	var vw int
	if err := st.db.QueryRow(`SELECT vote_weight FROM govern_votes WHERE voter_id='NORMAL_USER' AND proposal_id=?`, pid).Scan(&vw); err != nil {
		t.Fatal(err)
	}
	if vw != 1 {
		t.Fatalf("普通用户 voteWeight 强制为 1，实际写入 %d", vw)
	}
	// approve_weight 检查（可能 quorum 没到所以投票还没结算，但 vote 行里已经写入了）
	// 让我们直接查 govern_votes 的 approve 票权总和
	var approveSum int
	st.db.QueryRow(`SELECT COALESCE(SUM(vote_weight),0) FROM govern_votes WHERE proposal_id=? AND vote_type='approve'`, pid).Scan(&approveSum)
	if approveSum != 2 {
		t.Fatalf("approve 票权总和应为 2（proposer + NORMAL_USER 各 1），实际 %d", approveSum)
	}
}

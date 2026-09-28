package store

import (
	"errors"
	"strings"
	"testing"

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
	if got := GovernThreshold(GovernActionRemove); got != 3 {
		t.Fatalf("remove 门槛=%d want 3", got)
	}
	for _, a := range []string{GovernActionEdit, GovernActionRevive} {
		if got := GovernThreshold(a); got != 2 {
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

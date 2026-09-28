package store

import (
	"strings"
	"testing"
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

/*
⚠️ 留待 Task 3：本用例调用 st.AddVote（Task 3 才实现），Task 2 阶段无法编译，
故先以块注释保留代码本体；Task 3 落地 AddVote 后解除本注释即可一起跑通。

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
*/

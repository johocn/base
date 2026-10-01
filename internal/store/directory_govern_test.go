package store

import (
	"fmt"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

// seedRoster 造 n 个达标作者（每人一条 200 rune 文章），使 ContributorRoster 返回长度为 n 的名册。
// 供本 Task 与后续 store 测试复用（册子 #58 §3.2 的小节点豁免判定依赖真实名册长度）。
// id 取字典序递增，n<=RosterTopN 时不会被截断；返回作者 id 列表（构造提案 / 投票用）。
func seedRoster(t *testing.T, st *Store, n int) []string {
	t.Helper()
	ids := make([]string, 0, n)
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("%032x", i+1)
		itemID := fmt.Sprintf("article/roster-%02d", i)
		body := strings.Repeat("字", 200) // 恰好达 ArticleMinRunes 门槛
		if err := st.UpsertArticle(Article{
			ItemID: itemID, Title: itemID, BodyMD: body,
			ContentHash: protocol.SHA256Hex([]byte(body)),
			UpdatedAt:   "2026-01-02T00:00:00Z",
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := st.db.Exec(`UPDATE items SET author_id=?, author_sig='00' WHERE item_id=?`, id, itemID); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return ids
}

// rosterOf 把 ContributorRoster 折成名册集合（与线上派生口径同源）。
func rosterOf(t *testing.T, st *Store) map[string]bool {
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

// dirProposal 造一条形态合法的目录提案（item_id / title / body_md / content_hash 按契约派生）。
func dirProposal(kind, display, proposer string) Proposal {
	termKey, _ := NormalizeTermKey(display)
	return Proposal{
		Action:          GovernActionDirectoryAdd,
		ItemID:          DirectoryProposalItemID(kind, termKey),
		ProposerID:      proposer,
		Reason:          "新增词条",
		Title:           display,
		BodyMD:          termKey,
		BaseContentHash: DirectoryPayloadHash(kind, termKey),
		CreatedAt:       1,
	}
}

func TestGovernThresholdForRoster(t *testing.T) {
	cases := []struct {
		action    string
		rosterLen int
		ready     bool
		want      int
	}{
		{GovernActionDirectoryAdd, 5, true, 1},  // 小节点豁免
		{GovernActionDirectoryAdd, 9, true, 1},  // 边界内侧
		{GovernActionDirectoryAdd, 10, true, 2}, // 边界外侧
		{GovernActionDirectoryAdd, 12, true, 2},
		{GovernActionDirectoryAdd, 0, false, 2}, // 派生失败不豁免（fail-closed）
		{GovernActionRemove, 5, true, 3},        // 既有动作不受影响
		{GovernActionEdit, 5, true, 2},
		{GovernActionRevive, 5, true, 2},
	}
	for _, c := range cases {
		if got := GovernThresholdForRoster(c.action, c.rosterLen, c.ready); got != c.want {
			t.Errorf("GovernThresholdForRoster(%q,%d,%v)=%d, want %d", c.action, c.rosterLen, c.ready, got, c.want)
		}
	}
	// 无名册语境下 directory_add 的门槛供展示用（= DirectoryAddQuorum）。
	if got := GovernThreshold(GovernActionDirectoryAdd); got != DirectoryAddQuorum {
		t.Fatalf("GovernThreshold(directory_add)=%d, want %d", got, DirectoryAddQuorum)
	}
}

func TestCreateDirectoryProposalAutoApprove(t *testing.T) {
	st := openTemp(t)
	kind, display := DirectoryKindCategory, "数学"
	p := dirProposal(kind, display, authorA)
	termKey := p.BodyMD

	before, err := st.DirectoryVersion()
	if err != nil || before != 0 {
		t.Fatalf("初值 DirectoryVersion=%d err=%v, want 0", before, err)
	}
	pid, status, err := st.CreateDirectoryProposal(p, true)
	if err != nil {
		t.Fatalf("CreateDirectoryProposal: %v", err)
	}
	if status != GovernStatusEffective {
		t.Fatalf("status=%q, want %q", status, GovernStatusEffective)
	}
	got, ok, err := st.GetDirectoryTerm(kind, termKey)
	if err != nil || !ok {
		t.Fatalf("GetDirectoryTerm ok=%v err=%v", ok, err)
	}
	if got.State != DirectoryStateApproved || got.DisplayName != display {
		t.Fatalf("词条 = %+v, want approved/%q", got, display)
	}
	view, ok, err := st.GetProposal(pid)
	if err != nil || !ok {
		t.Fatalf("GetProposal ok=%v err=%v", ok, err)
	}
	if view.ExecutedAt == 0 || view.ExecutedResult != directoryExecutedResult {
		t.Fatalf("executed_at=%d result=%q, want 非 0/%q", view.ExecutedAt, view.ExecutedResult, directoryExecutedResult)
	}
	after, err := st.DirectoryVersion()
	if err != nil || after != 1 {
		t.Fatalf("DirectoryVersion=%d err=%v, want 1", after, err)
	}
}

func TestCreateDirectoryProposalPendingWithoutAutoApprove(t *testing.T) {
	st := openTemp(t)
	kind, display := DirectoryKindInstructor, "李老师"
	p := dirProposal(kind, display, authorA)

	pid, status, err := st.CreateDirectoryProposal(p, false)
	if err != nil {
		t.Fatalf("CreateDirectoryProposal: %v", err)
	}
	if status != GovernStatusPending {
		t.Fatalf("status=%q, want %q", status, GovernStatusPending)
	}
	view, _, err := st.GetProposal(pid)
	if err != nil {
		t.Fatal(err)
	}
	if view.ExecutedAt != 0 {
		t.Fatalf("executed_at=%d, want 0", view.ExecutedAt)
	}
	if view.SourceEventID != "" { // 本地写入：source_event_id 留空（结构体读回空串）
		t.Fatalf("source_event_id=%q, want 空", view.SourceEventID)
	}
	if _, ok, err := st.GetDirectoryTerm(kind, p.BodyMD); err != nil || ok {
		t.Fatalf("未豁免时不应写目录行: ok=%v err=%v", ok, err)
	}
	if v, err := st.DirectoryVersion(); err != nil || v != 0 {
		t.Fatalf("DirectoryVersion=%d err=%v, want 0", v, err)
	}
}

func TestDirectoryAddEffectiveViaVote(t *testing.T) {
	st := openTemp(t)
	ids := seedRoster(t, st, 10)
	roster := rosterOf(t, st)
	if len(roster) != 10 {
		t.Fatalf("名册=%d, want 10（须 ≥10 才不走豁免）", len(roster))
	}
	kind, display := DirectoryKindCategory, "代数"
	p := dirProposal(kind, display, ids[0]) // 提案人在名册内 → 自计第 1 票

	pid, status, err := st.CreateDirectoryProposal(p, false)
	if err != nil {
		t.Fatalf("CreateDirectoryProposal: %v", err)
	}
	if status != GovernStatusPending {
		t.Fatalf("建提案 status=%q, want pending", status)
	}
	res, err := st.AddVote(pid, ids[1], roster)
	if err != nil {
		t.Fatalf("AddVote: %v", err)
	}
	if res.Status != GovernStatusEffective {
		t.Fatalf("投票后 status=%q (票=%d 门槛=%d), want effective", res.Status, res.VoteCount, res.Threshold)
	}
	got, ok, err := st.GetDirectoryTerm(kind, p.BodyMD)
	if err != nil || !ok || got.State != DirectoryStateApproved {
		t.Fatalf("生效后词条 ok=%v err=%v got=%+v, want approved", ok, err, got)
	}
	if v, err := st.DirectoryVersion(); err != nil || v != 1 {
		t.Fatalf("DirectoryVersion=%d err=%v, want 1", v, err)
	}
}

func TestGovernPreconditionTxDirectoryAddBypass(t *testing.T) {
	st := openTemp(t)
	tx, err := st.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	p := dirProposal(DirectoryKindCategory, "物理", authorA)
	// items 表无该 item_id；通用前置条件会因 ErrNoRows 判 false，directory_add 必须旁路放行。
	met, err := governPreconditionTx(tx, p)
	if err != nil {
		t.Fatalf("governPreconditionTx: %v", err)
	}
	if !met {
		t.Fatal("directory_add 应短路返回 true（无目标 item 可锁）")
	}
}

func TestDirectoryAddMergeQueries(t *testing.T) {
	st := openTemp(t)
	ids := seedRoster(t, st, 10)
	roster := rosterOf(t, st)
	kind, display := DirectoryKindTag, "第一章"
	p := dirProposal(kind, display, ids[0])
	itemID := p.ItemID

	pid, _, err := st.CreateDirectoryProposal(p, false)
	if err != nil {
		t.Fatalf("CreateDirectoryProposal: %v", err)
	}
	// pending：同键归并命中同一 pid。
	gotPID, ok, err := st.FindPendingDirectoryProposal(itemID)
	if err != nil || !ok || gotPID != pid {
		t.Fatalf("pending 归并 pid=%d ok=%v err=%v, want %d", gotPID, ok, err, pid)
	}
	// 定案后不再命中 pending。
	if _, err := st.AddVote(pid, ids[1], roster); err != nil {
		t.Fatalf("AddVote: %v", err)
	}
	if _, ok, err := st.FindPendingDirectoryProposal(itemID); err != nil || ok {
		t.Fatalf("定案后仍命中 pending: ok=%v err=%v", ok, err)
	}
	// approved：GetDirectoryTerm 命中。
	got, ok, err := st.GetDirectoryTerm(kind, p.BodyMD)
	if err != nil || !ok || got.State != DirectoryStateApproved {
		t.Fatalf("approved 词条 ok=%v err=%v got=%+v", ok, err, got)
	}
}

// 事件路径的小节点豁免（本册 §2）：名册就绪且为空（< DirectorySmallNodeRosterMax）⇒ 投影后结算即生效。
// authorA 无任何达标内容 ⇒ 不在名册内，正是线上小节点创建者的真实形态（旧口径下自投那票会被过滤掉）。
func TestDirectoryAddSettlesOnSmallNodeViaEventPath(t *testing.T) {
	st := openTemp(t)
	p := dirProposal(DirectoryKindCategory, "语文", authorA)
	if err := st.ProjectGovernProposal(GovernProposalEvent{
		ProposalID:   7,
		TargetItemID: p.ItemID,
		Verb:         GovernActionDirectoryAdd,
		ContentHash:  p.BaseContentHash,
		Reason:       p.Reason,
		Title:        p.Title,
		BodyMD:       p.BodyMD,
		CreatedAt:    1,
		EventID:      "evt-small-node-1",
		Actor:        authorA,
	}); err != nil {
		t.Fatalf("ProjectGovernProposal: %v", err)
	}
	if err := st.SettleGovernProposal(7, govRoster(), true); err != nil {
		t.Fatalf("SettleGovernProposal: %v", err)
	}
	view, ok, err := st.GetProposal(7)
	if err != nil || !ok {
		t.Fatalf("GetProposal ok=%v err=%v", ok, err)
	}
	if view.ExecutedAt == 0 || view.ExecutedResult != directoryExecutedResult {
		t.Fatalf("小节点应提交即生效: executed_at=%d result=%q", view.ExecutedAt, view.ExecutedResult)
	}
	got, ok, err := st.GetDirectoryTerm(DirectoryKindCategory, p.BodyMD)
	if err != nil || !ok || got.State != DirectoryStateApproved {
		t.Fatalf("词条 ok=%v err=%v got=%+v, want approved", ok, err, got)
	}
	if v, err := st.DirectoryVersion(); err != nil || v != 1 {
		t.Fatalf("DirectoryVersion=%d err=%v, want 1", v, err)
	}
}

// 越界护栏（本册 §2.2）：名册 = 10 时该分支不进入，提案人不在名册内 ⇒ 有效票 0 < 门槛 2 ⇒ 仍 pending。
func TestDirectoryAddStaysPendingAtRosterTenViaEventPath(t *testing.T) {
	st := openTemp(t)
	ids := seedRoster(t, st, 10)
	roster := rosterOf(t, st)
	if len(roster) != 10 {
		t.Fatalf("名册=%d, want 10", len(roster))
	}
	// authorA 不在 seedRoster 造出的 ids 里 ⇒ 不在名册内。
	p := dirProposal(DirectoryKindInstructor, "王老师", authorA)
	if err := st.ProjectGovernProposal(GovernProposalEvent{
		ProposalID:   8,
		TargetItemID: p.ItemID,
		Verb:         GovernActionDirectoryAdd,
		ContentHash:  p.BaseContentHash,
		Reason:       p.Reason,
		Title:        p.Title,
		BodyMD:       p.BodyMD,
		CreatedAt:    1,
		EventID:      "evt-roster-10",
		Actor:        authorA,
	}); err != nil {
		t.Fatalf("ProjectGovernProposal: %v", err)
	}
	if roster[authorA] {
		t.Fatalf("前置不成立：authorA 不应在名册内")
	}
	_ = ids
	if err := st.SettleGovernProposal(8, roster, true); err != nil {
		t.Fatalf("SettleGovernProposal: %v", err)
	}
	view, _, err := st.GetProposal(8)
	if err != nil {
		t.Fatal(err)
	}
	if view.ExecutedAt != 0 {
		t.Fatalf("名册=10 不应豁免: executed_at=%d result=%q", view.ExecutedAt, view.ExecutedResult)
	}
	if _, ok, err := st.GetDirectoryTerm(DirectoryKindInstructor, p.BodyMD); err != nil || ok {
		t.Fatalf("未达门槛不应写目录行: ok=%v err=%v", ok, err)
	}
}

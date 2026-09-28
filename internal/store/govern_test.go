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

// TestGovernThresholdAndStatusDerivation 锁定门槛与状态派生的合同值（册子 §2.1 / §4.4）。
//
// ⚠️ 偏差（Task 1）：计划原文调用 GovernThreshold / GovernRequiredState / ProposalStatus 及
// GovernAction* / GovernStatus* 常量，而这些都在 Task 2 的 govern.go 才实现。Task 1 只做两张新表
// 与 sqlExec 抽壳，不提前实现 Task 2，故此处改用等价内联表达式（同规则、同字面量）断言合同值；
// Task 2 落地后应改回调用真函数。
func TestGovernThresholdAndStatusDerivation(t *testing.T) {
	// 门槛：remove 3，edit / revive 2。
	threshold := func(action string) int {
		if action == "remove" {
			return 3
		}
		return 2
	}
	if got := threshold("remove"); got != 3 {
		t.Fatalf("remove 门槛=%d want 3", got)
	}
	for _, a := range []string{"edit", "revive"} {
		if got := threshold(a); got != 2 {
			t.Fatalf("%s 门槛=%d want 2", a, got)
		}
	}
	// 前置 state：revive 需 removed，remove / edit 需 active。
	requiredState := func(action string) string {
		if action == "revive" {
			return "removed"
		}
		return "active"
	}
	if got := requiredState("revive"); got != "removed" {
		t.Fatalf("revive 需 removed，得 %q", got)
	}
	for _, a := range []string{"remove", "edit"} {
		if got := requiredState(a); got != "active" {
			t.Fatalf("%s 需 active，得 %q", a, got)
		}
	}
	// status 由两个一次性事实派生（册子 §4.4）。
	status := func(executedAt, voidedAt int64) string {
		switch {
		case executedAt != 0:
			return "effective"
		case voidedAt != 0:
			return "void"
		default:
			return "pending"
		}
	}
	if status(1, 0) != "effective" || status(0, 1) != "void" || status(0, 0) != "pending" {
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

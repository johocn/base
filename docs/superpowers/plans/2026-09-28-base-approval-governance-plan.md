# base 审批治理实施计划（治理主线 第 3 册 #27）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让名册内的治理者对**他人条目**发起 `remove` / `edit` / `revive` 提案，授权票达到该动作门槛（`remove` 3 票、`edit` / `revive` 2 票）即在**同一事务内**生效。

**Architecture:** 落两张新表 `govern_proposals` / `govern_votes`（本节点自治，不进 events、不参与反熵）。生效判定发生在**投票落库的那次请求内**：先写票（取 SQLite 写锁、串行化并发投票），再在同一事务里读票、按实时名册过滤、比门槛、判前置条件（目标仍在 + `state` 匹配 + `content_hash` 等于受理时的快照），满足则执行动作并记 `executed_at`，否则记 `voided_at`（一次性终态）。名册一律走既有 `store.ContributorRoster()`，不新造身份体系；`edit` 仅对 article 载体成立（册子 §0.3）。

**Tech Stack:** Go（`internal/store`、`internal/httpapi`、`internal/protocol`，SQLite via `modernc.org/sqlite`）。**本册不碰 TypeScript 与手机端**（治理 UI 归第 4 册）。

**上游册子：** [docs/superpowers/specs/2026-09-28-base-approval-governance-design.md](file:///e:/code/base/docs/superpowers/specs/2026-09-28-base-approval-governance-design.md)（本计划的字段名、常量、错误码、语义一律以册子为准；冲突时先改册子）

**已核实的环境事实（勿再验证）：**

- 本机 Go 不能完成同进程回环 TCP，测试基座用 `newInprocServer`（`internal/httpapi/testsupport_test.go`，`init()` 里替换 `http.DefaultTransport`）。**投票请求体可空**：`inprocTransport` 会把 `nil` 的 `req.Body` 补成 `http.NoBody`。
- `schemaStatements` 全是 `CREATE TABLE/INDEX IF NOT EXISTS`，**新增两张表即可，不需要 `ALTER` 补列**；`migrate()` 的补列流程本册用不上。
- `store.RetireItem` / `store.NextContentVersion` 目前直接打 `s.db`（`internal/store/segments.go`）。生效事务必须让它们跑在 `*sql.Tx` 上，否则会与持有写锁的同一事务互锁——Task 1 把这两段语句抽成 `sqlExec` 版本。
- `ipLimiter.allow(key) bool` 是既有限速器（`internal/httpapi/identity.go`）；按身份与按 IP 是**两个独立实例**。
- `internal/store/submission.go` 的 `UpsertSubmission` 会写 `items.author_id` / `author_sig` 两列、且 `ON CONFLICT` **不动** `state`——正是构造「有归属且 active」的测试目标的手段。
- `items.source_rev` 口径是 `content_hash[:16]`（`internal/importer/md.go`）；`articles.body_md` 走 `s.encText()` 加密存储。
- `store.UpsertQuiz` 写下的条目 `source='lesson'`、`type='quiz'`、`sqlite_table='quizzes'`，是「非 article 载体」的现成样本。
- 重复投票用 `ON CONFLICT(...) DO NOTHING` + `RowsAffected() == 0` 判定（与 `store.UseNonce` 同口径），不依赖驱动的错误类型。
- **连接池是单连接**（`store.go` 的 `db.SetMaxOpenConns(1)`）：**游标未关闭时不得嵌套发起新查询**，否则拿不到连接会死锁（Task 2 的 `ListProposalViews` 已按此改写为先读尽、`rows.Close()`、再逐条取票）。同理，生效事务内的所有语句必须走 `tx` 而非 `s.db`。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `internal/store/store.go`（改） | 加 `sqlExec` 接口（`*sql.DB` 与 `*sql.Tx` 的公共执行面，供生效事务复用既有语句） |
| `internal/store/segments.go`（改） | `RetireItem` / `NextContentVersion` 拆出 `retireItemExec` / `nextContentVersionExec`，导出函数退化为 `s.db` 薄封装（行为不变） |
| `internal/store/schema.go`（改） | `schemaStatements` 追加 `govern_proposals` / `govern_votes` 两张表与一条索引 |
| `internal/store/govern.go`（新） | 动作枚举、门槛与状态派生、`Proposal` / `ProposalView` / `VoteResult`、`CreateProposal` / `GetProposal` / `ListProposalViews` / `AddVote`、生效事务内核（`governPreconditionTx` / `governApplyTx` / `editItemTx`） |
| `internal/store/govern_test.go`（新） | 建表、门槛/状态派生、提案读写、投票生效事务（含乐观锁、并行提案、实时复判、名册降级） |
| `internal/httpapi/govern.go`（新） | 限速常量、校验纯函数（`validProposalAction` / `validProposalReason` / `hasControlChars` / `parseProposalID`）、`governRoster`、三个 handler 与各自的 DTO |
| `internal/httpapi/govern_test.go`（新） | 纯函数单测、错误码分支单测、AC 1–12 + AC 14 端到端 |
| `internal/httpapi/server.go`（改） | `Server` 加三个限速器字段、`New()` 初始化、`publicMux()` 注册三条路由 |
| `internal/httpapi/authmw.go`（改） | `authErrText` 补本册 11 条；`author_id_forbidden` 文案放宽到「身份字段」 |
| `docs/README.md`（改） | 登记本计划（#28）、依赖图、§5 当前阶段 |
| `docs/superpowers/plans/2026-09-28-base-approval-governance-plan.md`（改） | Task 8 回填「执行实况」 |

---

## Task 1: 两张新表 + `sqlExec` 抽壳

**Files:**
- Modify: `internal/store/store.go`（加 `sqlExec`）
- Modify: `internal/store/segments.go`（拆 `RetireItem` / `NextContentVersion`）
- Modify: `internal/store/schema.go`（追加两张表 + 索引）
- Test: `internal/store/govern_test.go`（新建）

- [ ] **Step 1: 写失败测试**

创建 `internal/store/govern_test.go`：

```go
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
// ⚠️ 偏差（Task 1）：此处刻意用等价内联表达式（同规则、同字面量）断言合同值，而不是调用
// GovernThreshold / GovernRequiredState / ProposalStatus —— 它们要到 Task 2 的 govern.go 才实现，
// Task 1 只做两张新表与 sqlExec 抽壳。**Task 2 的最后一步必须把本函数改回调用真函数**（见 Task 2 Step 6）。
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/store/ -run 'TestGovernTablesExist|TestGovernThresholdAndStatusDerivation|TestRetireItemAndNextContentVersionUnchanged' -v`
Expected: FAIL —— `undefined: GovernThreshold` / `undefined: GovernActionRemove`

- [ ] **Step 3: 写最小实现**

**3a.** `internal/store/store.go`：在 `Store` 结构体定义之后追加：

```go
// sqlExec 是 *sql.DB 与 *sql.Tx 的公共执行面。
// 治理册 §4.4 的生效事务必须在同一事务里退役条目、读 content_version 与改归属列，
// 故把这些语句抽成 exec 版本；导出函数仍以 s.db 为参数，行为不变。
type sqlExec interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}
```

**3b.** `internal/store/segments.go`：把 `RetireItem` 与 `NextContentVersion` 换成下面两段（**语句本体一字不改**，只是换了执行者）：

```go
// RetireItem 退役一个条目：写墓碑（revoked_rev 取大值覆盖）并置 state='removed'（册子 §2.2）。
// 只置状态不删行：内容行与块文件保留在源节点，旧条目自此不进 active 列表、不参与导出；
// 接收侧按 manifest 里的墓碑走既有删除路径。
func (s *Store) RetireItem(itemID string, revokedRev int64) error {
	return retireItemExec(s.db, itemID, revokedRev)
}

// retireItemExec 是 RetireItem 的语句本体，供 *sql.Tx 复用（治理册 §4.4 的生效事务）。
func retireItemExec(e sqlExec, itemID string, revokedRev int64) error {
	if _, err := e.Exec(`INSERT INTO tombstones(item_id,revoked_rev) VALUES(?,?)
		ON CONFLICT(item_id) DO UPDATE SET revoked_rev=MAX(revoked_rev,excluded.revoked_rev)`, itemID, revokedRev); err != nil {
		return fmt.Errorf("store: 退役写墓碑 %s: %w", itemID, err)
	}
	if _, err := e.Exec(`UPDATE items SET state='removed' WHERE item_id=?`, itemID); err != nil {
		return fmt.Errorf("store: 退役置状态 %s: %w", itemID, err)
	}
	return nil
}

// NextContentVersion 返回下一次导出将使用的全局 content_version（只读，不递增）。
// 用于把「退役生效版本」与紧随其后的那次导出版本对齐（册子 §2.2）。
func (s *Store) NextContentVersion() (int64, error) {
	return nextContentVersionExec(s.db)
}

// nextContentVersionExec 是 NextContentVersion 的语句本体，供 *sql.Tx 复用。
func nextContentVersionExec(e sqlExec) (int64, error) {
	var raw string
	err := e.QueryRow(`SELECT value FROM meta WHERE key=?`, metaContentVersion).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	cur, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("store: bad content_version %q", raw)
	}
	return cur + 1, nil
}
```

**3c.** `internal/store/schema.go`：在 `schemaStatements` 的 `profiles` 表之后追加三段：

```go
	// govern_proposals / govern_votes：审批治理的提案与票（第 3 册 §5.1）。
	// 只存本节点，不进 events、不参与反熵、不跨节点同步（§2.5）。
	// 两张都是新增表，schemaStatements 的 CREATE TABLE IF NOT EXISTS 足够，无需 ALTER 补列。
	`CREATE TABLE IF NOT EXISTS govern_proposals(
		proposal_id       INTEGER PRIMARY KEY,
		action            TEXT    NOT NULL,
		item_id           TEXT    NOT NULL,
		proposer_id       TEXT    NOT NULL,
		reason            TEXT    NOT NULL DEFAULT '',
		title             TEXT    NOT NULL DEFAULT '',
		body_md           TEXT    NOT NULL DEFAULT '',
		base_content_hash TEXT    NOT NULL,
		created_at        INTEGER NOT NULL,
		executed_at       INTEGER NOT NULL DEFAULT 0,
		voided_at         INTEGER NOT NULL DEFAULT 0,
		executed_result   TEXT    NOT NULL DEFAULT ''
	)`,

	`CREATE TABLE IF NOT EXISTS govern_votes(
		proposal_id INTEGER NOT NULL,
		voter_id    TEXT    NOT NULL,
		created_at  INTEGER NOT NULL,
		PRIMARY KEY(proposal_id, voter_id)
	)`,

	`CREATE INDEX IF NOT EXISTS idx_govern_proposals_item ON govern_proposals(item_id, action)`,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/store/ -v`
Expected: PASS —— 新增 3 个用例全绿，且**既有 store 测试一个都不能红**（`RetireItem` / `NextContentVersion` 的抽壳是纯重构）。

- [ ] **Step 5: 提交**

```bash
git add internal/store/store.go internal/store/segments.go internal/store/schema.go internal/store/govern_test.go
git commit -m "feat(store): 治理两张新表与 sqlExec 抽壳（RetireItem/NextContentVersion 可跑在事务上）"
```

---

## Task 2: 提案的写入与读取

**Files:**
- Create: `internal/store/govern.go`（本 Task 只写枚举、派生、类型、`CreateProposal` / `GetProposal` / `ListProposalViews`；Task 3 在同一文件追加投票与生效事务）
- Test: `internal/store/govern_test.go`（追加）

- [ ] **Step 1: 写失败测试**

在 `internal/store/govern_test.go` 追加：

```go
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/store/ -run 'TestCreateAndGetProposal|TestCreateProposalWritesFirstVote|TestListProposalViewsFiltersVotesByRoster' -v`
Expected: FAIL —— `undefined: Proposal`；且 `TestListProposalViewsFiltersVotesByRoster` 还缺 `AddVote`（Task 3 才写）——**本步骤先只跑前两个用例**：

Run: `go test ./internal/store/ -run 'TestCreateAndGetProposal|TestCreateProposalWritesFirstVote' -v`

- [ ] **Step 3: 写最小实现**

创建 `internal/store/govern.go`：

```go
package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// 三个受审动作（册子 §2.1）。门槛是**文档级常量**，校准走「改册子 + 改常量」。
const (
	GovernActionRemove = "remove"
	GovernActionEdit   = "edit"
	GovernActionRevive = "revive"

	governRemoveThreshold  = 3
	governDefaultThreshold = 2
)

// Proposal status 的三值（册子 §4.4）。
const (
	GovernStatusPending   = "pending"
	GovernStatusEffective = "effective"
	GovernStatusVoid      = "void"
)

// GovernThreshold 返回某动作的授权门槛：remove 3 票，edit / revive 2 票（册子 §2.1）。
func GovernThreshold(action string) int {
	if action == GovernActionRemove {
		return governRemoveThreshold
	}
	return governDefaultThreshold
}

// GovernRequiredState 返回某动作要求的目标 state（册子 §2.1）。
func GovernRequiredState(action string) string {
	if action == GovernActionRevive {
		return "removed"
	}
	return "active"
}

// ProposalStatus 由两个一次性事实派生 status（册子 §4.4）。
func ProposalStatus(executedAt, voidedAt int64) string {
	switch {
	case executedAt != 0:
		return GovernStatusEffective
	case voidedAt != 0:
		return GovernStatusVoid
	default:
		return GovernStatusPending
	}
}

// Proposal 是 govern_proposals 的一行（册子 §5.1）。
type Proposal struct {
	ProposalID      int64
	Action          string
	ItemID          string
	ProposerID      string
	Reason          string
	Title           string // 仅 Action == GovernActionEdit 时非空
	BodyMD          string // 仅 Action == GovernActionEdit 时非空
	BaseContentHash string
	CreatedAt       int64
	ExecutedAt      int64
	VoidedAt        int64
	ExecutedResult  string
}

// ProposalView 是一条提案加上**当前有效票**与派生字段（册子 §3.3）。
type ProposalView struct {
	Proposal
	Votes     []string
	Threshold int
	Status    string
}

// proposalColumns 的列顺序必须与 scanProposal 的 Scan 参数一一对应。
const proposalColumns = `proposal_id,action,item_id,proposer_id,reason,title,body_md,base_content_hash,created_at,executed_at,voided_at,executed_result`

// rowScanner 抽象 *sql.Row 与 *sql.Rows 的 Scan。
type rowScanner interface{ Scan(dest ...any) error }

func scanProposal(sc rowScanner) (Proposal, error) {
	var p Proposal
	err := sc.Scan(&p.ProposalID, &p.Action, &p.ItemID, &p.ProposerID, &p.Reason, &p.Title, &p.BodyMD,
		&p.BaseContentHash, &p.CreatedAt, &p.ExecutedAt, &p.VoidedAt, &p.ExecutedResult)
	return p, err
}

// proposalVotersExec 按 voter_id 升序读某提案的全部投票人（未过滤名册）。
func proposalVotersExec(e sqlExec, proposalID int64) ([]string, error) {
	rows, err := e.Query(`SELECT voter_id FROM govern_votes WHERE proposal_id=? ORDER BY voter_id ASC`, proposalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// filterRoster 过滤出当前仍在名册内的投票人（册子 §2.3 实时复判）。空名册 ⇒ 空结果。
func filterRoster(ids []string, roster map[string]bool) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if roster[id] {
			out = append(out, id)
		}
	}
	return out
}

// CreateProposal 单事务写入提案行与提案人的第 1 票（册子 §2.3），返回新 proposal_id。
//
// 刻意**不做**生效判定：门槛最小为 2（册子 §2.1），此刻有效票恒为 1，判定必然 pending。
func (s *Store) CreateProposal(p Proposal) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.Exec(`INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,base_content_hash,created_at)
		VALUES(?,?,?,?,?,?,?,?)`,
		p.Action, p.ItemID, p.ProposerID, p.Reason, p.Title, p.BodyMD, p.BaseContentHash, p.CreatedAt)
	if err != nil {
		return 0, fmt.Errorf("store: 写提案: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)`,
		id, p.ProposerID, p.CreatedAt); err != nil {
		return 0, fmt.Errorf("store: 写提案人第 1 票: %w", err)
	}
	return id, tx.Commit()
}

// GetProposal 读一行提案；不存在返回 ok=false（册子 §3.2 的 404 分支）。
func (s *Store) GetProposal(id int64) (Proposal, bool, error) {
	p, err := scanProposal(s.db.QueryRow(`SELECT `+proposalColumns+` FROM govern_proposals WHERE proposal_id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Proposal{}, false, nil
	}
	if err != nil {
		return Proposal{}, false, err
	}
	return p, true, nil
}

// ListProposalViews 按 proposal_id 升序返回全部提案（含已生效与 void 的历史，册子 §3.3），
// 票已按 roster **实时复判**过滤。roster 传空 map 即册子 §6.2 的降级口径（有效票 = 0）。
func (s *Store) ListProposalViews(roster map[string]bool) ([]ProposalView, error) {
	rows, err := s.db.Query(`SELECT ` + proposalColumns + ` FROM govern_proposals ORDER BY proposal_id ASC`)
	if err != nil {
		return nil, err
	}
	// 先把提案行读尽并关闭游标，再逐条取票：连接池为单连接（store.go SetMaxOpenConns(1)），
	// 若在游标未闭合时嵌套查 govern_votes 会因拿不到连接而死锁。
	proposals := []Proposal{}
	for rows.Next() {
		p, err := scanProposal(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		proposals = append(proposals, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	out := []ProposalView{}
	for _, p := range proposals {
		voters, err := proposalVotersExec(s.db, p.ProposalID)
		if err != nil {
			return nil, err
		}
		out = append(out, ProposalView{
			Proposal:  p,
			Votes:     filterRoster(voters, roster),
			Threshold: GovernThreshold(p.Action),
			Status:    ProposalStatus(p.ExecutedAt, p.VoidedAt),
		})
	}
	return out, nil
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/store/ -run 'TestCreateAndGetProposal|TestCreateProposalWritesFirstVote' -v`
Expected: PASS。`TestListProposalViewsFiltersVotesByRoster` 调用 `st.AddVote`（Task 3 才实现），本 Task 阶段无法编译——把它**以块注释 `/* ... */` 保留在 `govern_test.go` 里**（并在注释里写明「留待 Task 3 解除注释」），**不要删掉**；Task 3 落地 `AddVote` 后解除注释即可一起跑通。

- [ ] **Step 5: 把 Task 1 的内联表达式改回调用真函数**

Task 1 的 `TestGovernThresholdAndStatusDerivation` 当时用了等价内联闭包（因为本 Task 的函数尚未存在）。现在真函数已在 `internal/store/govern.go`，把 `internal/store/govern_test.go` 里那个函数体整体替换为：

```go
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
```

（同时删掉该函数上方那段「⚠️ 偏差（Task 1）」注释。）

- [ ] **Step 6: 跑测试确认通过并提交**

Run: `go test ./internal/store/ -run 'TestGovernThresholdAndStatusDerivation' -v`
Expected: PASS

```bash
git add internal/store/govern.go internal/store/govern_test.go
git commit -m "feat(store): 治理提案的写入与读取（含门槛/状态派生与名册实时复判）"
```

---

## Task 3: 投票与生效事务

**Files:**
- Modify: `internal/store/govern.go`（追加 `ErrAlreadyVoted`、`VoteResult`、`AddVote`、`governPreconditionTx`、`governApplyTx`、`editItemTx`）
- Test: `internal/store/govern_test.go`（追加）

- [ ] **Step 1: 写失败测试**

先把 Task 2 里**以块注释保留**的 `TestListProposalViewsFiltersVotesByRoster` 解除注释（连同它上方那段「留待 Task 3」的说明注释一起删掉，只留测试函数本体）——`st.AddVote` 在本 Task 落地后即可编译。

然后在 `internal/store/govern_test.go` 追加（`signedSubmission` / `subSeedA` 来自 `submission_test.go`，同包可直接用）：

```go
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
```

同文件 `govern_test.go` 的 import 块补 `github.com/johocn/base/internal/protocol`（`strings` / `testing` 已在 Task 1 引入）。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/store/ -run 'TestAddVote' -v`
Expected: FAIL —— `undefined: ErrAlreadyVoted` / `undefined: (*Store).AddVote`

- [ ] **Step 3: 写最小实现**

在 `internal/store/govern.go` 追加（并在 import 块补 `time` 与 `github.com/johocn/base/internal/protocol`；`errors` / `database/sql` / `fmt` 已在 Task 2 引入，`st.encText` 是 store 包内方法）：

```go
// ErrAlreadyVoted 表示该身份已对本提案投过票（册子 §3.2 的 409）。
var ErrAlreadyVoted = errors.New("store: already voted")

// VoteResult 是一次投票落库后的判定结果，字段与 §3.2 的响应一一对应。
type VoteResult struct {
	ProposalID int64
	VoteCount  int
	Threshold  int
	Status     string
}

// AddVote 写入一张票，并在**同一事务内**做生效判定（册子 §4.4）：
// 有效票达门槛则执行动作并记 executed_at；前置条件不满足则记 voided_at。
//
// roster 由调用方在**事务外**派生（ContributorRoster）。空 map ⇒ 有效票 = 0，
// 即册子 §6.2「名册派生失败按空名册降级」的口径，提案停在 pending。
func (s *Store) AddVote(proposalID int64, voterID string, roster map[string]bool) (VoteResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return VoteResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := addVoteTx(tx, s, proposalID, voterID, roster)
	if err != nil {
		return VoteResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return VoteResult{}, err
	}
	return res, nil
}

// addVoteTx 是 AddVote 的事务体。
//
// **写语句刻意置于最前**：它让 SQLite 先取写锁、把并发投票串行化，
// 之后的读必然看到此前已提交的 executed_at / voided_at——这是册子 §4.4 步 1 成立的前提。
func addVoteTx(tx *sql.Tx, st *Store, proposalID int64, voterID string, roster map[string]bool) (VoteResult, error) {
	now := time.Now().UnixMilli()
	ins, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)
		ON CONFLICT(proposal_id,voter_id) DO NOTHING`, proposalID, voterID, now)
	if err != nil {
		return VoteResult{}, fmt.Errorf("store: 写票: %w", err)
	}
	n, err := ins.RowsAffected()
	if err != nil {
		return VoteResult{}, err
	}
	if n == 0 {
		return VoteResult{}, ErrAlreadyVoted
	}

	p, err := scanProposal(tx.QueryRow(`SELECT `+proposalColumns+` FROM govern_proposals WHERE proposal_id=?`, proposalID))
	if err != nil {
		return VoteResult{}, fmt.Errorf("store: 读提案 %d: %w", proposalID, err)
	}
	voters, err := proposalVotersExec(tx, proposalID)
	if err != nil {
		return VoteResult{}, err
	}
	out := VoteResult{
		ProposalID: proposalID,
		VoteCount:  len(filterRoster(voters, roster)),
		Threshold:  GovernThreshold(p.Action),
	}

	// 步 1：已定案（两个一次性事实任一非 0）→ 票已落库，不再判。
	if p.ExecutedAt != 0 || p.VoidedAt != 0 {
		out.Status = ProposalStatus(p.ExecutedAt, p.VoidedAt)
		return out, nil
	}
	// 步 3：未达门槛。
	if out.VoteCount < out.Threshold {
		out.Status = GovernStatusPending
		return out, nil
	}
	// 步 4 / 步 5：门槛已到，判前置条件（册子 §4.4）。
	met, err := governPreconditionTx(tx, p)
	if err != nil {
		return VoteResult{}, err
	}
	if !met {
		if _, err := tx.Exec(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`, now, proposalID); err != nil {
			return VoteResult{}, fmt.Errorf("store: 记 voided_at: %w", err)
		}
		out.Status = GovernStatusVoid
		return out, nil
	}
	result, err := governApplyTx(tx, st, p)
	if err != nil {
		return VoteResult{}, err
	}
	if _, err := tx.Exec(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`,
		now, result, proposalID); err != nil {
		return VoteResult{}, fmt.Errorf("store: 记 executed_at: %w", err)
	}
	out.Status = GovernStatusEffective
	return out, nil
}

// governPreconditionTx 判前置条件（册子 §4.4）：目标仍在、state 与动作匹配、content_hash 未变。
// 第 3 条是本册的乐观锁：授权针对的是**某一版内容**，那一版没了授权就永久作废。
func governPreconditionTx(tx *sql.Tx, p Proposal) (bool, error) {
	var state, hash string
	err := tx.QueryRow(`SELECT state,content_hash FROM items WHERE item_id=?`, p.ItemID).Scan(&state, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if state != GovernRequiredState(p.Action) {
		return false, nil
	}
	return hash == p.BaseContentHash, nil
}

// governApplyTx 在事务内执行受审动作，返回 executed_result（诊断信息，不构成契约，册子 §5.1）。
func governApplyTx(tx *sql.Tx, st *Store, p Proposal) (string, error) {
	switch p.Action {
	case GovernActionRemove:
		rev, err := nextContentVersionExec(tx)
		if err != nil {
			return "", err
		}
		if err := retireItemExec(tx, p.ItemID, rev); err != nil {
			return "", err
		}
		return "removed", nil
	case GovernActionRevive:
		// 内容行与块一直在（remove 只置状态），复活 = 删墓碑 + 回 active（册子 §4.3）。
		if _, err := tx.Exec(`DELETE FROM tombstones WHERE item_id=?`, p.ItemID); err != nil {
			return "", fmt.Errorf("store: 复活删墓碑 %s: %w", p.ItemID, err)
		}
		if _, err := tx.Exec(`UPDATE items SET state='active' WHERE item_id=?`, p.ItemID); err != nil {
			return "", fmt.Errorf("store: 复活置状态 %s: %w", p.ItemID, err)
		}
		return "revived", nil
	case GovernActionEdit:
		return editItemTx(tx, st, p)
	default:
		return "", fmt.Errorf("store: 不支持的治理动作 %q", p.Action)
	}
}

// editItemTx 执行改写（册子 §4.2）：全量覆盖 title / body_md，按 content_hash 是否变化决定归属后果。
// 只对 article 载体成立，受理阶段已挡住其余载体（册子 §0.3）。
func editItemTx(tx *sql.Tx, st *Store, p Proposal) (string, error) {
	hash := protocol.SHA256Hex([]byte(p.BodyMD))
	var oldHash string
	if err := tx.QueryRow(`SELECT content_hash FROM items WHERE item_id=?`, p.ItemID).Scan(&oldHash); err != nil {
		return "", fmt.Errorf("store: 读目标 content_hash %s: %w", p.ItemID, err)
	}
	bodyEnc, err := st.encText(p.BodyMD)
	if err != nil {
		return "", fmt.Errorf("store: 加密改写正文 %s: %w", p.ItemID, err)
	}
	if _, err := tx.Exec(`UPDATE articles SET title=?,body_md=?,content_hash=?,source_rev=? WHERE item_id=?`,
		p.Title, bodyEnc, hash, hash[:16], p.ItemID); err != nil {
		return "", fmt.Errorf("store: 改写 articles %s: %w", p.ItemID, err)
	}
	if oldHash == hash {
		// 正文逐字节未变（只改了标题）→ title 不在签名域内，旧签名仍成立 → 归属列原样保留。
		if _, err := tx.Exec(`UPDATE items SET title=?,content_hash=?,source_rev=?,updated_at=? WHERE item_id=?`,
			p.Title, hash, hash[:16], nowUTC(), p.ItemID); err != nil {
			return "", fmt.Errorf("store: 改写 items %s: %w", p.ItemID, err)
		}
		return "edited", nil
	}
	// 正文被改动 → author_sig 绑定的是旧 content_hash，旧签名必然失效（#23 §2.1 的数学推论）
	// → 两列清空、该作者贡献 −1（册子 §4.2）。治理改写不提供认领路径。
	if _, err := tx.Exec(`UPDATE items SET title=?,content_hash=?,source_rev=?,updated_at=?,author_id='',author_sig='' WHERE item_id=?`,
		p.Title, hash, hash[:16], nowUTC(), p.ItemID); err != nil {
		return "", fmt.Errorf("store: 改写 items %s: %w", p.ItemID, err)
	}
	return "edited_author_cleared", nil
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/store/ -v`
Expected: PASS —— `TestAddVote*` 全绿，`TestListProposalViewsFiltersVotesByRoster`（Task 2 写的）也转绿，既有 store 测试仍全绿。

- [ ] **Step 5: 提交**

```bash
git add internal/store/govern.go internal/store/govern_test.go
git commit -m "feat(store): 治理投票与生效事务（三动作 + 乐观锁 + 门槛分档）"
```

---

## Task 4: 契约常量与校验纯函数

**Files:**
- Create: `internal/httpapi/govern.go`（本 Task 只写常量与纯函数；Task 5 / Task 6 在同一文件追加 handler）
- Test: `internal/httpapi/govern_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/httpapi/govern_test.go`：

```go
package httpapi

import "testing"

func TestValidProposalAction(t *testing.T) {
	for _, a := range []string{"remove", "edit", "revive"} {
		if !validProposalAction(a) {
			t.Fatalf("应合法: %q", a)
		}
	}
	for _, a := range []string{"", "REMOVE", "delete", "add", "remove "} {
		if validProposalAction(a) {
			t.Fatalf("应非法: %q", a)
		}
	}
}

func TestValidProposalReason(t *testing.T) {
	// 缺省（空串）走「未给定」分支，由 handler 判；此处的判定只针对「已给定」。
	for _, raw := range []string{"", "   ", "\t\n", repeat("文", 201), "有\x00控制符", "有\x7f控制符"} {
		if _, ok := validProposalReason(raw); ok {
			t.Fatalf("应非法: %q", raw)
		}
	}
	for _, raw := range []string{"错别字", "  两边有空白  ", repeat("文", 200)} {
		s, ok := validProposalReason(raw)
		if !ok {
			t.Fatalf("应合法: %q", raw)
		}
		if s != trimSpace(raw) {
			t.Fatalf("应返回去空白后的值: %q → %q", raw, s)
		}
	}
}

func TestParseProposalID(t *testing.T) {
	for raw, want := range map[string]int64{"1": 1, "42": 42, "9007199254740993": 9007199254740993} {
		got, ok := parseProposalID(raw)
		if !ok || got != want {
			t.Fatalf("parseProposalID(%q)=(%d,%v) want (%d,true)", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", "0", "-1", "1.0", "abc", "1 ", " 1", "0x1"} {
		if got, ok := parseProposalID(raw); ok {
			t.Fatalf("parseProposalID(%q) 应失败，得 %d", raw, got)
		}
	}
}
```

`trimSpace` 不存在——在 `govern_test.go` 里补一个本地小 helper，避免与 `submit_test.go` 的 `repeat` 抢名字：

```go
func trimSpace(s string) string { return strings.TrimSpace(s) }
```

同文件 import 块：

```go
import (
	"strings"
	"testing"
)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/httpapi/ -run 'TestValidProposalAction|TestValidProposalReason|TestParseProposalID' -v`
Expected: FAIL —— `undefined: validProposalAction`

- [ ] **Step 3: 写最小实现**

创建 `internal/httpapi/govern.go`：

```go
package httpapi

import (
	"log"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/johocn/base/internal/store"
)

// 本册的文档级常量（册子 §6）：不做配置项，校准走「改册子 + 改常量」。
const (
	// 写限速：按已验签身份分两条路径、按客户端 IP 全治理面共用一条。
	proposalPerMinutePerID = 6
	proposalBurstPerID     = 3
	votePerMinutePerID     = 20
	voteBurstPerID         = 10
	governPerMinutePerIP   = 60
	governBurstPerIP       = 20

	// maxProposalReasonRunes 是 reason 的 rune 上限（册子 §3.1），与 title 同为 200。
	maxProposalReasonRunes = 200
)

// validProposalAction 按册子 §2.1：remove / edit / revive 三值枚举。
func validProposalAction(a string) bool {
	switch a {
	case store.GovernActionRemove, store.GovernActionEdit, store.GovernActionRevive:
		return true
	}
	return false
}

// hasControlChars 判 U+0000–U+001F 与 U+007F（册子 §3.1 的控制字符口径）。
func hasControlChars(s string) bool {
	for _, r := range s {
		if r <= 0x1F || r == 0x7F {
			return true
		}
	}
	return false
}

// validProposalReason 按册子 §3.1：去首尾空白后 1..200 rune 且不含控制字符。
// 返回去空白后的存储值；ok=false 表示「已给定但不合规」（缺省由 handler 单独判）。
func validProposalReason(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(s)
	if n < 1 || n > maxProposalReasonRunes {
		return "", false
	}
	return s, !hasControlChars(s)
}

// parseProposalID 解析路径里的 proposal_id：十进制正整数（册子 §5.1 的本地自增整数）。
func parseProposalID(raw string) (int64, bool) {
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

// governRoster 派生本节点名册为集合；ok=false 表示派生失败。
//
// 派生失败按册子 §6.2 降级：有效票 = 0（提案停在 pending）、展示为空名册，
// 且**不因此拒绝**提案 / 投票请求——故资格判定在 !ok 时放行（fail-open）。
func (s *Server) governRoster() (set map[string]bool, ok bool) {
	rows, err := s.st.ContributorRoster()
	if err != nil {
		log.Printf("httpapi: 名册派生失败，按空名册降级（治理册 §6.2）: %v", err)
		return map[string]bool{}, false
	}
	set = make(map[string]bool, len(rows))
	for _, c := range rows {
		set[c.ID] = true
	}
	return set, true
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/httpapi/ -run 'TestValidProposalAction|TestValidProposalReason|TestParseProposalID' -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/govern.go internal/httpapi/govern_test.go
git commit -m "feat(httpapi): 治理契约常量与校验纯函数"
```

---

## Task 5: `POST /v1/proposal` 写路径

**Files:**
- Modify: `internal/httpapi/govern.go`（追加 `proposalReq` / `proposalEditReq` / `handleProposalPost`）
- Modify: `internal/httpapi/server.go`（`Server` 字段 + `New()` 初始化 + 三条路由）
- Modify: `internal/httpapi/authmw.go`（`authErrText` 补 11 条 + 放宽 `author_id_forbidden` 文案）
- Test: `internal/httpapi/govern_test.go`（追加）

- [ ] **Step 1: 写失败测试**

在 `internal/httpapi/govern_test.go` 追加：

```go
const (
	// 四个治理者 + 一个只有身份、没有内容的非治理者。全部为 32 字节测试种子。
	govSeedA = "1111111111111111111111111111111111111111111111111111111111111111"
	govSeedB = "2222222222222222222222222222222222222222222222222222222222222222"
	govSeedC = "3333333333333333333333333333333333333333333333333333333333333333"
	govSeedD = "4444444444444444444444444444444444444444444444444444444444444444"
	govSeedX = "5555555555555555555555555555555555555555555555555555555555555555"
)

// governNode 是治理验收用的测试节点。
type governNode struct {
	st     *store.Store
	public string
}

// newGovernNode 起一个真 httpapi 节点（进程内），并预登记 A/B/C/D/X 五个身份。
// 注意不登记 testSeed：本册的名册完全由 A/B/C/D 的投稿构成。
func newGovernNode(t *testing.T) *governNode {
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
	n := &governNode{st: st, public: pub.URL}
	for _, seed := range []string{govSeedA, govSeedB, govSeedC, govSeedD, govSeedX} {
		id, pk := identityFromSeed(t, seed)
		if status, body := doIdentityJSON(t, http.MethodPost, n.public+"/v1/identity/register", "", registerBody(id, pk)); status != http.StatusOK {
			t.Fatalf("登记身份 %s status=%d body=%v", id, status, body)
		}
	}
	return n
}

// post 发一个已签名的 POST。
func (n *governNode) post(t *testing.T, seed, path, body string) (int, map[string]any) {
	t.Helper()
	return sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+path, body))
}

// publishArticle 用 seed 投一篇 ≥200 rune 的 article，返回正文（供 edit 用例原样回传）。
func (n *governNode) publishArticle(t *testing.T, seed, itemID, title string) string {
	t.Helper()
	body := title + repeat("文", 200)
	code, out := n.post(t, seed, "/v1/submit", submitBody(t, seed, "article", itemID, title, "body_md", body))
	if code != http.StatusOK {
		t.Fatalf("投稿 %s 失败: code=%d out=%v", itemID, code, out)
	}
	return body
}

// rosterCount 读匿名名册里某个 id 的条数；不在名册返回 0。
func (n *governNode) rosterCount(t *testing.T, id string) int {
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

// proposalBody 造一份提案体：action + item_id，再并入 extra。
func proposalBody(t *testing.T, action, itemID string, extra map[string]any) string {
	t.Helper()
	m := map[string]any{"action": action, "item_id": itemID}
	for k, v := range extra {
		m[k] = v
	}
	return mustJSON(t, m)
}

func TestProposalRejectsIdentityFieldsInBody(t *testing.T) {
	n := newGovernNode(t)
	body := n.publishArticle(t, govSeedB, "article/p1", "乙")
	// 目标归 B，提案人 A：本来能受理，只因请求体带了身份字段才被拒。
	for _, key := range []string{"proposer_id", "author_id"} {
		raw := proposalBody(t, "remove", "article/p1", map[string]any{key: "00000000000000000000000000000000"})
		code, out := n.post(t, govSeedA, "/v1/proposal", raw)
		if code != http.StatusBadRequest || out["code"] != "author_id_forbidden" {
			t.Fatalf("%s: code=%d out=%v", key, code, out)
		}
	}
	if _, ok, _ := n.st.GetProposal(1); ok {
		t.Fatal("拒绝时不得落库")
	}
	_ = body
}

func TestProposalRejectsBadActionReasonAndEditPayload(t *testing.T) {
	n := newGovernNode(t)
	n.publishArticle(t, govSeedB, "article/p2", "乙")
	cases := []struct {
		name string
		body string
		code int
		want string
	}{
		{"action", proposalBody(t, "delete", "article/p2", nil), http.StatusBadRequest, "proposal_action_unsupported"},
		{"reason-空", proposalBody(t, "remove", "article/p2", map[string]any{"reason": "   "}), http.StatusBadRequest, "proposal_reason_invalid"},
		{"reason-超长", proposalBody(t, "remove", "article/p2", map[string]any{"reason": repeat("文", 201)}), http.StatusBadRequest, "proposal_reason_invalid"},
		{"edit-无载荷", proposalBody(t, "edit", "article/p2", nil), http.StatusBadRequest, "proposal_edit_invalid"},
		{"edit-无 body_md", proposalBody(t, "edit", "article/p2", map[string]any{"edit": map[string]any{"title": "新"}}), http.StatusBadRequest, "proposal_edit_invalid"},
		{"edit-坏 title", proposalBody(t, "edit", "article/p2", map[string]any{"edit": map[string]any{"title": "  ", "body_md": "x"}}), http.StatusBadRequest, "proposal_edit_invalid"},
		{"edit-超限", proposalBody(t, "edit", "article/p2", map[string]any{"edit": map[string]any{"title": "新", "body_md": repeat("a", maxSubmitBytes+1)}}), http.StatusRequestEntityTooLarge, "proposal_too_large"},
	}
	for _, c := range cases {
		code, out := n.post(t, govSeedA, "/v1/proposal", c.body)
		if code != c.code || out["code"] != c.want {
			t.Fatalf("%s: code=%d out=%v want %d/%s", c.name, code, out, c.code, c.want)
		}
	}
	if _, ok, _ := n.st.GetProposal(1); ok {
		t.Fatal("拒绝时不得落库")
	}
}

func TestProposalRejectsItemNotFoundSelfOwnedAndStateMismatch(t *testing.T) {
	n := newGovernNode(t)
	n.publishArticle(t, govSeedB, "article/p3", "乙")
	// 404：目标不存在。
	if code, out := n.post(t, govSeedA, "/v1/proposal", proposalBody(t, "remove", "article/nope", nil)); code != http.StatusNotFound || out["code"] != "item_not_found" {
		t.Fatalf("不存在: code=%d out=%v", code, out)
	}
	// 403：目标是自己的条目（自己改自己走 POST /v1/submit）。
	if code, out := n.post(t, govSeedB, "/v1/proposal", proposalBody(t, "remove", "article/p3", nil)); code != http.StatusForbidden || out["code"] != "item_self_owned" {
		t.Fatalf("自己条目: code=%d out=%v", code, out)
	}
	// 400：active 条目提 revive。
	if code, out := n.post(t, govSeedA, "/v1/proposal", proposalBody(t, "revive", "article/p3", nil)); code != http.StatusBadRequest || out["code"] != "item_state_mismatch" {
		t.Fatalf("state 不匹配: code=%d out=%v", code, out)
	}
}

// 册子 §0.3：edit 仅限 article 载体；同一目标提 remove 则正常受理。
func TestProposalEditOnlyForArticleCarrier(t *testing.T) {
	n := newGovernNode(t)
	qj := `{"schema_version":1,"questions":[{"q":"1","options":["a"],"answer":0,"explain":""}]}`
	if err := n.st.UpsertQuiz(store.Quiz{
		ItemID: "quiz/z1", Title: "题组", QuestionJSON: qj,
		ContentHash: protocol.SHA256Hex([]byte(qj)), SourceRev: "rev-1",
	}); err != nil {
		t.Fatalf("UpsertQuiz: %v", err)
	}
	edit := proposalBody(t, "edit", "quiz/z1", map[string]any{"edit": map[string]any{"title": "新", "body_md": "正文"}})
	if code, out := n.post(t, govSeedA, "/v1/proposal", edit); code != http.StatusBadRequest || out["code"] != "proposal_edit_invalid" {
		t.Fatalf("非 article 载体提 edit: code=%d out=%v", code, out)
	}
	if code, out := n.post(t, govSeedA, "/v1/proposal", proposalBody(t, "remove", "quiz/z1", nil)); code != http.StatusCreated {
		t.Fatalf("非 article 载体提 remove 应受理: code=%d out=%v", code, out)
	}
}

func TestProposalRejectsNonGovernor(t *testing.T) {
	n := newGovernNode(t)
	n.publishArticle(t, govSeedB, "article/p4", "乙")
	// X 有身份但没内容 → 不在名册（等价于「名册第 11 名」）。
	if code, out := n.post(t, govSeedX, "/v1/proposal", proposalBody(t, "remove", "article/p4", nil)); code != http.StatusForbidden || out["code"] != "proposer_not_governor" {
		t.Fatalf("非治理者: code=%d out=%v", code, out)
	}
	if _, ok, _ := n.st.GetProposal(1); ok {
		t.Fatal("拒绝时不得落库")
	}
}

func TestProposalAuthAndRateLimit(t *testing.T) {
	n := newGovernNode(t)
	n.publishArticle(t, govSeedB, "article/p5", "乙")
	body := proposalBody(t, "remove", "article/p5", nil)

	// 无签名头：requireAuth 第 1 步。
	if code, out := doJSONMap(t, http.MethodPost, n.public+"/v1/proposal", body, nil); code != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("无签名头 code=%d out=%v", code, out)
	}
	// 限速：按身份的 burst 是 3，第 4 条必须 429。
	var code int
	var out map[string]any
	for i := 0; i <= proposalBurstPerID; i++ {
		code, out = n.post(t, govSeedA, "/v1/proposal", body)
		if i < proposalBurstPerID && code != http.StatusCreated {
			t.Fatalf("第 %d 条应 201: code=%d out=%v", i+1, code, out)
		}
	}
	if code != http.StatusTooManyRequests || out["code"] != "govern_rate_limited" {
		t.Fatalf("超限应 429: code=%d out=%v", code, out)
	}
}

// 受理成功：201 且带 threshold（remove 为 3）、status=pending、vote_count=1。
func TestProposalCreated(t *testing.T) {
	n := newGovernNode(t)
	n.publishArticle(t, govSeedB, "article/p6", "乙")
	code, out := n.post(t, govSeedA, "/v1/proposal", proposalBody(t, "remove", "article/p6", map[string]any{"reason": "明显违规"}))
	if code != http.StatusCreated {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if out["action"] != "remove" || out["item_id"] != "article/p6" ||
		out["threshold"] != float64(3) || out["status"] != "pending" || out["vote_count"] != float64(1) {
		t.Fatalf("响应不对: %v", out)
	}
	if _, ok := out["proposal_id"].(string); !ok {
		t.Fatalf("proposal_id 必须是字符串: %v", out["proposal_id"])
	}
}
```

文件 import 块补 `net/http`、`github.com/johocn/base/internal/protocol`、`github.com/johocn/base/internal/store`。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/httpapi/ -run TestProposal -v`
Expected: FAIL —— 路由不存在，`doJSONMap` / `sendAuth` 拿到 404；`undefined: governNode`

- [ ] **Step 3: 写最小实现**

**3a.** `internal/httpapi/govern.go` 追加：

```go
type proposalEditReq struct {
	Title string `json:"title"`
	// BodyMD 用指针以区分「键缺失」（400）与「空串」（合法：本册不设内容下限）。
	BodyMD *string `json:"body_md"`
}

type proposalReq struct {
	Action     string           `json:"action"`
	ItemID     string           `json:"item_id"`
	Reason     string           `json:"reason"`
	Edit       *proposalEditReq `json:"edit"`
	ProposerID json.RawMessage  `json:"proposer_id"`
	AuthorID   json.RawMessage  `json:"author_id"`
}

// handleProposalPost 是签名写路径 POST /v1/proposal（册子 §3.1）：名册内的治理者
// 对**他人**条目发起 remove / edit / revive 提案，签名即自动构成第 1 票。任何失败都不写入。
func (s *Server) handleProposalPost(w http.ResponseWriter, r *http.Request) {
	actor := identityFrom(r)
	var req proposalReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	// 提案人只能取自鉴权身份：请求体携带即等于替他人提案（册子 §3.1 硬约束）。
	if len(req.ProposerID) > 0 || len(req.AuthorID) > 0 {
		s.writeAuthErr(w, http.StatusBadRequest, "author_id_forbidden")
		return
	}
	if !validProposalAction(req.Action) {
		s.writeAuthErr(w, http.StatusBadRequest, "proposal_action_unsupported")
		return
	}
	// reason 可选（缺省空串）；但「已给定」却不合规要拒。
	reason, reasonOK := validProposalReason(req.Reason)
	if req.Reason != "" && !reasonOK {
		s.writeAuthErr(w, http.StatusBadRequest, "proposal_reason_invalid")
		return
	}
	title, bodyMD := "", ""
	if req.Action == store.GovernActionEdit {
		if req.Edit == nil || req.Edit.BodyMD == nil || !validItemTitle(req.Edit.Title) {
			s.writeAuthErr(w, http.StatusBadRequest, "proposal_edit_invalid")
			return
		}
		title, bodyMD = strings.TrimSpace(req.Edit.Title), *req.Edit.BodyMD
		if len(title)+len(bodyMD) > maxSubmitBytes {
			s.writeAuthErr(w, http.StatusRequestEntityTooLarge, "proposal_too_large")
			return
		}
	}
	if !s.proposalLimiterByID.allow(actor) || !s.governLimiterByIP.allow(clientIP(r)) {
		s.writeAuthErr(w, http.StatusTooManyRequests, "govern_rate_limited")
		return
	}
	it, ok, err := s.st.GetItem(req.ItemID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeAuthErr(w, http.StatusNotFound, "item_not_found")
		return
	}
	// 自己改自己走第 2 册的签名写路径，不需要审批（册子 §2.2）。空归属条目可治。
	if it.AuthorID != "" && it.AuthorID == actor {
		s.writeAuthErr(w, http.StatusForbidden, "item_self_owned")
		return
	}
	if it.State != store.GovernRequiredState(req.Action) {
		s.writeAuthErr(w, http.StatusBadRequest, "item_state_mismatch")
		return
	}
	// edit 只对 article 载体成立（册子 §0.3）：body_md 与 sha256(body_md) 只存在于 articles。
	if req.Action == store.GovernActionEdit && it.SQLiteTable != "articles" {
		s.writeAuthErr(w, http.StatusBadRequest, "proposal_edit_invalid")
		return
	}
	roster, rosterOK := s.governRoster()
	if rosterOK && !roster[actor] {
		s.writeAuthErr(w, http.StatusForbidden, "proposer_not_governor")
		return
	}
	id, err := s.st.CreateProposal(store.Proposal{
		Action: req.Action, ItemID: req.ItemID, ProposerID: actor,
		Reason: reason, Title: title, BodyMD: bodyMD,
		BaseContentHash: it.ContentHash, CreatedAt: time.Now().UnixMilli(),
	})
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusCreated, map[string]any{
		"proposal_id": strconv.FormatInt(id, 10),
		"action":      req.Action,
		"item_id":     req.ItemID,
		"vote_count":  1,
		"threshold":   store.GovernThreshold(req.Action),
		"status":      store.GovernStatusPending,
	})
}
```

`internal/httpapi/govern.go` 的 import 块补 `encoding/json`、`net/http`、`time`。

**3b.** `internal/httpapi/server.go`：`Server` 结构体加三个字段。

```go
	submitLimiterByID   *ipLimiter
	submitLimiterByIP   *ipLimiter
	proposalLimiterByID *ipLimiter
	voteLimiterByID     *ipLimiter
	governLimiterByIP   *ipLimiter
```

`New()` 里初始化（紧跟 `submitLimiterByIP` 一行之后）：

```go
		proposalLimiterByID: newIPLimiter(proposalPerMinutePerID, proposalBurstPerID),
		voteLimiterByID:     newIPLimiter(votePerMinutePerID, voteBurstPerID),
		governLimiterByIP:   newIPLimiter(governPerMinutePerIP, governBurstPerIP),
```

`publicMux()` 里注册（紧跟 `POST /v1/submit` 一行之后）：

```go
	// 审批治理（册子 §3）：提案与投票走签名写路径，列表是匿名公开读。
	mux.Handle("POST /v1/proposal", s.requireAuth(s.handleProposalPost))
	mux.Handle("POST /v1/proposal/{proposal_id}/vote", s.requireAuth(s.handleVotePost))
	mux.HandleFunc("GET /v1/proposal", s.handleProposalList)
```

（`handleVotePost` / `handleProposalList` 在 Task 6 写；本 Task 结束时这两条路由会因未定义而**编译不过**，故本 Task 只注册第一条，Task 6 再补后两条。**Step 3 实际只加这一行**：）

```go
	mux.Handle("POST /v1/proposal", s.requireAuth(s.handleProposalPost))
```

**3c.** `internal/httpapi/authmw.go` 的 `authErrText`：把 `author_id_forbidden` 一行改为下面文案，并追加本册 11 条。

```go
	"author_id_forbidden":      "请求体不得携带身份字段（author_id / proposer_id / id 等）",
	"proposal_action_unsupported": "action 只能是 remove / edit / revive",
	"proposal_reason_invalid":     "reason 必须是去首尾空白后 1..200 个字符，且不含控制字符",
	"proposal_edit_invalid":       "edit 载荷不合法：title 须为去首尾空白后 1..200 个字符且不含控制字符，body_md 必填，且目标必须是 article 载体",
	"proposal_too_large":          "title 与 body_md 的字节之和超过 32768",
	"item_not_found":              "目标 item_id 不存在",
	"item_self_owned":             "不能治理自己的条目，请改用 POST /v1/submit",
	"item_state_mismatch":         "动作与目标当前 state 不匹配",
	"proposer_not_governor":       "提案人不在本节点名册内",
	"proposal_not_found":          "提案不存在",
	"voter_not_governor":          "投票人不在本节点名册内",
	"already_voted":               "已对本提案投过票",
	"govern_rate_limited":         "治理操作过于频繁",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `gofmt -l internal/httpapi/` 确认无输出（`authErrText` 是 map 字面量，gofmt 会对齐）
Run: `go test ./internal/httpapi/ -run TestProposal -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/govern.go internal/httpapi/server.go internal/httpapi/authmw.go internal/httpapi/govern_test.go
git commit -m "feat(httpapi): 新增签名写路径 POST /v1/proposal"
```

---

## Task 6: 投票与匿名列表

**Files:**
- Modify: `internal/httpapi/govern.go`（追加 `voteReq` / `handleVotePost` / `proposalDTO` / `handleProposalList`）
- Modify: `internal/httpapi/server.go`（补后两条路由）
- Test: `internal/httpapi/govern_test.go`（追加）

- [ ] **Step 1: 写失败测试**

在 `internal/httpapi/govern_test.go` 追加：

```go
// propose 发一个提案并返回 proposal_id（断言 201）。
func (n *governNode) propose(t *testing.T, seed, action, itemID string, extra map[string]any) string {
	t.Helper()
	code, out := n.post(t, seed, "/v1/proposal", proposalBody(t, action, itemID, extra))
	if code != http.StatusCreated {
		t.Fatalf("提案 %s %s: code=%d out=%v", action, itemID, code, out)
	}
	id, _ := out["proposal_id"].(string)
	return id
}

// vote 投一票（空请求体）并返回响应。
func (n *governNode) vote(t *testing.T, seed, proposalID string) (int, map[string]any) {
	t.Helper()
	return n.post(t, seed, "/v1/proposal/"+proposalID+"/vote", "")
}

// proposals 拉匿名列表。
func (n *governNode) proposals(t *testing.T) []map[string]any {
	t.Helper()
	code, body := getJSON(t, n.public+"/v1/proposal")
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

func TestVoteRejectsUnknownProposalNonGovernorAndDuplicate(t *testing.T) {
	n := newGovernNode(t)
	n.publishArticle(t, govSeedB, "article/v1", "乙")

	// 404：提案不存在（含非数字路径段）。
	if code, out := n.vote(t, govSeedA, "999"); code != http.StatusNotFound || out["code"] != "proposal_not_found" {
		t.Fatalf("不存在: code=%d out=%v", code, out)
	}
	if code, out := n.vote(t, govSeedA, "abc"); code != http.StatusNotFound || out["code"] != "proposal_not_found" {
		t.Fatalf("非数字 id: code=%d out=%v", code, out)
	}
	// 403：投票人不在名册（X 无内容）。
	id := n.propose(t, govSeedA, "remove", "article/v1", nil)
	if code, out := n.vote(t, govSeedX, id); code != http.StatusForbidden || out["code"] != "voter_not_governor" {
		t.Fatalf("非治理者投票: code=%d out=%v", code, out)
	}
	// 409：提案人给自己已投的提案再投。
	if code, out := n.vote(t, govSeedA, id); code != http.StatusConflict || out["code"] != "already_voted" {
		t.Fatalf("提案人重复投票: code=%d out=%v", code, out)
	}
	// 400：请求体携带身份字段。
	if code, out := n.post(t, govSeedB, "/v1/proposal/"+id+"/vote", `{"voter_id":"00000000000000000000000000000000"}`); code != http.StatusBadRequest || out["code"] != "author_id_forbidden" {
		t.Fatalf("携带 voter_id: code=%d out=%v", code, out)
	}
}

// remove 分档：第 2 票仍 pending、第 3 票才生效（册子 §2.1 的关键分界）。
func TestVoteRemoveThresholdIsThree(t *testing.T) {
	n := newGovernNode(t)
	body := n.publishArticle(t, govSeedB, "article/v2", "乙")
	id := n.propose(t, govSeedA, "remove", "article/v2", nil)

	code, out := n.vote(t, govSeedC, id)
	if code != http.StatusOK || out["vote_count"] != float64(2) || out["threshold"] != float64(3) || out["status"] != "pending" {
		t.Fatalf("第 2 票: code=%d out=%v", code, out)
	}
	if it, _, _ := n.st.GetItem("article/v2"); it.State != "active" {
		t.Fatalf("第 2 票不得下架: %s", it.State)
	}
	code, out = n.vote(t, govSeedD, id)
	if code != http.StatusOK || out["vote_count"] != float64(3) || out["status"] != "effective" {
		t.Fatalf("第 3 票: code=%d out=%v", code, out)
	}
	if it, _, _ := n.st.GetItem("article/v2"); it.State != "removed" {
		t.Fatalf("应已下架: %s", it.State)
	}
	_ = body
}

// 匿名列表：不需签名头即 200；阈值随动作；votes 随名册实时增减。
func TestProposalListAnonymousAndRealtimeVotes(t *testing.T) {
	n := newGovernNode(t)
	n.publishArticle(t, govSeedB, "article/v3", "乙")
	cBody := n.publishArticle(t, govSeedC, "article/v3c", "丙")
	_ = cBody // C 有内容 → 在名册内

	id := n.propose(t, govSeedA, "remove", "article/v3", nil)
	if _, out := n.vote(t, govSeedC, id); out["status"] != "pending" {
		t.Fatalf("第 2 票应 pending: %v", out)
	}
	list := n.proposals(t)
	if len(list) != 1 {
		t.Fatalf("应有 1 条提案: %v", list)
	}
	p := list[0]
	if p["threshold"] != float64(3) || p["vote_count"] != float64(2) || p["status"] != "pending" {
		t.Fatalf("列表字段不对: %v", p)
	}
	votes, _ := p["votes"].([]any)
	if len(votes) != 2 {
		t.Fatalf("有效票应为 2: %v", votes)
	}

	// C 出榜：把它的文章改成不足门槛的短正文 → C 的条数归零。
	if err := n.st.UpsertArticle(store.Article{
		ItemID: "article/v3c", Title: "短", BodyMD: "短",
		ContentHash: protocol.SHA256Hex([]byte("短")), SourceRev: "rev-2",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	p = n.proposals(t)[0]
	if p["vote_count"] != float64(1) || p["status"] != "pending" {
		t.Fatalf("C 出榜后票数应回退到 1: %v", p)
	}
	// C 重新入榜 → 票恢复。
	if err := n.st.UpsertArticle(store.Article{
		ItemID: "article/v3c", Title: "丙", BodyMD: n.longBody("丙"),
		ContentHash: protocol.SHA256Hex([]byte(n.longBody("丙"))), SourceRev: "rev-3",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	p = n.proposals(t)[0]
	if p["vote_count"] != float64(2) {
		t.Fatalf("C 重新入榜后票应恢复: %v", p)
	}
	// edit 档门槛是 2。
	eid := n.propose(t, govSeedA, "edit", "article/v3", map[string]any{
		"edit": map[string]any{"title": "新标题", "body_md": n.longBody("乙")},
	})
	for _, item := range n.proposals(t) {
		if item["proposal_id"] != eid {
			continue
		}
		if item["threshold"] != float64(2) {
			t.Fatalf("edit 门槛应为 2: %v", item)
		}
	}
}

func TestVoteRateLimited(t *testing.T) {
	n := newGovernNode(t)
	n.publishArticle(t, govSeedB, "article/v4", "乙")
	id := n.propose(t, govSeedA, "remove", "article/v4", nil)
	// 提案人已投过 → 每次都 409；限速在鉴权与 404 之后、落库之前，用不存在提案更干净：
	var code int
	var out map[string]any
	for i := 0; i <= voteBurstPerID; i++ {
		code, out = n.vote(t, govSeedC, "999")
		if i < voteBurstPerID && code != http.StatusNotFound {
			t.Fatalf("第 %d 次应 404: code=%d out=%v", i+1, code, out)
		}
	}
	if code != http.StatusTooManyRequests || out["code"] != "govern_rate_limited" {
		t.Fatalf("超限应 429: code=%d out=%v", code, out)
	}
	_ = id
}
```

并在 `governNode` 上补一个小 helper（`publishArticle` 用它造长正文）：

```go
func (n *governNode) longBody(marker string) string { return marker + repeat("文", 200) }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/httpapi/ -run 'TestVote|TestProposalList' -v`
Expected: FAIL —— 投票与列表路由未注册（404）、`undefined: (*Server).handleVotePost`

- [ ] **Step 3: 写最小实现**

**3a.** `internal/httpapi/govern.go` 追加：

```go
type voteReq struct {
	VoterID  json.RawMessage `json:"voter_id"`
	AuthorID json.RawMessage `json:"author_id"`
	ID       json.RawMessage `json:"id"`
}

// handleVotePost 是签名写路径 POST /v1/proposal/{proposal_id}/vote（册子 §3.2）。
// 投票请求**可能带副作用**：这一票把有效票推到该动作门槛时，在同一事务内执行动作。
func (s *Server) handleVotePost(w http.ResponseWriter, r *http.Request) {
	actor := identityFrom(r)
	// 请求体可空（册子 §3.2）：空体与 {} 等价，故不能直接用 decodeJSON。
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBody))
	if err != nil {
		s.writeAuthErr(w, http.StatusBadRequest, "auth_body_read_failed")
		return
	}
	_ = r.Body.Close()
	if len(bytes.TrimSpace(raw)) > 0 {
		var req voteReq
		if err := json.Unmarshal(raw, &req); err != nil {
			s.writeError(w, http.StatusBadRequest, "bad_json")
			return
		}
		// 投票人只能取自鉴权身份：请求体携带任何身份字段都等于替他人投票。
		if len(req.VoterID) > 0 || len(req.AuthorID) > 0 || len(req.ID) > 0 {
			s.writeAuthErr(w, http.StatusBadRequest, "author_id_forbidden")
			return
		}
	}
	pid, ok := parseProposalID(r.PathValue("proposal_id"))
	if !ok {
		s.writeAuthErr(w, http.StatusNotFound, "proposal_not_found")
		return
	}
	if !s.voteLimiterByID.allow(actor) || !s.governLimiterByIP.allow(clientIP(r)) {
		s.writeAuthErr(w, http.StatusTooManyRequests, "govern_rate_limited")
		return
	}
	if _, ok, err := s.st.GetProposal(pid); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	} else if !ok {
		s.writeAuthErr(w, http.StatusNotFound, "proposal_not_found")
		return
	}
	roster, rosterOK := s.governRoster()
	if rosterOK && !roster[actor] {
		s.writeAuthErr(w, http.StatusForbidden, "voter_not_governor")
		return
	}
	res, err := s.st.AddVote(pid, actor, roster)
	if errors.Is(err, store.ErrAlreadyVoted) {
		s.writeAuthErr(w, http.StatusConflict, "already_voted")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"proposal_id": strconv.FormatInt(res.ProposalID, 10),
		"vote_count":  res.VoteCount,
		"threshold":   res.Threshold,
		"status":      res.Status,
	})
}

type proposalDTO struct {
	ProposalID string   `json:"proposal_id"`
	Action     string   `json:"action"`
	ItemID     string   `json:"item_id"`
	ProposerID string   `json:"proposer_id"`
	Reason     string   `json:"reason"`
	Title      string   `json:"title"`
	BodyMD     string   `json:"body_md"`
	Status     string   `json:"status"`
	Votes      []string `json:"votes"`
	VoteCount  int      `json:"vote_count"`
	Threshold  int      `json:"threshold"`
	CreatedAt  int64    `json:"created_at"`
	ExecutedAt int64    `json:"executed_at"`
	VoidedAt   int64    `json:"voided_at"`
}

type proposalsResponse struct {
	Proposals []proposalDTO `json:"proposals"`
}

// handleProposalList 匿名返回全部提案与**当前有效票**（册子 §3.3）：无需登录、无需签名头。
// 不分页、不支持过滤（量级假设见册子 §9 风险 6）；空列表返回 []（不是 null）。
func (s *Server) handleProposalList(w http.ResponseWriter, r *http.Request) {
	roster, _ := s.governRoster() // 派生失败按空名册降级（册子 §6.2）
	views, err := s.st.ListProposalViews(roster)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := proposalsResponse{Proposals: []proposalDTO{}}
	for _, v := range views {
		resp.Proposals = append(resp.Proposals, proposalDTO{
			ProposalID: strconv.FormatInt(v.ProposalID, 10),
			Action:     v.Action,
			ItemID:     v.ItemID,
			ProposerID: v.ProposerID,
			Reason:     v.Reason,
			Title:      v.Title,
			BodyMD:     v.BodyMD,
			Status:     v.Status,
			Votes:      v.Votes,
			VoteCount:  len(v.Votes),
			Threshold:  v.Threshold,
			CreatedAt:  v.CreatedAt,
			ExecutedAt: v.ExecutedAt,
			VoidedAt:   v.VoidedAt,
		})
	}
	s.writeJSON(w, http.StatusOK, resp)
}
```

`internal/httpapi/govern.go` 的 import 块补 `bytes`、`errors`、`io`。

**3b.** `internal/httpapi/server.go` 的 `publicMux()` 补后两条路由（紧跟 `POST /v1/proposal` 一行之后）：

```go
	mux.Handle("POST /v1/proposal/{proposal_id}/vote", s.requireAuth(s.handleVotePost))
	mux.HandleFunc("GET /v1/proposal", s.handleProposalList)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/httpapi/ -run 'TestVote|TestProposal' -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/govern.go internal/httpapi/server.go internal/httpapi/govern_test.go
git commit -m "feat(httpapi): 治理投票写路径与匿名列表 GET /v1/proposal"
```

---

## Task 7: 端到端 AC 与全量门禁

**Files:**
- Modify: `internal/httpapi/govern_test.go`（追加验收用例）

- [ ] **Step 1: 写验收测试**

在 `internal/httpapi/govern_test.go` 追加。先补三个共用 helper：

```go
// fourGovernors 造 4 个达门槛的作者 → 名册 4 人（AC 1 的前置）。
func fourGovernors(t *testing.T) *governNode {
	t.Helper()
	n := newGovernNode(t)
	n.publishArticle(t, govSeedA, "article/a1", "甲")
	n.publishArticle(t, govSeedB, "article/gb", "乙")
	n.publishArticle(t, govSeedC, "article/gc", "丙")
	n.publishArticle(t, govSeedD, "article/gd", "丁")
	return n
}

// unattributed 造一条空归属的 active article（模拟导入器 / tools/migrate 的存量内容）。
func (n *governNode) unattributed(t *testing.T, itemID, body string) {
	t.Helper()
	if err := n.st.UpsertArticle(store.Article{
		ItemID: itemID, Title: "存量", BodyMD: body,
		ContentHash: protocol.SHA256Hex([]byte(body)), SourceRev: "rev-legacy",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
}

// shrink 把某条 article 换成不足门槛的短正文（把作者挤出名册，用于实时复判用例）。
func (n *governNode) shrink(t *testing.T, itemID string) {
	t.Helper()
	n.unattributed(t, itemID, "短")
}
```

```go
// AC 1–3：remove 分档 —— 1 票 pending / 第 2 票仍 pending / 第 3 票 effective。
func TestGovernAC1To3RemoveThreshold(t *testing.T) {
	n := fourGovernors(t)
	bItem := "article/gb"
	id := n.propose(t, govSeedA, "remove", bItem, nil)
	if code, out := n.post(t, govSeedA, "/v1/proposal", proposalBody(t, "remove", bItem, nil)); false {
		_ = code
		_ = out
	}
	list := n.proposals(t)[0]
	if list["vote_count"] != float64(1) || list["threshold"] != float64(3) || list["status"] != "pending" {
		t.Fatalf("AC1: %v", list)
	}
	// AC 2：第 2 票仍 pending，目标仍是 active、无墓碑。
	code, out := n.vote(t, govSeedC, id)
	if code != http.StatusOK || out["status"] != "pending" {
		t.Fatalf("AC2: code=%d out=%v", code, out)
	}
	if it, _, _ := n.st.GetItem(bItem); it.State != "active" {
		t.Fatalf("AC2 目标应仍 active: %s", it.State)
	}
	// AC 3：第 3 票 effective，目标 removed 且有墓碑。
	code, out = n.vote(t, govSeedD, id)
	if code != http.StatusOK || out["status"] != "effective" {
		t.Fatalf("AC3: code=%d out=%v", code, out)
	}
	if it, _, _ := n.st.GetItem(bItem); it.State != "removed" {
		t.Fatalf("AC3 目标应 removed: %s", it.State)
	}
	var nTomb int
	if err := n.st.QueryRowTombstone(t, bItem); err != nil {
		t.Fatal(err)
	}
	_ = nTomb
}

// AC 4：revive 走 2 票档，不被 remove 的 3 票档带偏。
func TestGovernAC4ReviveTwoVotes(t *testing.T) {
	n := fourGovernors(t)
	bItem := "article/gb"
	rid := n.propose(t, govSeedA, "remove", bItem, nil)
	if _, out := n.vote(t, govSeedC, rid); out["status"] != "pending" {
		t.Fatalf("remove 第 2 票应 pending: %v", out)
	}
	if _, out := n.vote(t, govSeedD, rid); out["status"] != "effective" {
		t.Fatalf("remove 第 3 票应 effective: %v", out)
	}
	if got := n.rosterCount(t, mustID(t, govSeedB)); got != 0 {
		t.Fatalf("下架后 B 应掉出名册，得 %d", got)
	}
	vid := n.propose(t, govSeedA, "revive", bItem, nil)
	code, out := n.vote(t, govSeedC, vid)
	if code != http.StatusOK || out["threshold"] != float64(2) || out["status"] != "effective" {
		t.Fatalf("AC4: code=%d out=%v", code, out)
	}
	if it, _, _ := n.st.GetItem(bItem); it.State != "active" {
		t.Fatalf("AC4 复活后应 active: %s", it.State)
	}
	if got := n.rosterCount(t, mustID(t, govSeedB)); got != 1 {
		t.Fatalf("AC4 复活后 B 应回名册，得 %d", got)
	}
}

// AC 5：只改标题 → content_hash 不变、归属保留、B 的计数不减。
func TestGovernAC5EditTitleOnly(t *testing.T) {
	n := fourGovernors(t)
	body := n.longBody("乙")
	id := n.propose(t, govSeedA, "edit", "article/gb", map[string]any{
		"edit": map[string]any{"title": "新标题", "body_md": body},
	})
	code, out := n.vote(t, govSeedC, id)
	if code != http.StatusOK || out["threshold"] != float64(2) || out["status"] != "effective" {
		t.Fatalf("AC5: code=%d out=%v", code, out)
	}
	it, _, _ := n.st.GetItem("article/gb")
	if it.Title != "新标题" {
		t.Fatalf("AC5 标题应已改: %q", it.Title)
	}
	if it.ContentHash != protocol.SHA256Hex([]byte(body)) {
		t.Fatalf("AC5 content_hash 应不变")
	}
	if it.AuthorID != mustID(t, govSeedB) || it.AuthorSig == "" {
		t.Fatalf("AC5 归属应保留: %+v", it)
	}
	if got := n.rosterCount(t, mustID(t, govSeedB)); got != 1 {
		t.Fatalf("AC5 B 的计数不应减少，得 %d", got)
	}
}

// AC 6：改正文 → content_hash 变、归属清空、B 的计数 −1。
func TestGovernAC6EditBodyClears(t *testing.T) {
	n := fourGovernors(t)
	newBody := n.longBody("乙改")
	id := n.propose(t, govSeedA, "edit", "article/gb", map[string]any{
		"edit": map[string]any{"title": "新标题", "body_md": newBody},
	})
	if _, out := n.vote(t, govSeedC, id); out["status"] != "effective" {
		t.Fatalf("AC6 应生效: %v", out)
	}
	it, _, _ := n.st.GetItem("article/gb")
	if it.ContentHash != protocol.SHA256Hex([]byte(newBody)) || it.AuthorID != "" || it.AuthorSig != "" {
		t.Fatalf("AC6 应清空归属并重算 hash: %+v", it)
	}
	if got := n.rosterCount(t, mustID(t, govSeedB)); got != 0 {
		t.Fatalf("AC6 B 的计数应 −1（掉出），得 %d", got)
	}
	// 清空后该条仍可被继续治理（此时归 A 之外的所有人「他人」语义不变，因为已无归属）。
}

// AC 7：非治理者提案 → 403。
func TestGovernAC7NonGovernor(t *testing.T) {
	n := fourGovernors(t)
	if code, out := n.post(t, govSeedX, "/v1/proposal", proposalBody(t, "remove", "article/gb", nil)); code != http.StatusForbidden || out["code"] != "proposer_not_governor" {
		t.Fatalf("AC7: code=%d out=%v", code, out)
	}
}

// AC 8（分档冷启动）：名册 1 人 → 任何动作恒 pending；名册 2 人 → edit 可生效、remove 恒 pending。
func TestGovernAC8ColdStartByTier(t *testing.T) {
	// 名册 1 人：只有 A 有内容；两个目标都是空归属存量条目（不属于任何人）。
	n := newGovernNode(t)
	n.publishArticle(t, govSeedA, "article/a1", "甲")
	n.unattributed(t, "article/leg1", n.longBody("存1"))
	n.unattributed(t, "article/leg2", n.longBody("存2"))

	r1 := n.propose(t, govSeedA, "remove", "article/leg1", nil)
	if out := n.proposals(t)[0]; out["status"] != "pending" || out["threshold"] != float64(3) {
		t.Fatalf("AC8 一人名册 remove 应恒 pending: %v", out)
	}
	e1 := n.propose(t, govSeedA, "edit", "article/leg2", map[string]any{
		"edit": map[string]any{"title": "新", "body_md": n.longBody("存2改")},
	})
	for _, p := range n.proposals(t) {
		if p["proposal_id"] == e1 && p["status"] != "pending" {
			t.Fatalf("AC8 一人名册 edit 应恒 pending: %v", p)
		}
	}
	_ = r1

	// 名册 2 人：再加 B 的达标文章 → edit 可以 2 票生效，remove 仍差一票。
	m := newGovernNode(t)
	m.publishArticle(t, govSeedA, "article/a1", "甲")
	m.publishArticle(t, govSeedB, "article/gb", "乙")
	m.unattributed(t, "article/leg3", m.longBody("存3"))
	m.unattributed(t, "article/leg4", m.longBody("存4"))

	e2 := m.propose(t, govSeedA, "edit", "article/leg3", map[string]any{
		"edit": map[string]any{"title": "新", "body_md": m.longBody("存3改")},
	})
	if _, out := m.vote(t, govSeedB, e2); out["status"] != "effective" {
		t.Fatalf("AC8 二人名册 edit 应生效: %v", out)
	}
	r2 := m.propose(t, govSeedA, "remove", "article/leg4", nil)
	if _, out := m.vote(t, govSeedB, r2); out["status"] != "pending" {
		t.Fatalf("AC8 二人名册 remove 应恒 pending: %v", out)
	}
	if it, _, _ := m.st.GetItem("article/leg4"); it.State != "active" {
		t.Fatalf("AC8 remove 未生效不得动目标: %s", it.State)
	}
}

// AC 9：受理后、第 3 票前原作者更新该条 → 第 3 票投出后 void，新正文未被覆盖。
func TestGovernAC9OptimisticLock(t *testing.T) {
	n := fourGovernors(t)
	id := n.propose(t, govSeedA, "remove", "article/gb", nil)
	if _, out := n.vote(t, govSeedC, id); out["status"] != "pending" {
		t.Fatalf("AC9 第 2 票应 pending: %v", out)
	}
	// 原作者 B 用第 2 册的写路径更新该条（正文与签名一起换）。
	newBody := n.longBody("乙新")
	n.publishArticle(t, govSeedB, "article/gb", "乙新标题")
	code, out := n.vote(t, govSeedD, id)
	if code != http.StatusOK || out["status"] != "void" {
		t.Fatalf("AC9: code=%d out=%v", code, out)
	}
	it, _, _ := n.st.GetItem("article/gb")
	if it.Title != "乙新标题" || it.State != "active" {
		t.Fatalf("AC9 原作者的新正文不得被覆盖: %+v", it)
	}
	a, _, _ := n.st.GetArticle("article/gb")
	if a.BodyMD == newBody {
		t.Fatalf("AC9 正文不该是治理载荷")
	}
	if a.BodyMD != "乙新标题"+repeat("文", 200) {
		t.Fatalf("AC9 正文应是原作者的新版: %q", a.BodyMD)
	}
}

// AC 10：重复投票 409（含提案人）。AC 12：治理动作不产生归属。
func TestGovernAC10AndAC12(t *testing.T) {
	n := fourGovernors(t)
	id := n.propose(t, govSeedA, "remove", "article/gb", nil)
	if code, out := n.vote(t, govSeedC, id); code != http.StatusOK {
		t.Fatalf("AC10 第 2 票 code=%d out=%v", code, out)
	}
	if code, out := n.vote(t, govSeedC, id); code != http.StatusConflict || out["code"] != "already_voted" {
		t.Fatalf("AC10 重复投票: code=%d out=%v", code, out)
	}
	if code, out := n.vote(t, govSeedA, id); code != http.StatusConflict || out["code"] != "already_voted" {
		t.Fatalf("AC10 提案人重复投票: code=%d out=%v", code, out)
	}
	// AC 12：治理动作前后 A / C / D 的计数不变。
	for _, seed := range []string{govSeedA, govSeedC, govSeedD} {
		if got := n.rosterCount(t, mustID(t, seed)); got != 1 {
			t.Fatalf("AC12 治理者计数不应变化，得 %d", got)
		}
	}
}

// AC 11：无签名头 GET 200；votes 随名册实时增减；threshold 与 action 一致。
func TestGovernAC11AnonymousListRealtime(t *testing.T) {
	n := fourGovernors(t)
	id := n.propose(t, govSeedA, "remove", "article/gb", nil)
	if _, out := n.vote(t, govSeedC, id); out["status"] != "pending" {
		t.Fatalf("AC11: %v", out)
	}
	p := n.proposals(t)[0]
	if p["threshold"] != float64(3) || p["vote_count"] != float64(2) {
		t.Fatalf("AC11: %v", p)
	}
	// 把 C 挤出名册 → 票回退。
	n.shrink(t, "article/gc")
	if p = n.proposals(t)[0]; p["vote_count"] != float64(1) {
		t.Fatalf("AC11 出榜后应回退到 1: %v", p)
	}
	// C 恢复 → 票恢复。
	if err := n.st.UpsertArticle(store.Article{
		ItemID: "article/gc", Title: "丙", BodyMD: n.longBody("丙"),
		ContentHash: protocol.SHA256Hex([]byte(n.longBody("丙"))), SourceRev: "rev-back",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	if p = n.proposals(t)[0]; p["vote_count"] != float64(2) {
		t.Fatalf("AC11 恢复入榜后票应恢复: %v", p)
	}
}

// AC 14：非 article 载体 edit 400、remove 201（册子 §0.3）。
func TestGovernAC14CarrierBoundary(t *testing.T) {
	n := fourGovernors(t)
	qj := `{"schema_version":1,"questions":[{"q":"1","options":["a"],"answer":0,"explain":""}]}`
	if err := n.st.UpsertQuiz(store.Quiz{
		ItemID: "quiz/z1", Title: "题组", QuestionJSON: qj,
		ContentHash: protocol.SHA256Hex([]byte(qj)), SourceRev: "rev-1",
	}); err != nil {
		t.Fatalf("UpsertQuiz: %v", err)
	}
	edit := proposalBody(t, "edit", "quiz/z1", map[string]any{"edit": map[string]any{"title": "新", "body_md": "正文"}})
	if code, out := n.post(t, govSeedA, "/v1/proposal", edit); code != http.StatusBadRequest || out["code"] != "proposal_edit_invalid" {
		t.Fatalf("AC14 edit on quiz: code=%d out=%v", code, out)
	}
	if _, ok, _ := n.st.GetProposal(1); ok {
		t.Fatal("AC14 拒绝时不得落库")
	}
	if code, out := n.post(t, govSeedA, "/v1/proposal", proposalBody(t, "remove", "quiz/z1", nil)); code != http.StatusCreated {
		t.Fatalf("AC14 remove on quiz 应受理: code=%d out=%v", code, out)
	}
}
```

两个 helper 也要补上（放在 `govern_test.go` 末尾）：

```go
// mustID 由种子推出 author_id；失败即 t.Fatal。
func mustID(t *testing.T, seed string) string {
	t.Helper()
	id, _ := identityFromSeed(t, seed)
	return id
}

// QueryRowTombstone 读墓碑行，供 AC 3 断言「有行」。
// （写在 *governNode 上避免与 store 包的内部测试抢名。）
func (n *governNode) QueryRowTombstone(t *testing.T, itemID string) error {
	t.Helper()
	var rev int64
	if err := n.st.QueryRow(`SELECT revoked_rev FROM tombstones WHERE item_id=?`, itemID).Scan(&rev); err != nil {
		t.Fatalf("AC3 应存在墓碑行: %v", err)
	}
	return nil
}
```

**注意：** `n.st.QueryRow(...)` 在 `httpapi` 包内不可见（`store.Store` 的 `db` 字段未导出）。因此 `QueryRowTombstone` 改为在 **store 包**加一个只读小方法，再由测试调用：

在 `internal/store/govern.go` 追加：

```go
// TombstoneRev 读某条目的墓碑版本；ok=false 表示没有墓碑行。
// 供测试断言「下架写了墓碑 / 复活删了墓碑」，也供将来排障用。
func (s *Store) TombstoneRev(itemID string) (int64, bool, error) {
	var rev int64
	err := s.db.QueryRow(`SELECT revoked_rev FROM tombstones WHERE item_id=?`, itemID).Scan(&rev)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return rev, true, nil
}
```

`govern_test.go` 里把 `QueryRowTombstone` 换成：

```go
func (n *governNode) tombstone(t *testing.T, itemID string) (int64, bool) {
	t.Helper()
	rev, ok, err := n.st.TombstoneRev(itemID)
	if err != nil {
		t.Fatalf("TombstoneRev: %v", err)
	}
	return rev, ok
}
```

并把 `TestGovernAC1To3RemoveThreshold` 的结尾改成：

```go
	if _, ok := n.tombstone(t, bItem); !ok {
		t.Fatal("AC3 下架后应存在墓碑行")
	}
```

`internal/store/govern_test.go` 也应把 Task 3 里裸查 `st.db` 的两处改用 `st.TombstoneRev` 保持一致（可选，但推荐）：

```go
	if rev, ok, err := st.TombstoneRev("article/gv1"); err != nil || !ok || rev != 1 {
		t.Fatalf("墓碑 revoked_rev 应为 1: ok=%v rev=%d err=%v", ok, rev, err)
	}
```

- [ ] **Step 2: 跑验收测试**

Run: `go test ./internal/httpapi/ -run 'TestGovernAC' -v`
Expected: PASS（AC 1–12、14 共 9 个用例；AC 13 两节点为人工验收）

- [ ] **Step 3: 全量门禁**

```bash
gofmt -l internal/
go build ./...
go vet ./...
go test ./...
```

Expected：`gofmt -l` / `go build` / `go vet` 均无输出；`go test ./...` 全包 `ok`（含 `internal/store`、`internal/httpapi`、`internal/peersync`、`internal/packexport`）。

- [ ] **Step 4: 提交**

```bash
git add internal/store/govern.go internal/store/govern_test.go internal/httpapi/govern_test.go
git commit -m "test(govern): 审批治理 AC 1-12 与 14 端到端验收"
```

---

## Task 8: 文档回填与计划执行实况

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/superpowers/plans/2026-09-28-base-approval-governance-plan.md`（本文件）
- Modify（仅当出现执行期偏差）: `docs/superpowers/specs/2026-09-28-base-approval-governance-design.md`

- [ ] **Step 1: README 把本计划（#28）的状态翻为已执行**

本计划创建时已在 `docs/README.md` §3 文档清单登记 #28（状态「已出（待执行）」），符合 README 的「新增文档必须先登记」硬规则。执行完 Task 1–7 后，把该行的最后一列改为：

```markdown
| 已执行（完整度见计划「执行实况」；AC 13 待人工） |
```

- [ ] **Step 2: README 依赖图与当前阶段**

§4 依赖图里把治理主线两行改为：

```
治理主线（依赖 S1 身份与三载体课程体系）：
贡献度量与动态角色 (#23 → #24) ── 投稿写入 (#25 → #26) ─┬─ 审批治理（第 3 册：#27 册子 + #28 计划）
                                                       └─ 创作 UI（第 4 册，未立册）
```

§5 的「下一步（关键路径）」里，把 `**#27 册子已定稿，计划待出**（等明确指令后再出 plans）` 整段替换为：

```markdown
**#28 计划已出**（治理主线第 3 册；AC 13 两节点待人工）
```

- [ ] **Step 3: 回填本计划的「执行实况」**

在本文件末尾的「## 执行实况」一节里，把尖括号处替换为实际值与结论（不留空）：

```markdown
- Task 1–7 提交：<逐个列出 commit 短哈希与标题>
- 门禁：`gofmt -l internal/` / `go build ./...` / `go vet ./...` 无输出；`go test ./...` 全包 ok
- AC 1–12、14：自动通过；**AC 13（下架导出 → 接收侧删行删块；复活再导出 → 重新发布入库）待人工**
- 执行期更正：<「无」；或逐条写「册子原文 → 实际做法 → 原因」，并在册子 §0.2 同步>
```

若出现与册子的偏差，先在册子 `docs/superpowers/specs/2026-09-28-base-approval-governance-design.md` 的 `## 0. 改版说明` 下追加 `### 0.3 <日期> 执行期更正`（§0.3 已被「edit 载体范围补充」占用时顺延为 §0.4），再在本计划里引用该节。

- [ ] **Step 4: 提交**

```bash
git add docs/README.md docs/superpowers/plans/2026-09-28-base-approval-governance-plan.md
git commit -m "docs(plans): 治理主线第 3 册实施计划与执行实况回填"
```

---

## 手工验收（不属于任何 Task，交由人工执行）

**AC 13（治理结果经导出传播到接收侧）**：需两台节点，流程分两段。

1. **下架传播**：在节点 1 上按 AC 1–3 让 `remove` 生效（`state='removed'` + `tombstones` 有行）。执行一次导出（既有 `packexport` 路径，例如 `go run ./cmd/... export`，与 #13 / #22 的导出命令一致），把包投给节点 2（`peersync` 或手工分发）。节点 2 侧应表现为**既有墓碑路径**：该 `item_id` 从 `items` 中消失、对应块文件被删（`state='removed'` 的条目不再进入目录，接收侧按 `revoked_rev` 删行删块）。
2. **复活传播**：回到节点 1，对该 `item_id` 提 `revive` 并投到门槛使其生效（`state='active'`、墓碑行消失）。**再导出一次**。节点 2 侧应表现为「**更大 `content_version` 的重新发布**」——该 `item_id` 重新入库为 `active`，而不是被当作用户历史墓碑拒绝。

验证命令（在两台机器上分别执行）：

```bash
curl -s http://<node>/v1/items | grep <item_id>          # 目录里是否还在
ls <data-dir>/blobs | wc -l                              # 块数（下架后应减少，复活+反熵后回升）
curl -s http://<node>/v1/proposal                        # status / threshold 一致性
```

若节点 2 长时间离线，复活后的块需等反熵补齐才可用——**「导出成功」不等于「接收侧立即可用」**，这是册子 §9 风险 4 的已知边界，不是缺陷。

---

## 风险与边界（实施时勿越界）

1. **不改 `author_sig` 签名域**：`title` 不在待签字节里（#23 §2.1 契约出口 + 第 2 册 §7.1 已登记的缺口）。`edit` 只改标题时 `content_hash` 不变、归属保留，正是建立在「签名只覆盖 `content_hash`」这一事实上。任何「顺手把 title 加进待签字节」的改动都会作废已发布向量与存量 `author_sig`，属于改契约。
2. **不新增表以外的东西**：只有 `govern_proposals` / `govern_votes` 两张新表与一条索引，全部走 `CREATE ... IF NOT EXISTS`，**不加列、不改列、不 bump `schema_version`、不加配置项**。`govern_proposals.body_md` 按册子 §5.1 DDL **明文存储**（与 `articles.body_md` 走 `s.encText()` 不同）：提案本身是匿名公开读的（`GET /v1/proposal`），且不跨节点，加密只会让每次列表都多一次解密，不增加任何保护。
3. **不设内容下限**：`edit` 的 `title` / `body_md` 只受 `proposal_edit_invalid` 与 `maxSubmitBytes` 约束，与第 2 册口径一致；空正文的 article 可以被治理出来（只是不计贡献）。
4. **名册在事务外派生**：`AddVote(proposalID, voterID, roster)` 的 `roster` 由调用方在**生效事务之外**用 `store.ContributorRoster()` 派生后传入。原因见文件头「已核实的环境事实」第 3 条——事务内调 `ContributorRoster()` 会另开连接打 `s.db`，与持写锁的同一事务互锁。语义等价：名册只依赖 `items`，不依赖本次投票。**不要为了「更严谨」把它挪回事务内。**
5. **降级口径固定为 fail-open**：`governRoster()` 返回 `(set, ok)`；`!ok`（名册派生失败）时资格判定放行、计票按空名册（有效票 = 0 → 提案停 `pending`），并记日志告警。**不得改成「派生失败即拒绝提案/投票」**——册子 §6.2 的降级铁律是「不因此拒绝请求」。
6. **治理动作不产生归属、不入事件、不参与反熵**：治理不改 `items.author_id` / `author_sig`（除 `edit` 改正文时按契约清零），不写 `events`，不产生任何贡献记账。别把治理结果做成事件类型分发出去。
7. **提案不跨节点、不分页、不归档**：本节点自增 `proposal_id`，只在本地有效；`GET /v1/proposal` 全量返回（册子 §9 风险 6 已登记）。不引入定时器、不做清理任务、不加 `?limit=`。
8. **不改导出侧与反熵**：本册不给导出加触发条件、不做「治理后立即推送」。传播只发生在**下一次导出**时（册子 §9 风险 9）。

---

## 执行实况

- Task 1–7 提交（master，按序）：
  - `6d7ddde` feat(store): 治理两张新表与 sqlExec 抽壳（RetireItem/NextContentVersion 可跑在事务上）
  - `28539e8` feat(store): 治理提案的写入与读取（含门槛/状态派生与名册实时复判）
  - `5e7c2ef` feat(store): 治理投票与生效事务（三动作 + 乐观锁 + 门槛分档）
  - `592ec88` feat(httpapi): 治理契约常量与校验纯函数
  - `c40ef11` feat(httpapi): 新增签名写路径 POST /v1/proposal
  - `a1ead4b` feat(httpapi): 治理投票写路径与匿名列表 GET /v1/proposal
  - `cd401e5` test(govern): 审批治理 AC 1-12 与 14 端到端验收
  - 执行期更正的三次计划回写：`3229ed9`（Task 1 测试对 Task 2 符号的前向依赖）、`ee29b33`（单连接池不得嵌套查询）、`7b0d651`（Task 3 的 RetireItem 返回值）
- 门禁：`go build ./...` / `go vet ./...` 无输出；`go test ./...` 全包 ok。
  `gofmt -l internal/` 在本机 `go1.27.1` 下会列出 25 个**工作区为 CRLF 行尾**的既有文件（索引侧均为 LF，与本册无关）；本册涉及的 9 个 Go 文件在 `gofmt -l` 下无输出。
- AC 1–12、14：自动通过（`go test ./internal/httpapi/ -run TestGovernAC`）；**AC 13（下架导出 → 接收侧删行删块；复活再导出 → 重新发布入库）待人工**
- 执行期更正：3 条，已在册子 `docs/superpowers/specs/2026-09-28-base-approval-governance-design.md` §0.4 同步
  1. 计划原文：Task 5 / 6 用例用 `newGovernNode` + 只给 B 投一篇来造节点。实际做法：把 Task 7 的 `fourGovernors` 提前到 Task 5 定义，Task 5 / 6 用例统一以「A/B/C/D 各投一篇」建立 4 人名册（目标条目仍归 B：`article/gb`）。原因：提案人与投票人必须在名册内（册子 §4.3），只给 B 投一篇时 A 的提案与 C 的投票都会被 403，用例前提与名册派生互斥；`newGovernNode` 保持「只登记身份、不种名册」，供 AC 8 冷启动与 AC 14 使用。
  2. 计划原文：Task 7 的 AC 1–3 在 `internal/store` 新增 `Store.TombstoneRev` 供测试断言墓碑行。实际做法：直接用既有公开读法 `Store.ListTombstones()` 过滤目标 `item_id`，不新增任何生产代码。
  3. 册子原文：§1、§6 与第 4 册接缝处写「11 条新错误码」。实际做法：§6 表格为 12 行、实现亦为 12 条，四处计数改为 12。原因：计数笔误，不涉及契约与实现。
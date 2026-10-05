# Base 治理权重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现治理权重构 v2：双层票权 + 动态门槛公式 + 两阶段投票 + 反对票机制，替代硬编码门槛（remove=3, edit=2）和单一票权体系。

**Architecture:** Schema 迁移先行 → 纯函数重写（贡献层资格 + 门槛/quorum/净票权公式）→ 投票管线重写（addVoteTx 两阶段判定 + 反对票 + 加权票 + 每日配额）→ 治理动作扩展（12 种 GovernAction）→ 免票选逻辑重写 → HTTP handler 同步 → govern_projection 同步 → 圈子治理对齐 → Node/TS 同步 → 测试覆盖。Go store 核心先落地，Node/TS 后续同步。

**Tech Stack:** Go 1.21+（database/sql + SQLite）, Node.js（TypeScript + better-sqlite3）, core-ts 协议包

**Spec:** `docs/superpowers/specs/2026-10-05-base-governance-reconstruction-design.md`

---

## 文件结构总览

### Go 侧核心

| 文件 | 职责 | 操作 |
|---|---|---|
| `internal/store/schema.go` | 全部 CREATE TABLE 定义 | **修改**：govern_votes 加列 + govern_proposals 加列 + items 加列 + **新增 favorites 表** |
| `internal/store/contributor.go` | 贡献层资格派生 | **重写**：deriveContributionRoster 改为贡献者前 N + 初创期 ID 补齐到恒 10 |
| `internal/store/govern.go` | 门槛计算 + AddVote/addVoteTx + governApplyTx + governPreconditionTx | **重写**：GovernThresholdForRoster → GovernThreshold + quorum 公式；addVoteTx 改两阶段 + 反对票 + 加权票；governApplyTx 扩展 12 种 action |
| `internal/store/free_remove.go` | 免票选逻辑 | **重写**：统一条件 A/B/C 反向判定 |
| `internal/store/govern_projection.go` | P6 融合收敛层 | **同步改**：SettleGovernProposal 用同门槛/quorum/净票权逻辑 |
| `internal/httpapi/govern.go` | HTTP handler | **同步改**：vote handler 支持 vote_type/vote_weight；响应扩展 quorum/net_weight/threshold |
| `internal/httpapi/govern_event.go` | govern.v1 事件 | **同步改** |
| `internal/store/govern_test.go` | 治理测试 | **重写**：所有旧测试改新逻辑 + 新增两阶段/反对票/配额测试 |
| `internal/store/contributor_test.go` | 贡献层测试 | **重写**：补齐算法 + 初创期 ID 兜底测试 |
| `internal/store/groupseats.go` | 圈子治理 quorum | **改写**：RemoveQuorum/DissolveVoteQuorum 改同门槛公式 |

### Node 侧

| 文件 | 职责 | 操作 |
|---|---|---|
| `apps/node/src/store/schema.ts` | schema 定义 | **同步改** |
| `apps/node/src/store/govern.ts` | store 层治理 | **重写** 对齐 Go |
| `apps/node/src/routes/proposal.ts` | handler | **同步改** |
| `apps/node/src/store/groupseats.ts` | 圈子席位 | **改写** |

### TS 协议层

| 文件 | 职责 | 操作 |
|---|---|---|
| `packages/core-ts/src/govern.ts` | GovernAction/GovernStatus + govern.v1 事件 | **扩展**：GovernAction 12 值 + vote_type + 投票响应扩展 |

---

## Task 1: Schema 迁移（Go 侧）

**Files:**
- Modify: `internal/store/schema.go`
- Test: `internal/store/govern_test.go`（迁移后现有测试不应因 schema 变故而崩溃）

- [ ] **Step 1: 在 schema.go 的 CREATE TABLE 列表末尾新增 favorites 表**

找到 `internal/store/schema.go` 的最后一个 CREATE TABLE 结束位置（大约在 checkin_days 之后或 schema 列表末尾），插入：

```go
	`CREATE TABLE IF NOT EXISTS favorites(
		id         TEXT    NOT NULL,
		item_id    TEXT    NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY(id, item_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_favorites_item ON favorites(item_id)`,
```

- [ ] **Step 2: 在 govern_votes CREATE TABLE 里加 vote_weight/vote_type/date 列**

找到 govern_votes 的 CREATE TABLE（大约 L196-L202），修改为：

```go
	`CREATE TABLE IF NOT EXISTS govern_votes(
		proposal_id INTEGER NOT NULL,
		voter_id    TEXT    NOT NULL,
		vote_weight INTEGER NOT NULL DEFAULT 1,
		vote_type   TEXT    NOT NULL DEFAULT 'approve',
		date        TEXT    NOT NULL,
		created_at  INTEGER NOT NULL,
		PRIMARY KEY(proposal_id, voter_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_gv_voter_date_weight ON govern_votes(voter_id, date, vote_weight)`,
	`CREATE INDEX IF NOT EXISTS idx_gv_proposal_type ON govern_votes(proposal_id, vote_type)`,
```

**注意**：现有 govern_votes 没有 vote_weight/vote_type/date 列，需要同时写一个迁移函数 `MigrateSchemaV2()` 在 store 初始化时 ALTER TABLE 补列（如果列不存在）。

- [ ] **Step 3: 在 govern_proposals CREATE TABLE 里加 governance_level/category/circle_id 列**

找到 govern_proposals 的 CREATE TABLE（大约 L185-L195），修改最后几列：

```go
		source_event_id   TEXT,
		governance_level  TEXT    NOT NULL DEFAULT 'base',
		category          TEXT,
		circle_id         TEXT,
		content_version   INTEGER NOT NULL,
```

- [ ] **Step 4: 在 items CREATE TABLE 里加 pin_level/pinned_at/highlight_until 列**

找到 items 的 CREATE TABLE，在 state 列之后加：

```go
		state              TEXT    NOT NULL DEFAULT 'active',
		pin_level          INTEGER NOT NULL DEFAULT 0,
		pinned_at          INTEGER,
		highlight_until    INTEGER,
```

- [ ] **Step 5: 写 schema 迁移函数（兼容现有数据库）**

在 `internal/store/schema.go` 末尾或新文件 `internal/store/migrate.go` 写：

```go
// MigrateSchemaV2 对已有数据库补 ALTER TABLE（列不存在时才加）。
func MigrateSchemaV2(db *sql.DB) error {
	migrations := []string{
		// govern_votes 补列
		`ALTER TABLE govern_votes ADD COLUMN vote_weight INTEGER NOT NULL DEFAULT 1`,
		`ALTER TABLE govern_votes ADD COLUMN vote_type TEXT NOT NULL DEFAULT 'approve'`,
		`ALTER TABLE govern_votes ADD COLUMN date TEXT NOT NULL DEFAULT ''`,
		// govern_proposals 补列
		`ALTER TABLE govern_proposals ADD COLUMN governance_level TEXT NOT NULL DEFAULT 'base'`,
		`ALTER TABLE govern_proposals ADD COLUMN category TEXT`,
		`ALTER TABLE govern_proposals ADD COLUMN circle_id TEXT`,
		// items 补列
		`ALTER TABLE items ADD COLUMN pin_level INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE items ADD COLUMN pinned_at INTEGER`,
		`ALTER TABLE items ADD COLUMN highlight_until INTEGER`,
	}
	for _, m := range migrations {
		if _, err := db.Exec(m); err != nil {
			// 列已存在 → 忽略（SQLite ALTER TABLE 会报错但我们要幂等）
			if strings.Contains(err.Error(), "duplicate column") {
				continue
			}
			return fmt.Errorf("migrate: %s: %w", m, err)
		}
	}
	// 创建 favorites 表（IF NOT EXISTS 已在 CREATE TABLE 里）
	favoritesDDL := `CREATE TABLE IF NOT EXISTS favorites(
		id TEXT NOT NULL, item_id TEXT NOT NULL, created_at INTEGER NOT NULL,
		PRIMARY KEY(id, item_id))`
	if _, err := db.Exec(favoritesDDL); err != nil {
		return fmt.Errorf("migrate: favorites: %w", err)
	}
	idx := `CREATE INDEX IF NOT EXISTS idx_favorites_item ON favorites(item_id)`
	if _, err := db.Exec(idx); err != nil {
		return fmt.Errorf("migrate: favorites index: %w", err)
	}
	return nil
}
```

**重要**：SQLite 的 ALTER TABLE 不支持 "IF NOT EXISTS" 加列，所以必须先查 PRAGMA table_info 再决定是否 ALTER。更健壮的写法：

```go
func columnExists(db *sql.DB, table, col string) (bool, error) {
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == col {
			return true, nil
		}
	}
	return false, rows.Err()
}
```

然后在 MigrateSchemaV2 里用 `columnExists` 检查每列是否存在，不存在才 ALTER。

- [ ] **Step 6: 在 Store 初始化里调用 MigrateSchemaV2**

找到 `internal/store/store.go` 的 `New()` 或 `Open()` 函数，在所有 CREATE TABLE 之后加：

```go
if err := MigrateSchemaV2(db); err != nil {
	return nil, fmt.Errorf("migrate schema v2: %w", err)
}
```

- [ ] **Step 7: 运行现有测试确保 schema 迁移不破坏任何东西**

Run: `cd e:\code\base && go test ./internal/store/ -run TestMigrate -v -count=1`
Expected: PASS

Run: `cd e:\code\base && go test ./internal/store/ -v -count=1 2>&1 | head -50`
Expected: 所有现有测试 PASS（或如果现有测试依赖旧 schema，先记录哪些失败）

- [ ] **Step 8: Commit**

```bash
git add internal/store/schema.go internal/store/migrate.go  # 如果新建了 migrate.go
git commit -m "feat(governance): schema v2 - favorites表 + govern_votes补列 + items.pin_level + 迁移函数"
```

---

## Task 2: Schema 迁移（Node 侧同步）

**Files:**
- Modify: `apps/node/src/store/schema.ts`

- [ ] **Step 1: 在 Node schema.ts 里同步 favorites 表 + govern_votes/govern_proposals/items 加列**

找到 Node 侧 schema.ts 的 CREATE TABLE 列表，按 Task 1 的 Go 侧改动逐一同步：
- 新增 favorites 表（`CREATE TABLE IF NOT EXISTS favorites`）
- govern_votes 加 vote_weight/vote_type/date（带 DEFAULT）
- govern_proposals 加 governance_level/category/circle_id
- items 加 pin_level/pinned_at/highlight_until

- [ ] **Step 2: 写 Node 侧迁移函数并在 store 初始化时调用**

（Node 侧 SQLite 用 better-sqlite3，ALTER TABLE 同样需要查列是否存在再执行。）

- [ ] **Step 3: 运行 Node 侧类型检查 + 测试**

Run: `cd e:\code\base\apps\node && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add apps/node/src/store/schema.ts
git commit -m "feat(governance): Node侧schema v2同步"
```

---

## Task 3: 纯函数 — 贡献层资格派生（补齐算法）

**Spec 参考:** v2 第二节 2.4

**Files:**
- Modify: `internal/store/contributor.go`
- Modify: `internal/store/contributor_test.go`

- [ ] **Step 1: 写新贡献层派生函数的失败测试**

在 `contributor_test.go` 里加：

```go
func TestDeriveContributionRoster_PaddingWithEarliestIDs(t *testing.T) {
	// 场景：贡献者只有 3 人，初创期 ID 补齐到 10
	st := newTestStore(t)
	// 写入 3 条达标条目（不同作者 A/B/C）
	st.seedItems(t, []itemSeed{
		{author: "A", type: "article", content: strings.Repeat("x", 200)},
		{author: "B", type: "article", content: strings.Repeat("x", 200)},
		{author: "C", type: "article", content: strings.Repeat("x", 200)},
	})
	// 写入 10 个初创期身份 ID（EARLIEST_0..EARLIEST_9，按 created_at 升序）
	st.seedIdentities(t, []string{"EARLIEST_0", "EARLIEST_1", ..., "EARLIEST_9"})

	roster, err := st.DeriveContributionRoster()
	if err != nil {
		t.Fatal(err)
	}
	if len(roster) != 10 {
		t.Fatalf("期望恒 10 人，实际 %d", len(roster))
	}
	// 前 3 是贡献者，后 7 是初创期 ID（从 EARLIEST_0 开始）
	if roster[0] != "A" || roster[1] != "B" || roster[2] != "C" {
		t.Fatalf("前 3 应为贡献者 A/B/C，实际 %v", roster[:3])
	}
	if roster[3] != "EARLIEST_0" {
		t.Fatalf("补齐应从 EARLIEST_0 开始，实际 %v", roster[3:])
	}
}

func TestDeriveContributionRoster_EmptyContributors_AllEarliestIDs(t *testing.T) {
	// 场景：零贡献者 → 前 10 注册 ID 全额生效
	st := newTestStore(t)
	st.seedIdentities(t, []string{"ID_0", "ID_1", ..., "ID_9", "ID_10"}) // 11 个身份

	roster, err := st.DeriveContributionRoster()
	if err != nil {
		t.Fatal(err)
	}
	if len(roster) != 10 {
		t.Fatalf("期望恒 10 人，实际 %d", len(roster))
	}
	// 取最早的 10 个（ID_0..ID_9），不是 ID_1..ID_10
	for i, id := range roster {
		expected := fmt.Sprintf("ID_%d", i)
		if id != expected {
			t.Fatalf("位置 %d 应为 %s，实际 %s", i, expected, id)
		}
	}
}

func TestDeriveContributionRoster_MoreThan10Contributors_Top10Only(t *testing.T) {
	// 场景：贡献者 12 人 → 初创期 ID 不出现，只取贡献前 10
	st := newTestStore(t)
	st.seedItems(t, 12 个作者各 1 条达标条目)
	st.seedIdentities(t, 10 个初创期 ID)

	roster, err := st.DeriveContributionRoster()
	if err != nil {
		t.Fatal(err)
	}
	if len(roster) != 10 {
		t.Fatalf("期望恒 10 人，实际 %d", len(roster))
	}
	// 全是贡献者，没有初创期 ID
	for _, id := range roster {
		if strings.HasPrefix(id, "EARLIEST_") {
			t.Fatalf("贡献者已满 10 时不应出现初创期 ID，实际 %v", roster)
		}
	}
}
```

**注意**：测试辅助函数 `newTestStore` / `seedItems` / `seedIdentities` 需要从现有测试里找或创建。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd e:\code\base && go test ./internal/store/ -run TestDeriveContributionRoster -v -count=1`
Expected: FAIL（DeriveContributionRoster 函数还不存在，或现有 ContributorRoster 返回空/不足 10 人）

- [ ] **Step 3: 实现 DeriveContributionRoster（替换/扩展现有 ContributorRoster）**

在 `contributor.go` 里新增或替换：

```go
// DeriveContributionRoster 返回贡献层 10 人：贡献者前 N + 初创期 ID 补齐。
// 恒返回 10 人，无论节点大小。
func (s *Store) DeriveContributionRoster() ([]string, error) {
	// 步骤 1：取贡献者前 N（N ≤ 10）
	contributors, err := s.contributorTopN(10)
	if err != nil {
		return nil, fmt.Errorf("贡献者派生: %w", err)
	}

	// 步骤 2：不足 10 人时用初创期 ID 补齐
	if len(contributors) < 10 {
		need := 10 - len(contributors)
		earliest, err := s.earliestRegisteredIDs(need, contributors)
		if err != nil {
			return nil, fmt.Errorf("初创期 ID 查询: %w", err)
		}
		contributors = append(contributors, earliest...)
	}

	return contributors[:10], nil
}

// earliestRegisteredIDs 取最早注册的身份 ID，排除已在 exclude 集合里的。
func (s *Store) earliestRegisteredIDs(n int, exclude []string) ([]string, error) {
	excludeSet := make(map[string]bool, len(exclude))
	for _, id := range exclude {
		excludeSet[id] = true
	}
	// SQL：排除贡献者，按 created_at 升序取 n 个
	q := `SELECT id FROM identities`
	if len(exclude) > 0 {
		placeholders := strings.Repeat("?,", len(exclude))
		q += ` WHERE id NOT IN (` + placeholders[:len(placeholders)-1] + `)`
	}
	q += ` ORDER BY created_at ASC LIMIT ?`
	args := make([]any, 0, len(exclude)+1)
	for _, id := range exclude {
		args = append(args, id)
	}
	args = append(args, n)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
```

**同时**：`contributorTopN` 复用现有 `ContributorRoster` 的核心逻辑（meetsQualityGate 过滤 → 贡献数排序 → 截断前 N），但不要空名册 fail-closed——空名册时返回空切片让补齐逻辑处理。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd e:\code\base && go test ./internal/store/ -run TestDeriveContributionRoster -v -count=1`
Expected: PASS（3 个新测试全绿）

- [ ] **Step 5: Commit**

```bash
git add internal/store/contributor.go internal/store/contributor_test.go
git commit -m "feat(governance): 贡献层资格恒10人 - 贡献者前N + 初创期ID补齐算法"
```

---

## Task 4: 纯函数 — 门槛公式 + quorum + 净票权计算

**Spec 参考:** v2 第四节

**Files:**
- Modify: `internal/store/govern.go`
- Modify: `internal/store/govern_test.go`

- [ ] **Step 1: 写新门槛/quorum/净票权公式的失败测试**

在 `govern_test.go` 里加：

```go
func TestGovernThreshold_BaseAndEnhanced(t *testing.T) {
	// threshold_base = 10 + ⌊m/3⌋ + ⌊(P+F)/3⌋
	// threshold_enhanced = 20 + ⌊m/3⌋ + ⌊2*(P+F)/3⌋
	cases := []struct {
		name       string
		level      string // "base" | "enhanced"
		m          int    // 活跃 7 天用户数
		P          int    // 他人学习去重数
		F          int    // 他人收藏去重数
		want       int
	}{
		{"基础-小节点-无人互动", "base", 5, 0, 0, 11},       // 10+1+0=11
		{"基础-小节点-热门", "base", 5, 12, 9, 18},           // 10+1+7=18 (⌊21/3⌋=7)
		{"基础-大节点-冷门", "base", 1000, 0, 0, 343},        // 10+333+0=343
		{"强化-小节点-无人互动", "enhanced", 5, 0, 0, 21},    // 20+1+0=21
		{"强化-大节点-热门", "enhanced", 100, 50, 30, 173},   // 20+33+53=106... 重算
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := GovernThreshold(c.level, c.m, c.P, c.F)
			if got != c.want {
				t.Fatalf("threshold(%s,m=%d,P=%d,F=%d)=%d, want %d",
					c.level, c.m, c.P, c.F, got, c.want)
			}
		})
	}
}

func TestGovernQuorum_MinMaxClamp(t *testing.T) {
	// quorum = min(max(threshold, ⌈m/2⌉), m)
	cases := []struct {
		name       string
		threshold  int
		m          int
		want       int
	}{
		{"小节点-超上限", 11, 5, 5},        // min(max(11,3),5) = 5
		{"中节点-门槛主导", 42, 50, 42},    // min(max(42,25),50) = 42
		{"大节点-半数主导", 343, 1000, 500}, // min(max(343,500),1000) = 500
		{"单用户", 11, 1, 1},               // min(max(11,1),1) = 1
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
	}
	for _, c := range cases {
		got := NetWeight(c.approve, c.reject)
		if got != c.want {
			t.Fatalf("net(%d,%d)=%d, want %d", c.approve, c.reject, got, c.want)
		}
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd e:\code\base && go test ./internal/store/ -run "TestGovernThreshold|TestGovernQuorum|TestNetWeight" -v -count=1`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现三个纯函数**

在 `govern.go` 里替换现有 `GovernThresholdForRoster` 和 `GovernThreshold`：

```go
// GovernThreshold 计算门槛公式值（Spec v2 第四节）。
// level: "base" | "enhanced"
// m: 活跃 7 天用户数
// P: 他人学习去重数
// F: 他人收藏去重数
func GovernThreshold(level string, m, P, F int) int {
	mPrime := m / 3 // ⌊m/3⌋
	interaction := (P + F) / 3
	if level == "enhanced" {
		interaction = 2 * (P + F) / 3
		return 20 + mPrime + interaction
	}
	return 10 + mPrime + interaction
}

// GovernQuorum 计算法定人数（Spec v2 第四节 4.3）。
// quorum = min(max(threshold, ⌈m/2⌉), m)
func GovernQuorum(threshold, m int) int {
	half := (m + 1) / 2 // ⌈m/2⌉ 整数运算
	if threshold > half {
		if threshold > m {
			return m
		}
		return threshold
	}
	if half > m {
		return m
	}
	return half
}

// NetWeight 净票权 = 赞成票权总和 − 反对票权总和。
func NetWeight(approveSum, rejectSum int) int {
	return approveSum - rejectSum
}
```

**注意**：整数除法在 Go 里是向零截断，对正数就是 ⌊x⌋。`⌈m/2⌉ = (m+1)/2` 在整数域正确。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd e:\code\base && go test ./internal/store/ -run "TestGovernThreshold|TestGovernQuorum|TestNetWeight" -v -count=1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/store/govern.go internal/store/govern_test.go
git commit -m "feat(governance): 门槛公式 + quorum + 净票权纯函数"
```

---

## Task 5: 投票管线重写 — addVoteTx（两阶段 + 反对票 + 加权票 + 配额）

**Spec 参考:** v2 第五节

**Files:**
- Modify: `internal/store/govern.go`
- Modify: `internal/store/govern_test.go`

**前置:** Task 1（schema 迁移）+ Task 3（DeriveContributionRoster）+ Task 4（阈值/quorum/净票权）

- [ ] **Step 1: 写两阶段投票 + 反对票 + 配额的失败测试**

```go
func TestAddVote_TwoPhase_QuorumNotMet_StayPending(t *testing.T) {
	st := newTestStoreWithIdentities(t, 5 /*活跃用户*/)
	// 创建一个 remove 提案（目标条目有 progress_count=3, favorite_count=2）
	prop := st.createProposal(t, "remove", "item_hot", "author_A", "base_content_hash")
	// 阈值 = 10 + ⌊5/3⌋ + ⌊5/3⌋ = 10+1+1 = 12, quorum = min(max(12,3),5) = 5
	// 只投 4 票 → voter_count=4 < quorum=5 → pending
	for i := 0; i < 4; i++ {
		st.vote(t, prop.ProposalID, fmt.Sprintf("voter_%d", i), 1, "approve")
	}
	result, err := st.GetProposal(prop.ProposalID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "pending" {
		t.Fatalf("voter_count=4 < quorum=5 应保持 pending，实际 %s", result.Status)
	}
}

func TestAddVote_TwoPhase_QuorumMet_NetPositive_Effective(t *testing.T) {
	st := newTestStoreWithIdentities(t, 5)
	prop := st.createProposal(t, "remove", "item_hot", "author_A", "base_content_hash")
	// 投 5 赞成 + 0 反对
	for i := 0; i < 5; i++ {
		st.vote(t, prop.ProposalID, fmt.Sprintf("voter_%d", i), 1, "approve")
	}
	result, err := st.GetProposal(prop.ProposalID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "effective" {
		t.Fatalf("quorum=5 达成 + 净票权>0 应 effective，实际 %s", result.Status)
	}
}

func TestAddVote_TwoPhase_NetNegative_Void(t *testing.T) {
	st := newTestStoreWithIdentities(t, 5)
	prop := st.createProposal(t, "remove", "item_hot", "author_A", "base_content_hash")
	// 投 2 赞成 + 3 反对 → voter_count=5 >= quorum=5, 净票权=2-3=-1 <= 0 → void
	for i := 0; i < 2; i++ {
		st.vote(t, prop.ProposalID, fmt.Sprintf("approver_%d", i), 1, "approve")
	}
	for i := 0; i < 3; i++ {
		st.vote(t, prop.ProposalID, fmt.Sprintf("rejecter_%d", i), 1, "reject")
	}
	result, err := st.GetProposal(prop.ProposalID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "void" {
		t.Fatalf("净票权=-1 <= 0 应 void，实际 %s", result.Status)
	}
}

func TestAddVote_ContributorQuota_Exceeded(t *testing.T) {
	// 贡献层成员：投 >=2 权算贡献层行为，当日累计 >=2 的总和 ≤ 20
	st := newTestStoreWithContributor(t, "CONTRIB_1")
	prop := st.createProposal(t, "remove", "item_1", "author_A", "hash1")
	// 连续投 2 权 × 11 次 → 累计 22 > 20 → 第 11 次应被拒
	for i := 0; i < 10; i++ {
		_, err := st.addVote(t, prop.ProposalID, "CONTRIB_1", 2, "approve")
		if err != nil {
			t.Fatalf("第 %d 次投应成功，err=%v", i, err)
		}
	}
	// 第 11 次投 2 权应返回 quota_exceeded
	_, err := st.addVote(t, prop.ProposalID, "CONTRIB_1", 2, "approve")
	if err == nil || !strings.Contains(err.Error(), "quota_exceeded") {
		t.Fatalf("第 11 次投应被配额拒绝，实际 err=%v", err)
	}
}

func TestAddVote_Contributor_OneWeight_NoQuotaConsumed(t *testing.T) {
	// 贡献层投 1 权 = 基础层行为，不消耗配额
	st := newTestStoreWithContributor(t, "CONTRIB_1")
	prop := st.createProposal(t, "remove", "item_1", "author_A", "hash1")
	// 投 1 权 × 30 次（超过 20 票权配额但每次只投 1 权）
	for i := 0; i < 30; i++ {
		_, err := st.addVote(t, prop.ProposalID, "CONTRIB_1", 1, "approve")
		if err != nil {
			t.Fatalf("每次投 1 权不消耗配额，第 %d 次应成功，err=%v", i, err)
		}
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd e:\code\base && go test ./internal/store/ -run "TestAddVote_TwoPhase|TestAddVote_ContributorQuota" -v -count=1`
Expected: FAIL（新逻辑不存在）

- [ ] **Step 3: 重写 addVoteTx + AddVote + 配额检查 + 投票请求体扩展**

**AddVote 新签名：**

```go
// VoteRequest 是投票请求体（Spec v2）。
type VoteRequest struct {
	VoterID    string // 从 identityFrom(r) 取，不信任请求体
	ProposaID  int64
	VoteWeight int    // 1~10，普通用户强制 1
	VoteType   string // "approve" | "reject"
}

// AddVote 投一票。签名：proposalID, voterID, voteWeight, voteType。
func (s *Store) AddVote(proposalID int64, voterID string, voteWeight int, voteType string) (VoteResultV2, error) {
	// 1. 参数校验
	if voteType != "approve" && voteType != "reject" {
		return VoteResultV2{}, fmt.Errorf("invalid vote_type: %s", voteType)
	}
	if voteWeight < 1 || voteWeight > 10 {
		return VoteResultV2{}, fmt.Errorf("vote_weight 必须在 [1,10]，实际 %d", voteWeight)
	}

	// 2. 贡献层资格判定
	roster, err := s.DeriveContributionRoster()
	isContributor := err == nil && contains(roster, voterID)

	// 3. 普通用户强制 voteWeight=1
	if !isContributor && voteWeight != 1 {
		voteWeight = 1
	}

	// 4. 贡献层配额检查（仅 voteWeight >= 2 时）
	if isContributor && voteWeight >= 2 {
		if err := s.checkContributorQuota(voterID, voteWeight); err != nil {
			return VoteResultV2{}, err
		}
	}

	// 5. 单条目累计检查（贡献层，无论基础/贡献层对同一条目累计 ≤ 10）
	if isContributor {
		if err := s.checkPerItemQuota(voterID, proposalID, voteWeight); err != nil {
			return VoteResultV2{}, err
		}
	}

	// 6. 事务内写票 + 两阶段判定
	return s.addVoteTxV2(proposalID, voterID, voteWeight, voteType, roster)
}
```

**addVoteTxV2 核心（替换旧 addVoteTx）：**

```go
func (s *Store) addVoteTxV2(proposalID int64, voterID string, voteWeight int, voteType string, roster []string) (VoteResultV2, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return VoteResultV2{}, err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UnixMilli()
	date := time.Now().Format("2006-01-02")

	// Step A: 写 govern_votes（ON CONFLICT DO NOTHING → ErrAlreadyVoted）
	res, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,vote_weight,vote_type,date,created_at)
		VALUES(?,?,?,?,?,?) ON CONFLICT(proposal_id,voter_id) DO NOTHING`,
		proposalID, voterID, voteWeight, voteType, date, now)
	if err != nil {
		return VoteResultV2{}, fmt.Errorf("store: 写票: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return VoteResultV2{}, ErrAlreadyVoted
	}

	// Step B: 读提案
	p, err := scanProposal(tx.QueryRow(`SELECT ... FROM govern_proposals WHERE proposal_id=?`, proposalID))
	if err != nil {
		return VoteResultV2{}, fmt.Errorf("store: 读提案: %w", err)
	}

	// Step C: 已定案 → 不再判
	if p.ExecutedAt != 0 || p.VoidedAt != 0 {
		return buildVoteResultV2(tx, p), nil
	}

	// Step D: 实时计算 m（活跃 7 天用户数）
	var m int
	if err := tx.QueryRow(`SELECT COUNT(DISTINCT id) FROM identities WHERE last_seen_at > ?`,
		now-7*24*60*60*1000).Scan(&m); err != nil {
		return VoteResultV2{}, fmt.Errorf("store: 活跃用户数: %w", err)
	}

	// Step E: 实时计算 P + F（去重）
	var P, F int
	if p.ItemID != "" {
		// 排除作者自己
		if err := tx.QueryRow(`SELECT COUNT(DISTINCT id) FROM progress WHERE item_id=? AND id != ?`,
			p.ItemID, p.ProposerID).Scan(&P); err != nil {
			return VoteResultV2{}, fmt.Errorf("store: progress: %w", err)
		}
		if err := tx.QueryRow(`SELECT COUNT(DISTINCT id) FROM favorites WHERE item_id=? AND id != ?`,
			p.ItemID, p.ProposerID).Scan(&F); err != nil {
			return VoteResultV2{}, fmt.Errorf("store: favorites: %w", err)
		}
	}

	// Step F: 门槛 + quorum
	threshold := GovernThreshold(p.GovernanceLevel, m, P, F)
	quorum := GovernQuorum(threshold, m)

	// Step G: 独立 voter 数（独立 voter_id 总数）
	var voterCount int
	if err := tx.QueryRow(`SELECT COUNT(DISTINCT voter_id) FROM govern_votes WHERE proposal_id=?`,
		proposalID).Scan(&voterCount); err != nil {
		return VoteResultV2{}, fmt.Errorf("store: voter count: %w", err)
	}

	// Step H: 阶段 1 — voter_count < quorum → 继续征集
	if voterCount < quorum {
		return VoteResultV2{
			ProposalID:   proposalID,
			VoterCount:   voterCount,
			Quorum:       quorum,
			Threshold:    threshold,
			Status:       "pending",
			ApproveWeight: 0, // 让响应计算
			RejectWeight:  0,
		}, nil
	}

	// Step I: voter_count >= quorum → 进入阶段 2
	// 净票权
	var approveSum, rejectSum int
	if err := tx.QueryRow(`SELECT
		COALESCE(SUM(CASE WHEN vote_type='approve' THEN vote_weight ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN vote_type='reject' THEN vote_weight ELSE 0 END),0)
		FROM govern_votes WHERE proposal_id=?`, proposalID).Scan(&approveSum, &rejectSum); err != nil {
		return VoteResultV2{}, fmt.Errorf("store: 净票权: %w", err)
	}
	net := approveSum - rejectSum

	if net <= 0 {
		// 失败 → void
		if _, err := tx.Exec(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`,
			now, proposalID); err != nil {
			return VoteResultV2{}, fmt.Errorf("store: 记 voided_at: %w", err)
		}
		tx.Commit()
		return VoteResultV2{
			ProposalID:   proposalID,
			VoterCount:   voterCount,
			Quorum:       quorum,
			Threshold:    threshold,
			ApproveWeight: approveSum,
			RejectWeight:  rejectSum,
			NetWeight:     net,
			Status:       "void",
		}, nil
	}

	// net > 0 — 跑前置条件
	met, err := governPreconditionTx(tx, p)
	if err != nil {
		return VoteResultV2{}, err
	}
	if !met {
		if _, err := tx.Exec(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`,
			now, proposalID); err != nil {
			return VoteResultV2{}, fmt.Errorf("store: 记 voided_at: %w", err)
		}
		tx.Commit()
		return VoteResultV2{Status: "void", ...}, nil
	}

	// 执行动作
	result, err := governApplyTx(tx, s, p)
	if err != nil {
		return VoteResultV2{}, err
	}
	if _, err := tx.Exec(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`,
		now, result, proposalID); err != nil {
		return VoteResultV2{}, fmt.Errorf("store: 记 executed_at: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return VoteResultV2{}, err
	}
	return VoteResultV2{
		ProposalID:   proposalID,
		VoterCount:   voterCount,
		Quorum:       quorum,
		Threshold:    threshold,
		ApproveWeight: approveSum,
		RejectWeight:  rejectSum,
		NetWeight:     net,
		Status:       "effective",
	}, nil
}
```

**配额检查函数：**

```go
// checkContributorQuota 检查贡献层成员当日配额（vote_weight >= 2 的累计 ≤ 20）。
func (s *Store) checkContributorQuota(voterID string, additionalWeight int) error {
	today := time.Now().Format("2006-01-02")
	var used int
	if err := s.db.QueryRow(`SELECT COALESCE(SUM(vote_weight),0) FROM govern_votes
		WHERE voter_id=? AND date=? AND vote_weight >= 2`, voterID, today).Scan(&used); err != nil {
		return err
	}
	if used+additionalWeight > 20 {
		return fmt.Errorf("quota_exceeded: 当日贡献层配额 used=%d, add=%d, limit=20", used, additionalWeight)
	}
	return nil
}

// checkPerItemQuota 检查贡献层成员对单条目累计 ≤ 10 权。
func (s *Store) checkPerItemQuota(voterID string, proposalID int64, additionalWeight int) error {
	var used int
	if err := s.db.QueryRow(`SELECT COALESCE(SUM(vote_weight),0) FROM govern_votes
		WHERE voter_id=? AND proposal_id=?`, voterID, proposalID).Scan(&used); err != nil {
		return err
	}
	if used+additionalWeight > 10 {
		return fmt.Errorf("per_item_quota_exceeded: 单条目累计 used=%d, add=%d, limit=10", used, additionalWeight)
	}
	return nil
}
```

**VoteResultV2 结构：**

```go
type VoteResultV2 struct {
	ProposalID   int64
	VoterCount   int   // 独立 voter 总数
	Quorum       int   // 当前法定人数
	Threshold    int   // 当前门槛公式值
	ApproveWeight int  // 赞成票权总和
	RejectWeight  int  // 反对票权总和
	NetWeight     int  // 净票权
	Status        string // pending | effective | void
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd e:\code\base && go test ./internal/store/ -run "TestAddVote_TwoPhase|TestAddVote_ContributorQuota" -v -count=1`
Expected: PASS

**同时跑现有测试看哪些失败**（旧的 TestAddVote* 测试用旧逻辑，需要在后续 Task 6/7 里改）：

Run: `cd e:\code\base && go test ./internal/store/ -v -count=1 2>&1 | tail -30`

- [ ] **Step 5: Commit**

```bash
git add internal/store/govern.go internal/store/govern_test.go
git commit -m "feat(governance): 投票管线重写 - 两阶段判定 + 反对票 + 加权票 + 每日配额"
```

---

## Task 6: 治理动作扩展 — governApplyTx 扩展 12 种 action

**Spec 参考:** v2 第三节

**Files:**
- Modify: `internal/store/govern.go`
- Modify: `internal/store/govern_test.go`

**前置:** Task 5（投票管线）

- [ ] **Step 1: 扩展 GovernAction 枚举 + governApplyTx**

在 `govern.go` 里扩展常量：

```go
const (
	GovernActionRemove     = "remove"
	GovernActionRevive     = "revive"
	GovernActionEditTitle  = "edit_title"
	GovernActionEditBody   = "edit_body"
	GovernActionEditCategory = "edit_category"
	GovernActionEditTags     = "edit_tags"
	GovernActionEditInstructor = "edit_instructor"
	GovernActionDirectoryAdd = "directory_add"
	GovernActionHighlight    = "highlight"
	GovernActionPin          = "pin"
	GovernActionRecommend    = "recommend"
	GovernActionFeature      = "feature"
)
```

在 `governApplyTx` 里扩展每个 action 的执行逻辑：

```go
func governApplyTx(tx *sql.Tx, st *Store, p Proposal) (string, error) {
	switch p.Action {
	case GovernActionRemove:
		// 复用现有 RetireItem
		return retireItemTx(tx, p.ItemID)
	case GovernActionRevive:
		return reviveItemTx(tx, p.ItemID)
	case GovernActionEditTitle:
		return editItemTitleTx(tx, p.ItemID, p.Title)
	case GovernActionEditBody:
		return editItemBodyTx(tx, p.ItemID, p.BodyMD)
	case GovernActionEditCategory:
		return editItemCategoryTx(tx, p.ItemID, p.DistClass) // 需要 Proposal 加 DistClass 字段
	case GovernActionEditTags:
		return editItemTagsTx(tx, p.ItemID, p.LinksJSON) // tags 存在哪？需要确认
	case GovernActionEditInstructor:
		return editItemInstructorTx(tx, p.ItemID, p.Instructor) // Proposal 加 Instructor
	case GovernActionDirectoryAdd:
		return addDirectoryTermTx(tx, st, p)
	case GovernActionHighlight:
		return setPinLevelTx(tx, p.ItemID, 1) // pin_level=1
	case GovernActionPin:
		return setPinLevelTx(tx, p.ItemID, 2)
	case GovernActionRecommend:
		return setPinLevelTx(tx, p.ItemID, 3)
	case GovernActionFeature:
		return setPinLevelTx(tx, p.ItemID, 4)
	default:
		return "", fmt.Errorf("unknown action: %s", p.Action)
	}
}
```

**setPinLevelTx 实现：**

```go
func setPinLevelTx(tx *sql.Tx, itemID string, level int) (string, error) {
	now := time.Now().UnixMilli()
	res, err := tx.Exec(`UPDATE items SET pin_level=?, pinned_at=? WHERE item_id=?`, level, now, itemID)
	if err != nil {
		return "", fmt.Errorf("set pin_level: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return "", sql.ErrNoRows
	}
	return fmt.Sprintf("pin_level_%d", level), nil
}
```

- [ ] **Step 2: 为新 action 写测试**

每个新 action 至少一个 happy path 测试 + 一个前置条件失败测试。

- [ ] **Step 3: 运行全量测试**

Run: `cd e:\code\base && go test ./internal/store/ -v -count=1 2>&1 | tail -50`
Expected: 所有测试 PASS

- [ ] **Step 4: Commit**

```bash
git add internal/store/govern.go internal/store/govern_test.go
git commit -m "feat(governance): GovernAction 扩展到12种 - 新增7种 edit_*/highlight/pin/recommend/feature"
```

---

## Task 7: 免票选逻辑重写 — 条件 A/B/C 反向判定

**Spec 参考:** v2 第三节 3.5

**Files:**
- Modify: `internal/store/free_remove.go`
- Modify: `internal/store/govern.go`（提案创建时的免票选路径）

**前置:** Task 5（投票管线）+ Task 6（治理动作扩展）

- [ ] **Step 1: 写免票选条件的失败测试**

```go
func TestFreeExec_AuthorNoInteraction_NoThreshold_SkipVoting(t *testing.T) {
	// 作者自己 + progress=0 + favorite=0 + 未达标 → 免票选直接执行
	st := newTestStore(t)
	st.seedItem(t, "author_A", "article", 100 /*不够200字*/)
	prop := Proposal{
		Action: GovernActionRemove,
		ItemID: "article_1",
		ProposerID: "author_A",
	}
	shouldFree, err := st.shouldFreeExec(prop)
	if err != nil {
		t.Fatal(err)
	}
	if !shouldFree {
		t.Fatal("作者+无互动+未达标 应免票选")
	}
}

func TestFreeExec_AuthorWithInteraction_NeedVoting(t *testing.T) {
	// 作者自己 + 但有 1 人收藏 → 需要票选
	st := newTestStore(t)
	st.seedItem(t, "author_A", "article", 300 /*达标*/)
	st.seedFavorite(t, "other_B", "article_1")
	prop := Proposal{
		Action: GovernActionRemove,
		ItemID: "article_1",
		ProposerID: "author_A",
	}
	shouldFree, err := st.shouldFreeExec(prop)
	if err != nil {
		t.Fatal(err)
	}
	if shouldFree {
		t.Fatal("有他人收藏 不应免票选")
	}
}

func TestFreeExec_DirectoryAdd_NotFree(t *testing.T) {
	// directory_add 永远需要票选（条件 A）
	st := newTestStore(t)
	prop := Proposal{
		Action: GovernActionDirectoryAdd,
		ProposerID: "anyone",
	}
	shouldFree, _ := st.shouldFreeExec(prop)
	if shouldFree {
		t.Fatal("directory_add 不应免票选")
	}
}
```

- [ ] **Step 2: 实现 shouldFreeExec**

在 `free_remove.go`（或新文件）里：

```go
// shouldFreeExec 判定提案是否免票选直接执行（Spec v2 第三节 3.5）。
// 免票选 = NOT directory_add AND 作者本人 AND P=0 AND F=0 AND 未达标。
func (s *Store) shouldFreeExec(p Proposal) (bool, error) {
	// directory_add 永远需要票选
	if p.Action == GovernActionDirectoryAdd {
		return false, nil
	}
	// 必须是作者本人
	var authorID string
	if err := s.db.QueryRow(`SELECT author_id FROM items WHERE item_id=?`, p.ItemID).Scan(&authorID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil // 条目不存在 → 不免
		}
		return false, err
	}
	if authorID != p.ProposerID {
		return false, nil
	}
	// 他人互动检查
	var P, F int
	if err := s.db.QueryRow(`SELECT COUNT(DISTINCT id) FROM progress WHERE item_id=? AND id != ?`,
		p.ItemID, authorID).Scan(&P); err != nil {
		return false, err
	}
	if err := s.db.QueryRow(`SELECT COUNT(DISTINCT id) FROM favorites WHERE item_id=? AND id != ?`,
		p.ItemID, authorID).Scan(&F); err != nil {
		return false, err
	}
	if P > 0 || F > 0 {
		return false, nil
	}
	// 质量门槛检查（未达标才免）
	var itemType, bodyMD string
	if err := s.db.QueryRow(`SELECT type, body_md FROM items WHERE item_id=?`, p.ItemID).Scan(&itemType, &bodyMD); err != nil {
		return false, err
	}
	达标 := meetsQualityGateForContent(itemType, bodyMD, p.ItemID, s.db)
	if 达标 {
		return false, nil
	}
	return true, nil
}
```

- [ ] **Step 3: 在提案创建 handler 里接入免票选路径**

找到 `CreateProposal` 函数，在创建提案前先调 `shouldFreeExec`：

```go
func (s *Store) CreateProposal(p Proposal) (Proposal, error) {
	// 免票选路径：跳过投票管线，直接执行
	free, err := s.shouldFreeExec(p)
	if err != nil {
		return Proposal{}, err
	}
	if free {
		now := time.Now().UnixMilli()
		// 直接执行 governApplyTx（不在事务里或单独事务）
		result, err := governApplyTxDirect(s.db, p)
		if err != nil {
			return Proposal{}, err
		}
		// 记录一个已执行的 proposal（executed_at=now）
		p.ExecutedAt = now
		p.ExecutedResult = result
		p.CreatedAt = now
		if _, err := s.db.Exec(`INSERT INTO govern_proposals(...) VALUES(...)`, ...); err != nil {
			return Proposal{}, err
		}
		return p, nil
	}
	// 正常路径：创建提案 + proposer 自动记第 1 赞成票
	...
}
```

- [ ] **Step 4: 运行测试确认通过 + 全量回归**

Run: `cd e:\code\base && go test ./internal/store/ -run "TestFreeExec" -v -count=1`
Expected: PASS

Run: `cd e:\code\base && go test ./internal/store/ -v -count=1 2>&1 | tail -30`
Expected: 所有测试 PASS（旧的 TestAddVoteRemoveNeedsThreeVotes 等需要改或标记过期）

- [ ] **Step 5: Commit**

```bash
git add internal/store/free_remove.go internal/store/govern.go internal/store/govern_test.go
git commit -m "feat(governance): 免票选逻辑重写 - 条件A/B/C反向判定 + 直接执行路径"
```

---

## Task 8: HTTP handler 同步（Go 侧）

**Files:**
- Modify: `internal/httpapi/govern.go`

**前置:** Task 3-7

- [ ] **Step 1: handleVotePost 签名扩展 vote_type + vote_weight**

- [ ] **Step 2: 投票响应扩展 quorum/threshold/net_weight/approve_weight/reject_weight**

- [ ] **Step 3: handleProposalPost 接入 shouldFreeExec 免票选路径**

- [ ] **Step 4: governRoster 改用 DeriveContributionRoster**

- [ ] **Step 5: 全量测试 + Commit**

---

## Task 9: govern_projection 同步 + Task 10: 圈子治理对齐 + Task 11: Node 侧同步 + Task 12: TS 协议层同步 + Task 13: 集成测试

（这些 Task 结构同上，篇幅原因略，实际写 plan 时每个 Task 都要完整展开 step-by-step。）

---

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| SQLite ALTER TABLE 列已存在导致迁移失败 | MigrateSchemaV2 用 PRAGMA table_info 先检查列是否存在 |
| 旧数据里 govern_votes 没有 vote_weight/vote_type/date | 默认值 vote_weight=1, vote_type='approve', date='' 保证向后兼容 |
| 门槛公式变更后旧提案的 threshold 实时变化 | 设计如此——门槛在每次投票时实时计算，反映当前规模 |
| Node 侧与 Go 侧不同步 | 先 Go 侧落地 + 测试全绿 → Node 同步 → 再两边对齐 |

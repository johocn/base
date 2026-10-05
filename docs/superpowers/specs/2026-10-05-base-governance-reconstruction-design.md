# Base 治理权重构设计（2026-10-05）

> **本文档是治理权重构的正式设计规范 v2。**
> 替代之前的硬编码门槛（remove=3, edit/revive=2），改为**双层票权 + 动态门槛公式 + 两阶段投票判定 + 反对票机制**。
> 前置文档：`docs/superpowers/governance-current-state.md`（当前实现快照）

---

## 一、总原则

| 原则 | 代码契约 |
|---|---|
| 只影响自身 → 自己决定 | 作者对自己的条目，在"无他人互动 + 未达标"时，所有操作免票选 |
| 影响他人 → 用票选 | 条目一旦有他人互动（学习/收藏）或达到质量门槛，任何治理操作必须走票选 |
| 影响多人 → 门槛递增 | 门槛公式含活跃用户数 + 互动数，天然随规模增长 |
| 初创期兜底 | 节点无贡献者时，**前 10 注册 ID 自动获得贡献层资格**；有贡献者后贡献者优先 + 初创期 ID 补齐到恒 10 人 |

---

## 二、票选人资格：双层体系

### 2.1 基础层（所有注册用户）

| 属性 | 值 |
|---|---|
| 资格 | 所有注册用户（有身份五头 `X-Base-Identity-Id/Pubkey/Signature/Timestamp/Nonce`） |
| 单条目票权 | **只能投 1 权/投票**（赞成或反对） |
| 每天配额 | **无上限** |
| 贡献门槛 | **全部豁免**（干掉 `meetsQualityGate` 过滤） |
| 是否消耗贡献层配额 | 不消耗（投 1 权 = 基础层行为） |

### 2.2 贡献层（恒 10 人：贡献者优先 + 初创期 ID 补齐）

| 属性 | 值 |
|---|---|
| 资格构成 | ① **贡献者**：保留原 `meetsQualityGate(type)` 过滤 → 按贡献数降序取前 N 人（N ≤ 10） <br> ② **初创期 ID 补齐**：贡献者不足 10 人时，用**最早注册的身份 ID** 补齐到 10 人 |
| 初创期兜底 | 节点无贡献者（N=0）→ 前 10 注册 ID 全额获得贡献层资格 |
| 总人数 | **恒为 10 人**（无论节点大小） |
| 单条目票权 | 1~10 权（自己选任意整数） |
| **行为判定** | 投 1 权 = 基础层行为，不消耗配额；**投 2~10 权 = 贡献层行为，消耗配额** |
| 每天总配额 | **20 票权**（当日累计投出的 vote_weight ≥ 2 的所有投票总和 ≤ 20，次日 00:00 本地时间重置） |
| 作者给自己条目 | **免票选直接执行**，不进投票管线，不算配额 |
| 反对票 | 贡献层可以投反对票（vote_type='reject'），**反对票同样消耗配额** |

### 2.3 贡献层 vs 基础层 vs 作者身份

| 场景 | 投 1 权 | 投 2~10 权 | 算进 20 票权配额 |
|---|---|---|---|
| 作者给自己条目 | 免票选直接执行（不进管线） | 同左 | 不算 |
| 贡献层成员给别人的条目 | 基础层行为（不消耗配额） | 贡献层行为（消耗配额） | 仅投 2~10 权时算 |
| 普通注册用户（非贡献层） | 只能投 1 权 | 不允许 | 不算 |

### 2.4 贡献层资格派生算法

```go
func deriveContributionRoster() []string {
    // 步骤 1：取贡献者前 N（N ≤ 10）
    contributors := filterMeetsQualityGate(items)  // 保留原质量门槛
    sortByContributionDesc(contributors)
    takeTop10(contributors)

    // 步骤 2：不足 10 人时用初创期 ID 补齐
    if len(contributors) < 10 {
        earliestIDs := queryEarliestRegisteredIDs(10 - len(contributors))
        contributors = append(contributors, earliestIDs...)
    }

    // 步骤 3：恒返回 10 人
    return contributors[:10]
}
```

---

## 三、治理动作枚举

### 3.1 基础治理（门槛公式：固定 10 + m'）

| Action | 对谁操作 | 触发票选条件 |
|---|---|---|
| `remove` | 下架条目（article/video/quiz/lesson/course） | 条件 A/B/C 任一满足 |
| `revive` | 恢复 `state='removed'` 的条目 | 条件 A/B/C 任一满足 |
| `edit_title` | 改标题 | 条件 B/C（作者自己免） |
| `edit_body` | 改正文 | 条件 B/C（作者自己免） |
| `edit_category` | 改分类（使用**内置值**免；新增分类 = directory_add） | 条件 B/C（作者自己免） |
| `edit_tags` | 改标签（使用**内置值**免；新增标签 = directory_add） | 条件 B/C（作者自己免） |
| `edit_instructor` | 改讲师（使用**内置值**免；新增讲师 = directory_add） | 条件 B/C（作者自己免） |
| `directory_add` | 新增目录词（分类/讲师/标签） | 条件 A（**任何新增名词都需要票选**，与条目无关） |

### 3.2 强化治理（门槛公式：固定 20 + m'）

| Action | 对谁操作 | 触发票选条件 |
|---|---|---|
| `highlight` | 高亮（条目上标） | 条件 A/B/C 任一满足 |
| `pin` | 置顶（列表顶） | 同上 |
| `recommend` | 推荐（推荐位） | 同上 |
| `feature` | 精华（精选集） | 同上 |

### 3.3 降级免票选（方向相反，降低影响面）

```
feature → recommend → pin → highlight → normal
```

- **任何降级操作免票选**，直接执行
- 降级权限：作者本人优先，贡献层任意成员也可执行
- 只有**升级**需要走票选管线

### 3.4 内置词 vs 新增词

| 场景 | 是否需要 directory_add 票选 |
|---|---|
| 作者使用系统**内置**分类/讲师/标签 | 免 |
| 作者**新增**分类/讲师/标签名词 | 需要（directory_add） |
| 他人新增名词 | 需要（directory_add，独立于条目） |

**内置词来源**：节点初始化时 seed 一批默认值（由 importer 或 CLI 写入 `directory_terms` 表），后续可通过 `directory_add` 扩展。

### 3.5 免票选触发条件（反向判定：任一条件满足 → 需要票选）

| 条件 | 判定 | 适用动作 |
|---|---|---|
| **A. 新名词** | 新增分类/讲师/标签名词（不是使用内置值） | directory_add（与条目无关） |
| **B. 他人互动** | `progress_count ≥ 1` 或 `favorite_count ≥ 1`（他人学习或收藏 ≥ 1 次） | remove/revive/edit_x5（作者自己在有互动后也不能免） |
| **C. 质量门槛** | 条目内容达标（article 200 字 / video 60 秒 / quiz 3 题 / lesson 1 课时 / course 3 课时） | remove/revive/edit_x5（作者自己在达标后也不能免） |

**作者免票选的完整条件**：`action 不是 directory_add` AND `progress_count = 0` AND `favorite_count = 0` AND `条目未达标`

---

## 四、门槛公式 + 法定人数 + 两阶段投票判定（核心算法）

### 4.1 参数定义

| 符号 | 含义 | 取值 |
|---|---|---|
| **m** | **活跃用户数** | `COUNT(DISTINCT id) FROM identities WHERE last_seen_at > now - 7d`（过去 7 天内有任何 API 调用的独立身份数） |
| **m'** | 门槛公式用活跃用户数（× 1/3） | `⌊m / 3⌋` |
| **P** | 条目被他人学习次数（去重） | `COUNT(DISTINCT id) FROM progress WHERE item_id=? AND id != author_id` |
| **F** | 条目被他人收藏次数（去重） | `COUNT(DISTINCT id) FROM favorites WHERE item_id=? AND id != author_id` |
| ⌈x⌉ | 向上取整 | Go: `math.Ceil(float64(x))` |
| ⌊x⌋ | 向下取整 | Go: `math.Floor(float64(x))` |

### 4.2 门槛公式（动态计算）

```
基础门槛 threshold_base    = 10 + m' + ⌊(P + F) / 3⌋
强化门槛 threshold_enhanced = 20 + m' + ⌊2 × (P + F) / 3⌋
```

directory_add 不绑定具体条目，P + F = 0：
```
threshold_directory = 10 + m'
```

### 4.3 法定人数 quorum（两阶段投票的阶段 1）

**quorum = min(max(threshold, ⌈m/2⌉), m)**

公式解读：
- `max(threshold, ⌈m/2⌉)` → 法定人数至少满足门槛公式，也不少于活跃用户的**半数**
- `min(..., m)` → 法定人数**不能超过活跃用户总数**（小节点兜底，防止 quorum > 可用 voter 数 → 永远 pending）

### 4.4 两阶段投票判定

```
阶段 1：独立 voter 数 >= quorum ?
  ├─ NO → pending（继续征集）
  └─ YES → 阶段 2

阶段 2：净票权 = SUM(approve vote_weight) − SUM(reject vote_weight)
  ├─ 净票权 > 0 → effective（通过）
  └─ 净票权 <= 0 → void（失败）
```

**阶段 1 独立 voter 数** = 投过任何票（赞成或反对）的不同 voter_id 总数（基础层 + 贡献层总和，赞成+反对都算）。

**阶段 2 净票权** = 所有 vote_type='approve' 的 vote_weight 之和减去所有 vote_type='reject' 的 vote_weight 之和。

### 4.5 演算示例

#### 场景 1：小节点初创期（活跃 m=5，无贡献者，新条目无人互动）

```
m = 5, m' = ⌊5/3⌋ = 1, P=0, F=0
threshold_base = 10 + 1 + 0 = 11
quorum = min(max(11, ⌈5/2⌉=3), 5) = min(11, 5) = 5

→ 5 个独立 voter 即可进入阶段 2
→ 贡献层 = 前 10 注册 ID（兜底）
```

#### 场景 2：中等节点（活跃 m=50，热门条目 P=30, F=20）

```
m = 50, m' = ⌊50/3⌋ = 16
threshold_base = 10 + 16 + ⌊50/3⌋ = 10 + 16 + 16 = 42
quorum = min(max(42, ⌈50/2⌉=25), 50) = 42

→ 42 个独立 voter 进入阶段 2
```

#### 场景 3：大节点（活跃 m=1000，冷门条目 P=0, F=0）

```
m = 1000, m' = 333
threshold_base = 10 + 333 + 0 = 343
quorum = min(max(343, ⌈1000/2⌉=500), 1000) = 500

→ 500 个独立 voter 进入阶段 2（半数优先）
```

#### 场景 4：反对票影响

```
quorum = 42，实际参与 42 个 voter
赞成票权总和 = 45，反对票权总和 = 30
净票权 = 45 - 30 = 15 > 0 → effective

--- 换一个 ---
赞成票权总和 = 20，反对票权总和 = 35
净票权 = 20 - 35 = -15 <= 0 → void
```

---

## 五、投票管线（重写 addVoteTx）

### 5.1 提案创建（POST /v1/proposal）

```
请求 → 解析 action + item_id + 触发条件判定
  ├─ 免票选条件满足（作者本人 + P=0 + F=0 + 未达标）
  │   → 跳过投票管线，直接 execute（governApplyTx）
  ├─ directory_add → 创建提案（不绑定条目，门槛 = 10 + m'）
  └─ 其他 → 创建提案，proposer 自动记第 1 赞成票
```

### 5.2 投票（POST /v1/proposal/{id}/vote）

```
请求 → 解析 voter_id + vote_type（approve|reject）+ vote_weight
  │
  ├─ vote_weight 校验
  │   ├─ 普通注册用户（非贡献层）
  │   │   → 强制 weight=1（投 1 权 = 基础层行为，不消耗配额）
  │   └─ 贡献层
  │       ├─ weight=1 → 基础层行为，不消耗配额
  │       └─ weight ∈ [2,10] → 贡献层行为，检查配额
  │
  ├─ 贡献层配额检查（仅 weight ≥ 2 时）
  │   ├─ 当日累计投出 weight ≥ 2 的总和 ≤ 20
  │   ├─ 单条目当日累计 weight ≤ 10（无论基础/贡献层，对同一条目累计 ≤ 10）
  │   └─ 配额超限 → 返回 429 quota_exceeded
  │
  ├─ 写 govern_votes
  │   └─ INSERT (proposal_id, voter_id, vote_weight, vote_type, date, created_at)
  │       ON CONFLICT(proposal_id, voter_id) DO NOTHING → ErrAlreadyVoted
  │
  ├─ 法定人数检查
  │   ├─ 实时计算 m（查 identities 近 7 天活跃数）
  │   ├─ 实时计算 P + F（去重）
  │   ├─ 实时计算 quorum = min(max(threshold, ⌈m/2⌉), m)
  │   └─ 查独立 voter 数 = COUNT(DISTINCT voter_id) WHERE proposal_id=?
  │
  ├─ voter 数 < quorum → 状态保持 pending，返回
  │
  ├─ voter 数 >= quorum → 进入阶段 2
  │   ├─ 净票权 = SUM(approve weight) − SUM(reject weight)
  │   ├─ 净票权 > 0
  │   │   ├─ 跑前置条件 governPreconditionTx（content_hash 乐观锁）
  │   │   ├─ 前置条件满足 → governApplyTx → 写 executed_at → effective
  │   │   └─ 前置条件不满足 → 写 voided_at → void
  │   └─ 净票权 <= 0 → 写 voided_at → void
  │
  └─ 返回 vote_count / quorum / net_weight / threshold / status
```

### 5.3 投票响应结构（扩展）

```json
{
  "proposal_id": "42",
  "voter_count": 42,           // 当前独立 voter 数
  "quorum": 42,                // 当前法定人数
  "approve_weight": 45,        // 赞成票权总和
  "reject_weight": 30,         // 反对票权总和
  "net_weight": 15,            // 净票权（approve − reject）
  "threshold_base": 42,        // 门槛公式值（公开）
  "status": "pending"          // pending | effective | void
}
```

**所有数值实时返回**（quorum / threshold / net_weight 不固化），让客户端能公开显示当前投票进度和门槛。

### 5.4 配额重置

- 每日本地时间 00:00 重置
- **无需新表**：用 `govern_votes` 的 `date` 列（YYYY-MM-DD）查询聚合
  ```sql
  SELECT SUM(vote_weight) FROM govern_votes
  WHERE voter_id=? AND date=? AND vote_weight >= 2
  ```

### 5.5 状态转换图

```
pending
  │
  ├── voter_count >= quorum AND net_weight > 0 AND 前置条件满足 ──→ effective
  ├── voter_count >= quorum AND net_weight <= 0 ──→ void
  ├── voter_count >= quorum AND net_weight > 0 AND 前置条件不满足 ──→ void
  └── 并发执行（另一票先让 net_weight > 0 + 前置满足） ──→ 自己返回 ErrAlreadyVoted
```

---

## 六、圈子治理参照

### 6.1 原则

> **保留现有 DeriveSeats 席位体系（创建者永久 1 席 + k(m) 阶梯贡献席位）**，同时参照本设计的**双层票权 + 门槛公式 + 两阶段投票 + 反对票**全部规则，参数取圈内值。

### 6.2 圈内外双层票权对齐

| 维度 | 公开节点 | 封闭圈子内部 |
|---|---|---|
| 基础层 | 所有注册用户 1 权 | 圈内注册成员 1 权（非成员不能投） |
| 贡献层资格 | 节点级贡献门槛 + 初创期 ID 补齐恒 10 人 | **保留 DeriveSeats**（创建者永久 1 席 + k(m_circle) 阶梯贡献席位） |
| 贡献层票权 | 1~10 权/条目/天 | 1~10 权/条目/天 |
| 贡献层配额 | 每天 20 票权 | 每天 20 票权 |
| 配额独立 | 与圈子**独立** | 与公开节点**独立** |
| 反对票 | 支持 | 支持 |
| 投 1 权不消耗配额 | 是 | 是 |

### 6.3 圈子内部门槛公式 + 法定人数

与节点级**同一公式**，但参数取圈内值：

```
threshold_base_circle    = 10 + ⌊m_circle / 3⌋ + ⌊(P_circle + F_circle) / 3⌋
threshold_enhanced_circle = 20 + ⌊m_circle / 3⌋ + ⌊2 × (P_circle + F_circle) / 3⌋

quorum_circle = min(max(threshold, ⌈m_circle / 2⌉), m_circle)
```

其中：
- `m_circle` = 圈内注册成员中近 7 天活跃数
- `P_circle` = 圈内成员对圈内容条目的去重学习次数
- `F_circle` = 圈内成员对圈内容条目的去重收藏次数

### 6.4 圈子特殊治理动作

| 动作 | 门槛级别 | 执行内容 |
|---|---|---|
| 移出成员 | 基础治理 | 更新 circle_assignments |
| 解散圈子 | 强化治理 | 删除圈子 + 清理关联数据 |
| 修改圈子规则 | 基础治理 | 更新 group 配置 |

### 6.5 创建者权限

- 圈子创建者 = DeriveSeats 永久 1 席贡献层资格
- 创建者对圈子自身的治理（解散除外）**免票选直接执行**
- 创建者对圈内容条目的权限 = 同条目作者规则（免票选条件同上）

---

## 七、需要新增/修改的表

### 7.1 修改：govern_votes 表

```sql
-- 新增列
ALTER TABLE govern_votes ADD COLUMN vote_weight INTEGER NOT NULL DEFAULT 1;
ALTER TABLE govern_votes ADD COLUMN vote_type TEXT NOT NULL DEFAULT 'approve';  -- 'approve' | 'reject'
ALTER TABLE govern_votes ADD COLUMN date TEXT NOT NULL;  -- YYYY-MM-DD，方便按日聚合

-- 修改主键（原 (proposal_id, voter_id) 联合主键保留，无需改）
-- 新增索引
CREATE INDEX idx_gv_voter_date_weight ON govern_votes(voter_id, date, vote_weight);
CREATE INDEX idx_gv_proposal_type ON govern_votes(proposal_id, vote_type);
CREATE INDEX idx_gv_proposal_voter ON govern_votes(proposal_id, voter_id);
```

### 7.2 修改：govern_proposals 表

```sql
-- 新增列
ALTER TABLE govern_proposals ADD COLUMN governance_level TEXT NOT NULL DEFAULT 'base';  -- 'base' | 'enhanced'
ALTER TABLE govern_proposals ADD COLUMN category TEXT;   -- 'node' | 'circle'
ALTER TABLE govern_proposals ADD COLUMN circle_id TEXT;  -- 圈子级提案关联的 circle_id
```

### 7.3 修改：items 表（强化治理 pin_level）

```sql
ALTER TABLE items ADD COLUMN pin_level INTEGER NOT NULL DEFAULT 0;  -- 0=normal, 1=highlight, 2=pin, 3=recommend, 4=feature
ALTER TABLE items ADD COLUMN pinned_at INTEGER;                      -- 毫秒时间戳
ALTER TABLE items ADD COLUMN highlight_until INTEGER;                -- 高亮截止（可选，毫秒时间戳）
```

### 7.4 新增：identities 表活跃字段（如果不存在）

```sql
-- 假设 identities 表存在，需要 last_seen_at 用于计算 m
ALTER TABLE identities ADD COLUMN last_seen_at INTEGER;  -- 毫秒时间戳
-- 每次 API 调用时更新 last_seen_at = now()
CREATE INDEX idx_identities_last_seen ON identities(last_seen_at);
```

### 7.5 新增：progress / favorites 表（如果不存在）

```sql
-- progress 表（学习记录）
CREATE TABLE IF NOT EXISTS progress (
  id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, item_id)
);
CREATE INDEX idx_progress_item_id ON progress(item_id);

-- favorites 表（收藏记录）
CREATE TABLE IF NOT EXISTS favorites (
  id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, item_id)
);
CREATE INDEX idx_favorites_item_id ON favorites(item_id);
```

---

## 八、与当前实现的改动差距

| 模块 | 当前代码 | 重构后 | 改动量 |
|---|---|---|---|
| 贡献层资格 | `meetsQualityGate` → 前 10 截断 → 空名册 fail-closed | **贡献者前 N + 初创期 ID 补齐到恒 10** | **重写** contributor.go |
| 门槛计算 | `GovernThresholdForRoster` 硬编码（remove=3, edit=2） | 动态公式（10/20 + ⌊m/3⌋ + 1/3 互动）+ quorum | **重写** govern.go 门槛计算 |
| 投票判定 | 有效票权 ≥ 门槛 | **两阶段**：voter_count ≥ quorum + 净票权 > 0 | **重写** addVoteTx |
| 反对票 | 不支持 | govern_votes 加 vote_type='reject' | **新增** vote_type 列 + 投票逻辑 |
| 加权票 | 不支持（weight 固定 1） | 贡献层 1~10 权 + 每日 20 票权配额 | **重写** addVoteTx |
| 免票选 | `freeRemoveEligible`（仅 course/lesson + 作者） | 统一条件 A/B/C 反向判定 | **重写** free_remove.go |
| 治理动作 | remove/revive/edit/directory_add（4） | remove/revive/edit_x5/directory_add/highlight/pin/recommend/feature（12） | **扩展** GovernAction 枚举 |
| 圈子治理 | DeriveSeats + 独立 quorum（⌈2k/3⌉） | 同门槛公式 + 两阶段投票 + 反对票 | **改写** groupseats.go + quorum |
| govern_projection | P6 融合收敛层 | 保留，门槛/quorum/净票权计算对齐 | **同步改** govern_projection.go |
| Node 侧 | 对齐 Go | 对齐 Go | **同步改** Node store + routes |
| TS 协议层 | GovernAction 4 值 | GovernAction 12 值 + vote_type + quorum | **同步改** core-ts govern.ts |
| schema 迁移 | — | govern_votes 加 vote_weight/vote_type/date + govern_proposals 加列 + items 加 pin_level + identities 加 last_seen_at + progress/favorites 表 | **新增** |

---

## 九、实施顺序建议

| 批次 | 内容 | 前置 |
|---|---|---|
| T1 | **Schema 迁移**：govern_votes + govern_proposals + items + identities.last_seen_at + progress/favorites 表 | 无 |
| T2 | **纯函数重写**：贡献层资格派生（补齐算法）+ 门槛公式 + quorum 公式 + 净票权计算 | T1 |
| T3 | **投票管线重写**：addVoteTx（两阶段 + 反对票 + 加权票 + 配额） | T2 |
| T4 | **免票选逻辑重写**：条件 A/B/C 反向判定 + 直接执行路径 | T2 |
| T5 | **治理动作扩展**：GovernAction 12 种 + governApplyTx 扩展 | T3 |
| T6 | **圈子治理对齐**：quorum 改公式 + 反对票 + 两阶段投票 | T3 |
| T7 | **govern_projection 同步**：P6 收敛层 | T3–T6 |
| T8 | **Node 侧同步**：store/ + routes/ | T1–T7 |
| T9 | **TS 协议层同步**：core-ts govern.ts 扩展 + vote_type + quorum | T8 |
| T10 | **测试覆盖**：每个 action + 门槛公式 + quorum + 反对票 + 配额 + 免票选 + 初创期兜底 | T3 |
| T11 | **H5 治理 UI**：提案看板 + 投票台（显示 quorum/threshold/net_weight）+ 门槛公开 | T3–T9 |

---

## 十、v1→v2 变更日志

| 变更 | v1（上一版） | v2（本版） |
|---|---|---|
| 贡献层资格 | 保留贡献门槛 → 前 10 截断 | 贡献者前 N + 初创期 ID 补齐 → **恒 10 人** |
| m 参数 | 总注册用户数 | **活跃 7 天注册用户数 × 1/3** |
| 门槛公式里的 m | 直接用 m | 用 m' = ⌊m/3⌋ |
| 通过判定 | 有效票权 ≥ 门槛 | **两阶段**：voter_count ≥ quorum + 净票权 > 0 |
| quorum | 无 | **min(max(threshold, ⌈m/2⌉), m)** |
| 反对票 | 不支持 | 支持，净票权 = approve_sum − reject_sum |
| 贡献层行为判定 | 只要是贡献层就能投 1~10 权 | **投 1 权 = 基础层，投 2~10 权 = 贡献层（消耗配额）** |
| 配额类型 | 20 票（歧义） | **20 票权**（vote_weight 总和 ≤ 20） |
| 配额消耗 | 仅赞成票消耗 | **赞成 + 反对都消耗**（对称） |
| 阶段 1 voter 构成 | 未明确 | **赞成 + 反对独立 voter 总和** |
| progress/favorite 计数 | 未明确去重 | **明确 COUNT(DISTINCT id) 去重** |
| 初创期兜底 | 未提 | 前 10 注册 ID 自动获贡献层资格 + 补齐算法 |

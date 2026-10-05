# Base 治理权重构设计（2026-10-05）

> **本文档是治理权重构的正式设计规范。**
> 替代之前的硬编码门槛（remove=3, edit/revive=2），改为动态公式 + 双层票权体系。
> 前置文档：`docs/superpowers/governance-current-state.md`（当前实现快照）

---

## 一、总原则

| 原则 | 代码契约 |
|---|---|
| 只影响自身 → 自己决定 | 作者对自己的条目，在"无他人互动 + 未达标"时，所有操作免票选 |
| 影响他人 → 用票选 | 条目一旦有他人互动（学习/收藏）或达到质量门槛，任何治理操作必须走票选 |
| 影响多人 → 门槛递增 | 门槛公式含注册用户数 + 互动数，天然随规模增长 |

---

## 二、票选人资格：双层体系

### 2.1 基础层（所有注册用户）

| 属性 | 值 |
|---|---|
| 资格 | 所有注册用户（有身份五头 `X-Base-Identity-Id/Pubkey/Signature/Timestamp/Nonce`） |
| 单条目票权 | 1 权/投票 |
| 每天配额 | **无上限** |
| 贡献门槛 | **全部豁免**（干掉 `meetsQualityGate` 过滤） |

### 2.2 贡献层（前 10 贡献者）

| 属性 | 值 |
|---|---|
| 资格 | **保留原贡献门槛**：`meetsQualityGate(type)` 过滤后，按贡献数降序截断前 10 名 |
| 单条目票权 | 1~10 权（自己选任意整数，**每天对同一条目累计 ≤ 10 权**） |
| 每天总配额 | **20 票权**（即当日累计投出的 vote_weight 总和 ≤ 20，次日 00:00 本地时间重置） |
| 作者给自己条目投票 | **免票选直接执行**，不进投票管线，不算配额 |

### 2.3 贡献层 vs 作者身份

| 场景 | 票权上限 | 算进每天 20 票配额 |
|---|---|---|
| 作者给自己条目 | 免票选直接执行 | 不算（根本没投票） |
| 贡献者给**别人的**条目 | 1~10 权/条目/天 | 算进 20 票配额 |
| 普通注册用户（非贡献层） | 1 权/条目 | 不算（基础层无上限） |

---

## 三、治理动作枚举

### 3.1 基础治理（门槛公式：固定 10）

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

### 3.2 强化治理（门槛公式：固定 20）

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
- 降级权限：作者本人 + 贡献层任意成员都可执行
- 只有**升级**需要走票选管线

### 3.4 内置词 vs 新增词

| 场景 | 是否需要 directory_add 票选 |
|---|---|
| 作者使用系统**内置**分类/讲师/标签 | 免 |
| 作者**新增**分类/讲师/标签名词 | 需要（directory_add） |
| 他人新增名词 | 需要（directory_add，独立于条目） |

**内置词来源**：节点初始化时 seed 一批默认值（由 importer 或 CLI 写入 `directory_terms` 表），后续运营者可通过 `directory_add` 扩展。

---

## 四、票选门槛公式（核心算法）

### 4.1 基础治理门槛

```
threshold_base = 10 + m + ⌊(progress_count + favorite_count) / 3⌋
```

### 4.2 强化治理门槛

```
threshold_enhanced = 20 + m + ⌊2 × (progress_count + favorite_count) / 3⌋
```

### 4.3 公式参数定义

| 参数 | 含义 | 取值来源 |
|---|---|---|
| m | **注册用户数** | `SELECT COUNT(DISTINCT id) FROM identities`（或等价身份表） |
| progress_count | 条目被他人学习次数 | `SELECT COUNT(*) FROM progress WHERE item_id=? AND id != author_id` |
| favorite_count | 条目被他人收藏次数 | `SELECT COUNT(*) FROM favorites WHERE item_id=? AND id != author_id` |
| ⌊x⌋ | 向下取整 | Go: `math.Floor(float64(x))` |

### 4.4 directory_add 门槛（同基础治理）

directory_add 不绑定具体条目，`progress_count + favorite_count = 0`，公式退化为：

```
threshold_directory = 10 + m
```

### 4.5 门槛示例演算

| 场景 | m | progress_count | favorite_count | 基础门槛 | 强化门槛 |
|---|---|---|---|---|---|
| 小节点，新条目，无人互动 | 5 | 0 | 0 | 15 | 25 |
| 小节点，热门条目 | 5 | 12 | 9 | 15 + ⌊21/3⌋ = **22** | 25 + ⌊42/3⌋ = **39** |
| 大节点，热门条目 | 100 | 50 | 30 | 110 + ⌊80/3⌋ = **136** | 120 + ⌊160/3⌋ = **173** |

### 4.6 门槛为整数

公式结果取整（已由 `⌊⌋` 保证）。有效票权累计 ≥ 门槛 → 生效。

---

## 五、投票管线（改写现有 addVoteTx）

### 5.1 提案创建（POST /v1/proposal）

```
请求 → 解析 action + item_id + 触发条件判定
  ├─ 作者本人 + 免票选条件满足 → 跳过投票管线，直接 execute（governApplyTx）
  ├─ directory_add → 直接创建提案（不绑定条目，门槛 = 10 + m）
  └─ 其他 → 创建提案，proposer 自动记第 1 票
```

### 5.2 投票（POST /v1/proposal/{id}/vote）

```
请求 → 解析 voter_id + vote_weight
  ├─ vote_weight 校验
  │   ├─ 普通注册用户 → 强制 weight=1
  │   ├─ 贡献层 → 允许 weight ∈ [1,10]
  │   └─ 贡献层配额检查 → 当日累计 weight ≤ 20
  ├─ 单条目累计检查 → 当日同条目累计 weight ≤ 10
  ├─ 写 govern_votes（INSERT ON CONFLICT DO NOTHING）
  ├─ 计算累计有效票权 total_weight
  ├─ 计算门槛 threshold（实时查 m / progress_count / favorite_count）
  ├─ 前置条件 governPreconditionTx
  └─ 执行 governApplyTx → 写 executed_at
```

### 5.3 门槛动态性

- 门槛在**每次投票时实时计算**（不是提案创建时固化）
- 理由：注册用户数 m 和互动数会随时间增长，门槛应反映当前规模
- **乐观锁仍基于 content_hash**（目标内容不可变）

### 5.4 状态转换

```
pending ──有效票权 ≥ 门槛 + 前置条件满足──→ effective
  │
  └──有效票权 ≥ 门槛 + 前置条件不满足──→ void
  │
  └──并发执行 ──→ void（第二个 proposal 先落 executed_at）
```

### 5.5 贡献层配额重置

- 每日本地时间 00:00 重置
- 重置逻辑：`DELETE FROM daily_vote_quotas WHERE date < today`
- 需要**新增表** `daily_vote_quotas(voter_id TEXT, item_id TEXT, date TEXT, weight INTEGER)`
- 或者：用 `govern_votes.created_at` 毫秒时间戳按日聚合（SELECT 时按 `YYYY-MM-DD` 分组 SUM）——**推荐后者，省一张表**

---

## 六、圈子治理参照

### 6.1 原则

> 保留现有 DeriveSeats 席位体系 + 双层票权 + 同一套门槛公式（但参数取圈内值）

### 6.2 圈内外双层票权对齐

| 维度 | 公开节点 | 封闭圈子内部 |
|---|---|---|
| 基础层 | 所有注册用户 1 权 | 圈内注册成员 1 权（非成员不能投） |
| 贡献层资格 | 节点级贡献门槛 + 前 10 截断 | **保留 DeriveSeats**（创建者永久 1 席 + k(m) 阶梯贡献席位） |
| 贡献层票权 | 1~10 权/条目/天 | 1~10 权/条目/天 |
| 贡献层配额 | 每天 20 票 | 每天 20 票 |
| 配额独立 | 与圈子**独立** | 与公开节点**独立** |

### 6.3 圈子内部门槛公式

与节点级**同一公式**，但参数取圈内值：

```
threshold_base_circle = 10 + m_circle + ⌊(progress_count_circle + favorite_count_circle) / 3⌋
threshold_enhanced_circle = 20 + m_circle + ⌊2 × (progress_count_circle + favorite_count_circle) / 3⌋
```

其中：
- `m_circle` = 圈内注册成员数
- `progress_count_circle` = 圈内成员对圈内容条目的学习次数
- `favorite_count_circle` = 圈内成员对圈内容条目的收藏次数

### 6.4 圈子特殊治理动作

| 动作 | 门槛 | 执行内容 |
|---|---|---|
| 移出成员 | 基础治理门槛 `threshold_base_circle` | 更新 circle_assignments |
| 解散圈子 | 强化治理门槛 `threshold_enhanced_circle` | 删除圈子 + 清理关联数据 |
| 修改圈子规则 | 基础治理门槛 | 更新 group 配置 |

### 6.5 创建者权限

- 圈子创建者 = 永久 1 席贡献层资格
- 创建者对圈子自身的治理（解散除外）**免票选直接执行**
- 创建者对圈内容条目的权限 = 同条目作者规则

---

## 七、需要新增/修改的表

### 7.1 新增：daily_vote_tracking（可选，推荐用聚合查询替代）

如果用聚合查询（按 govern_votes.created_at 分组），**不需要新表**。否则：

```sql
CREATE TABLE IF NOT EXISTS daily_vote_tracking (
  voter_id TEXT NOT NULL,
  item_id TEXT NOT NULL,       -- 提案目标 item_id（用于单条目累计检查）
  proposal_id INTEGER NOT NULL,
  vote_weight INTEGER NOT NULL DEFAULT 1,
  date TEXT NOT NULL,          -- YYYY-MM-DD
  PRIMARY KEY (voter_id, proposal_id)
);
CREATE INDEX idx_daily_vote_tracking_voter_date ON daily_vote_tracking(voter_id, date);
CREATE INDEX idx_daily_vote_tracking_voter_item_date ON daily_vote_tracking(voter_id, item_id, date);
```

### 7.2 修改：govern_votes 表

新增列：

```sql
ALTER TABLE govern_votes ADD COLUMN vote_weight INTEGER NOT NULL DEFAULT 1;
ALTER TABLE govern_votes ADD COLUMN date TEXT NOT NULL;  -- YYYY-MM-DD，方便查询
```

### 7.3 修改：govern_proposals 表

新增列：

```sql
ALTER TABLE govern_proposals ADD COLUMN governance_level TEXT NOT NULL DEFAULT 'base';  -- 'base' | 'enhanced'
ALTER TABLE govern_proposals ADD COLUMN category TEXT;  -- 'node' | 'circle'（区分节点级 vs 圈子级）
ALTER TABLE govern_proposals ADD COLUMN circle_id TEXT;  -- 圈子级提案关联的 circle_id
```

### 7.4 修改：items 表

新增列：

```sql
ALTER TABLE items ADD COLUMN pin_level INTEGER NOT NULL DEFAULT 0;  -- 0=normal, 1=highlight, 2=pin, 3=recommend, 4=feature
ALTER TABLE items ADD COLUMN pinned_at INTEGER;                      -- 毫秒时间戳
ALTER TABLE items ADD COLUMN highlight_until INTEGER;                -- 高亮截止（毫秒时间戳）
```

---

## 八、与当前实现的改动差距

| 模块 | 当前代码 | 重构后 | 改动量 |
|---|---|---|---|
| 票选人资格 | `meetsQualityGate` 过滤 → 前 10 截断 → 空名册 fail-closed | 双层体系（基础层无门槛 + 贡献层保留前 10） | **重写** contributor.go 资格过滤 |
| 门槛计算 | `GovernThresholdForRoster` 硬编码常量（remove=3, edit=2） | 动态公式（10/20 + m + 1/3 互动） | **重写** govern.go 门槛计算 |
| 投票管线 | 一人一票（weight 固定 1） | 加权票（普通=1，贡献层=1~10）+ 每日配额 | **重写** addVoteTx |
| 免票选逻辑 | `freeRemoveEligible`（仅 course/lesson + 作者 + 无他人学习） | 统一免票选触发：作者 + 条件 A/B/C 反向判定 | **重写** free_remove.go |
| 治理动作 | remove/revive/edit/directory_add（4 种） | remove/revive/edit_x5/directory_add/highlight/pin/recommend/feature（12 种） | **扩展** GovernAction 枚举 |
| 圈子治理 | DeriveSeats 独立 quorum（⌈2k/3⌉） | 同一门槛公式 + 圈内参数 | **改写** groupseats.go 的 quorum 函数 |
| govern_projections | P6 融合收敛层 | 保留，门槛计算逻辑与 addVoteTx 对齐 | **同步改** govern_projection.go |
| Node 侧 | 对齐 Go | 对齐 Go | **同步改** Node 侧 store/ + routes/ |
| TS 协议层 | GovernAction 4 值 | GovernAction 扩展到 12 值 | **同步改** core-ts govern.ts |
| daily 配额跟踪 | 无 | govern_votes 新列 vote_weight + date | **新增** schema 迁移 |
| items.pin_level | 无 | pin_level 列 | **新增** schema 迁移 |

---

## 九、实施顺序建议

| 批次 | 内容 | 前置 |
|---|---|---|
| T1 | **表结构迁移**（govern_votes 加 vote_weight/date + govern_proposals 加 governance_level/category/circle_id + items 加 pin_level） | 无 |
| T2 | **纯函数重写**：贡献层资格过滤 + 门槛公式 + 加权票校验逻辑 | T1 |
| T3 | **投票管线重写**：addVoteTx + governApplyTx（扩展 12 种 action） | T2 |
| T4 | **免票选逻辑重写**：统一触发条件 A/B/C 反向判定 | T2 |
| T5 | **圈子治理对齐**：groupseats.go quorum 函数改公式 | T3 |
| T6 | **govern_projection 同步**：P6 融合收敛层门槛计算对齐 | T3 |
| T7 | **Node 侧同步**：store/govern.ts + routes/proposal.ts | T1–T6 |
| T8 | **TS 协议层同步**：core-ts/govern.ts 扩展 GovernAction | T7 |
| T9 | **测试覆盖**：每个 action + 门槛公式 + 免票选 + 配额 | T3 |
| T10 | **H5 治理 UI**：提案看板 + 投票台 + 门槛公开显示 | T3–T8 |

---

## 十、待你确认的遗留项

以下是规则中还未钉死的细节，等你完善后再动手：

| # | 问题 | 我的推荐 |
|---|---|---|
| 1 | 强化治理的 pin_level 自动降级：feature→recommend→pin→highlight→normal 是**时间自动降级**（比如 feature 30 天自动降为 recommend）还是**手动降级**（作者/贡献者点按钮）？ | 推荐：手动降级 + 可选自动降级（每个级别设默认有效期） |
| 2 | 贡献层每日配额 20 票——**单次投票可以投 10 权**，那 20 票是指 20 次投票还是 20 票权？ | 推荐：20 **票权**（总 weight ≤ 20），不是次数。这样一次投 10 权 = 剩 10 权可投别处 |
| 3 | 门槛公式里的 `progress_count`——是**去重**（一个用户学多次只算 1）还是不去重？ | 推荐：去重（`COUNT(DISTINCT id)`），同一用户多次学习不应推高门槛 |
| 4 | 门槛公式里的 `favorite_count`——同样去重吗？ | 推荐：去重 |
| 5 | 贡献层资格的"前 10"——是**节点级全局前 10**还是**每个载体类型各前 10**？ | 推荐：节点级全局前 10（合并所有载体贡献后排序截断） |
| 6 | 降级操作（feature→recommend 等）——**作者和贡献层都能执行**，还是只有作者？ | 推荐：作者优先（自己的条目自己决定降级），贡献层也可降级（但不能升级） |
| 7 | 免票选条件 B"有他人互动"——**只有一个人收藏**就算触发票选？还是有阈值（比如 ≥ 3 人收藏才触发）？ | 推荐：≥ 1 人收藏/学习即触发（只要有任何他人影响就需要票选） |

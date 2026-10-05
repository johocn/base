# Base 治理权现状全景（2026-10-05）

> **本文档只陈述已落地事实，不含任何未实现的设计意图。**
> Go 侧 = origin/master `internal/`，Node 侧 = origin/master `apps/node/`，TS 协议层 = origin/master `packages/`。两侧实现对齐，以下以 Go 侧为主叙述。

---

## 一、票选人资格：贡献门槛 → 前 N 截断

### 1.1 质量门槛常量（`internal/store/contributor.go`）

| 载体 | 常量 | 值 | 达标条件 |
|---|---|---|---|
| article | `ArticleMinRunes` | 200 | 正文 ≥ 200 rune |
| video | `VideoMinSeconds` | 60 | 时长 ≥ 60 秒 |
| quiz | `QuizMinQuestions` | 3 | 题目 ≥ 3 |
| lesson | `LessonMinItems` | 1 | 含 ≥ 1 个达标子项（article/video/quiz） |
| course | `CourseMinLessons` | 3 | 含 ≥ 3 个达标课时 |
| 其他 | default | false | tag 贡献不计资格；非内容载体全部 false |

### 1.2 名册派生（`ContributorRoster()` / `deriveRoster()`）

1. 读 `items` 表 `state='active' AND author_id != ''` 的所有行
2. 每行 `meetsQualityGate(type)` 过滤
3. 按作者累计贡献数（course/lesson 合并计 1：父 course 达标后，其达标 lesson 不再重复计入）
4. 排序：贡献数降序 → 同数按作者 ID 升序（确定性 tiebreak）
5. 截断到 `RosterTopN = 10`
6. 派生完不成（DB 错误）→ **fail-closed 返回空名册**（空名册参与投票判定时有效票恒 0，门槛不豁免）

### 1.3 豁免（仅 directory_add）

`DirectorySmallNodeRosterMax = 10`：当且仅当**名册就绪（rosterReady=true）且名册规模 < 10** 时，`directory_add` 门槛从 2 降为 1。

---

## 二、票选动作范围：4 个受审动作 + 免票选删除

### 2.1 治理动作枚举

| Action | 对谁操作 | 门槛（名册就绪） | 门槛（小节点豁免） |
|---|---|---|---|
| `remove` | 下架条目（article/video/quiz/lesson/course） | 3 票 | 不豁免，仍 3 票 |
| `revive` | 恢复 `state='removed'` 的条目 | 2 票 | 不豁免，仍 2 票 |
| `edit` | 改标题/正文/link（含作者署名清署） | 2 票 | 不豁免，仍 2 票 |
| `directory_add` | 加目录词条 | 2 票 | 名册 < 10 ⇒ 1 票 |

### 2.2 免票选删除（`freeRemoveEligible()`）

remove 提案满足以下全部条件时，**门槛降为 0、同事务内直接生效**：

1. **目标须是容器**：item_id 形如 `course/<cid>` 或 `course/<cid>/lesson/<lid>`（article/video/quiz 不适用）
2. **actor = 创建者**：`items.author_id` 非空且等于提案人
3. **短路条件**：course 且无课时（segments 表 seq>=1 行为空）⇒ 直接 true
4. **否则**：progress 表中 item_id ∈ {目标自身 ∪ 课程全部课时} 且 id ≠ actor 的行为空 ⇒ true
5. **查询异常**：fail-closed，退回 3 票正常门槛

生效后 `executed_result = "free_remove"`（诊断信息，非契约）。

### 2.3 前置条件（`governPreconditionTx()`）

任何动作执行前必须满足：

1. 目标 items 行存在
2. `items.state == GovernRequiredState(action)`（revive 要求 `removed`，其他要求 `active`）
3. `items.content_hash == 提案时固化的 base_content_hash`（乐观锁：授权针对的是**某一版内容**，那一版没了授权永久作废）
4. `directory_add` 无 items 目标行 ⇒ 直接放行

前置条件不满足 → 提案 `voided_at = now`，状态变 `void`，动作不执行。

---

## 三、门槛规则（`GovernThresholdForRoster()`）

纯函数签名：`GovernThresholdForRoster(action string, rosterLen int, rosterReady bool) int`

```
remove         → 3（永不豁免）
edit/revive    → 2（永不豁免）
directory_add  → if rosterReady && rosterLen < 10: 1 else 2
```

**名册派生失败（rosterReady=false）** 对任何动作都不豁免（fail-closed）。

---

## 四、投票管线：自动执行

### 4.1 写入路径（HTTP handler）

```
POST /v1/proposal              → 创建提案（proposer 自动记第 1 票）
POST /v1/proposal/{id}/vote    → 投第 2..N 票
GET  /v1/proposal              → 匿名返回全部提案列表（含 votes/vote_count/threshold/status）
```

### 4.2 投票事务（`addVoteTx()`）

1. 写 `govern_votes`（INSERT ON CONFLICT DO NOTHING → `ErrAlreadyVoted`）
2. 读提案行
3. 读已投票人列表
4. **按当前名册（handler 派生时快照）过滤有效票**：不在名册中的投票不计入
5. 计算门槛（含免票选 + 小节点豁免）
6. **已定案（executed_at / voided_at 任一非 0）** → 直接返回 `proposalStatus`
7. **未达门槛** → 状态 `pending`，返回
8. **达门槛** → 跑前置条件（`governPreconditionTx`）→ 不满足则写 `voided_at` 返回 `void`
9. **执行动作**（`governApplyTx`）→ 写 `executed_at` + `executed_result`
10. 同一事务 commit

### 4.3 governApplyTx 每个动作的具体 SQL

| Action | 执行内容 | executed_result |
|---|---|---|
| remove | ① `RetireItem`: UPDATE items SET state='removed' WHERE item_id=? <br> ② blob 表 revoke（若存在） | `"retired"` |
| revive | `UPDATE items SET state='active' WHERE item_id=?` | `"revived"` |
| edit（标题-only） | `UPDATE items SET title=? WHERE item_id=?`（**保留 author_id 署名**） | `"edited_title"` |
| edit（含正文） | `UPDATE items SET title=?, body_md=?, author_id='' WHERE item_id=?`（**清署**） | `"edited_body"` |
| edit（link，tag 专用） | 更新 links_json | `"edited_links"` |
| directory_add | INSERT INTO directory_terms(term, category, created_at, proposal_id, item_id) VALUES(...) + 推 directory version | `"directory_approved"` |

### 4.4 状态转换图

```
pending ──投票达门槛 + 前置条件满足──→ effective
  │
  └──投票达门槛 + 前置条件不满足──→ void（voided_at 被写）
  │
  └──执行了 voided_at（某并发投票先达成执行）──→ void（当前投票写冲突但不报错）
```

**once-and-for-all**：`executed_at` 和 `voided_at` 是一次性事实字段，任一非 0 后不再判。

---

## 五、圈子治理席位（**独立于全局治理名册的另一套席位系统**）

这是 P6 融合治理前就已存在的圈子内部治理机制，与全局 proposal.POST 是**两套完全独立的管线**。

### 5.1 govern.v1 事件 vs proposal.POST

| 维度 | 全局治理（proposal.POST） | 圈子治理（govern.v1 事件） |
|---|---|---|
| 入口 | HTTP POST /v1/proposal | govern.v1 事件投影到 govern_proposals |
| 投票人资格 | ContributorRoster（前 10 贡献者） | 圈子 DeriveSeats（圈内 governors） |
| 门槛 | GovernThresholdForRoster（remove=3, revive/edit=2, directory_add=2/1） | 圈子级别 quorum（见下） |
| 执行 | addVoteTx 事务内 governApplyTx | govern_projection.SettleGovernProposal 独立收敛 |
| 自动执行 | 是 | 是（P6 融合后统一收敛） |

### 5.2 圈子席位派生（`DeriveSeats()`）

**创建者永久占 1 席**，其余 k-1 席按圈内贡献度名次取。

#### 席位总数 k(m) 阶梯

| 成员数 m | 席位 k |
|---|---|
| ≤ 10 | 1 |
| 11–20 | 3 |
| 21–30 | 4 |
| 31–40 | 5 |
| 41–50 | 6 |
| 51–60 | 7 |
| 61–70 | 8 |
| 71–80 | 9 |
| ≥ 81 | 10 |

公式：`k = min(10, 3 + ⌊(m-11)/10⌋)`

#### 圈内贡献排名（`ContributionRank()`）

- 统计圈内成员发言 msg 事件数
- **防刷窗口**：任意滚动 24h 同 actor ≤ 20 条（贪心接受，边界取整秒）
- 排序：count 降序 → 同数按 actor_id 升序（确定性）
- 零发言成员也在排名尾部

#### 圈子治理门槛（quorum 函数）

| 动作 | 发起门槛 | 投票门槛 |
|---|---|---|
| 移出成员 | ⌈2k/3⌉ 治者签名 | — |
| 解散圈子 | min(2, k) 治者发起 | min(30, ⌊m/3⌋+1) 成员投票 |

#### Decidable

- k ≤ 1 时恒 true
- k > 1 但圈内 msg 事件为空 → Decidable=false（无法排名，fail-closed）

#### 水位（`EventWatermark`）

event_id 集合排序拼接 → sha256 → 前 16 hex。作为**快照水位**：席位按此水位派生，中途新事件不重算。

---

## 六、表结构

### 6.1 govern_proposals

| 列 | 类型 | 说明 |
|---|---|---|
| proposal_id | INTEGER PRIMARY KEY | 自增 |
| action | TEXT NOT NULL | remove / edit / revive / directory_add |
| item_id | TEXT NOT NULL | 目标条目 ID（directory_add 用虚拟 ID） |
| proposer_id | TEXT NOT NULL | 提案人 |
| reason | TEXT | 提案理由 |
| title / body_md | TEXT | edit 载荷 |
| links_json | TEXT | edit 载荷（tag link） |
| base_content_hash | TEXT | 提案时固化的目标内容 hash（乐观锁） |
| content_version | INTEGER | 快照水位（提案建立时的 items 版本） |
| revoked_rev | INTEGER | 快照水位（提案建立时的 blob 版本） |
| source_event_id | TEXT | govern.v1 事件 ID（空=本地写入） |
| created_at / executed_at / voided_at | INTEGER | 毫秒时间戳 |
| executed_result | TEXT | 诊断信息（非契约） |

### 6.2 govern_votes

| 列 | 类型 | 说明 |
|---|---|---|
| (proposal_id, voter_id) | TEXT | PRIMARY KEY（联合唯一） |
| created_at | INTEGER | 毫秒时间戳 |

### 6.3 items 表与治理相关的字段

| 列 | 说明 |
|---|---|
| state | `'active'`（默认）/ `'removed'`（被 remove 或 retired） |
| dist_class | 分发类型（governance 读此） |
| content_hash | 当前内容 hash（乐观锁用） |
| author_id | 创建者（免票选资格判定） |

### 6.4 groupseats 相关（圈子治理）

- `circle_assignments`：圈子成员/席位分配
- `govern_proposals` 里圈子治理的 action 也写入此表，靠 source_event_id / 其他字段区分

---

## 七、P6 融合治理新增：govern_projection + settle

P6（commit 490a97f）新增 govern.v1 事件投影层，实现「提案/投票→事件→投影→自动收敛」统一管线：

| 文件 | 职责 |
|---|---|
| `internal/httpapi/govern_event.go` | 接收 govern.v1 事件（proposal / vote 两种 action），调投影层落库 |
| `internal/store/govern_projection.go` | ProjectGovernProposal / ProjectGovernVote / SettleGovernProposal |
| `internal/store/govern_projection.go: SettleGovernProposal()` | 对已投影提案做最终收敛：读投票人、按当前名册过滤有效票、算门槛、判前置条件、执行 governApplyTx、写 executed_at/voided_at |

**收敛逻辑**：SettleGovernProposal 与 addVoteTx 里的自动执行是**两套独立路径**（addVoteTx 是 HTTP handler 事务内直接执行；SettleGovernProposal 是事件投影后的异步收敛），但门槛计算、前置条件、动作执行全对齐。

---

## 八、测试覆盖

Go 侧 `internal/store/govern_test.go` 覆盖：

| 测试 | 断言 |
|---|---|
| TestAddVoteRemoveNeedsThreeVotes | remove 需要 3 票，生效后 state=removed，executed_result="retired" |
| TestAddVoteReviveNeedsTwoVotes | revive 需要 2 票，目标 state 必须 removed |
| TestAddVoteEditTitleOnlyKeepsAttribution | 标题-only edit 保留 author_id |
| TestAddVoteEditBodyClearsAttribution | 含正文 edit 清署 author_id='' |
| TestAddVoteOptimisticLockVoids | content_hash 不匹配 → void |
| TestAddVoteIdempotentAndDuplicate | 同 voter 重复投 → ErrAlreadyVoted |
| TestAddVoteParallelProposalsSecondVoids | 同 item 并行提案，先执行后 void 另一个 |
| TestAddVoteEmptyRosterDegrades | 空名册 → 有效票 0，pending |
| freeRemove 相关 | 免票选生效条件 / 短路 / fail-closed |

Node 侧测试覆盖对齐 Go。

---

## 九、当前已知缺口

> 以下是代码里**已存在但未覆盖**的东西，或**你这轮对话中才暴露出来**的设计意图与代码实现的差异：

1. **全局治理 = 前 10 截断**，但你希望改成"满足条件的全员投票"——这是本次要改的核心
2. **圈子治理 DeriveSeats 是另一套席位系统**——你想统一成什么？
3. **免票选删除只适用于 course/lesson**——article/video/quiz 的作者能否直接下架？
4. **门槛是硬编码常量**（remove=3, edit/revive=2, directory_add=2/1）——改门槛是改代码重新部署，没有动态调整机制
5. **治理动作没有紧急通道**——任何内容必须提案→投票才能 remove
6. **reject 路由（批 G）只处理评论**——但你已决定不做评论审核，批 G 服务端路由是历史遗留
7. **govern.v1 事件 vs proposal.POST 是两套入口**——P6 融合后是否还保留双入口？

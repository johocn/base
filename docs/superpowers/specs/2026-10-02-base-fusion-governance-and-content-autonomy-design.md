# 融合治理与内容自治：只增不减下的圈子规则与票权口径（P4 设计册 #74）

- 日期：2026-10-02
- 上游：册子 #69（§1.2 铁律二 / §1.3 铁律三 / §2.2 / §2.3 冲突清单）；路线计划 #70（§1 P4 行、§4 六问、§7 铁律追溯）
- 状态：**待评审**。P4 是设计轨，**只出提案、不写代码**；经评审后才允许 P5（并行双跑 → 退役）开工——#70 §1 次序硬约束「P5 不得在 P4 定稿前开工」。
- 性质：设计册。本册**不承载实现契约**，只把铁律二 / 铁律三的数据模型影响收敛为可评审的提案；P6 实现轨另出任务级计划。

## 0. 一句话

铁律二的「只增不减」**已符合**（融合只补本地缺失），缺的是**融合时零圈子参与**；铁律三的票选机制**早已存在**（`#27` 的 `remove` / `edit` / `revive`），缺的是**作用域未被界定为「内容自治」**、且**票权只认三种载体**。本册提案四件事：融合治理走**双轨制**；内容自治**定位为既有提案语义**（不新造创建期闸门）；票权口径**扩到全部载体**；数据模型**最小新增**（1 个事件类型 + 1 列 + 1 张节点侧表），**不新增黄金向量**。

## 1. 现状取证（截至今日本机代码）

| # | 事实 | 证据（文件:行） | 对铁律的判定 |
|---|---|---|---|
| 1 | 反熵**只增不减**：融合时只补本地缺失，多出来的只记录不删 | `internal/peersync/sync.go:129-133`（`res.Extra++`，注「只记录不删」） | 铁律二**已符合** |
| 2 | **融合时零圈子参与**：`SyncPeer` = 包级复制 + 比对 + 块补齐 + 副本登记，全程无圈子 | `internal/peersync/sync.go:52-158`；事件侧 `internal/peersync/eventsync.go` | 铁律二**缺口** |
| 3 | 圈子治理**纯函数已落地**：席位阶梯、多签门槛、贡献排名、席位派生 | `internal/store/groupseats.go:11-41`（`GovernorSeats` / `RemoveQuorum` / `DissolveProposerQuorum` / `DissolveVoteQuorum`）、`:61-99`（`ContributionRank`）、`:134-174`（`DeriveSeats`） | 铁律二**半成品** |
| 4 | `groups` 表 = 节点侧唯一组状态：名单 + epoch + 密钥信封，**不含密钥明文** | `internal/store/schema.go:169-179` | — |
| 5 | 圈子读权**只覆盖圈子自身**：开放圈匿名可读 / 封闭圈需成员签名 / 非成员 404 | `internal/httpapi/server.go:131-133`（`GET /v1/group/{group_id}` 走 `optionalAuth`） | — |
| 6 | 内容可见性**与圈子无关**：`dist_class` 恒 `public`，无「圈内可见」形态 | `internal/store/schema.go:23` | 铁律三**作用域未界定** |
| 7 | 票权**只认三载体**：`article` / `video` / `quiz`；`course` / `lesson` 显式不计贡献 | `internal/store/contributor.go:35-47`（`meetsQualityGate` 的 `default: return false`，注「cover / course / lesson 等不是贡献载体」） | 铁律三**缺口** |
| 8 | 票权常量：`ArticleMinRunes=200` / `VideoMinSeconds=60` / `QuizMinQuestions=3` / `RosterTopN=10`，均为**文档级常量** | `internal/store/contributor.go:9-16` | — |
| 9 | 事件类型**仅 5 种**，属**白名单**放行（未注册 → 400 `event_type_unknown`） | `internal/httpapi/event.go:23-31`（注册表）、`:50-53`（拒绝）、`:63-79`（分支） | — |
| 10 | 内容包**五张表**：`meta` / `articles` / `segments` / `quizzes` / `media_meta`——**不含 `items`、不含 `groups`** | `internal/packexport/export.go:22-58` | — |
| 11 | 既有治理门槛：`remove` 3 票 / `edit`·`revive` 2 票；`directory_add` 2 票（名册 < 10 豁免 1） | `internal/store/govern.go:20-21,28-29,41-59` | — |
| 12 | 免票选删除旁路**已存在**（门槛降 0 立即生效，`executed_result='free_remove'`） | `internal/store/govern.go:494-502` | 铁律一豁免范围 |
| 13 | 票权按**提案快照水位**复判，名册中途变化不改判 | `internal/store/govern.go:156-177`（`filterRosterAtWatermarkSet`） | — |
| 14 | 创建期**无闸门**：容器写路径恒写 `'public','active'`，`POST /v1/submit` 全分支无授权判定 | `#51` 册 `specs/2026-09-30-base-governance-visibility-design.md:47-49`（已核实三条，带行号） | 铁律三**已符合** |
| 15 | 黄金向量 **13 个**，均为协议核纯算法；**现有 5 种事件类型均无向量** | `vectors/v1/`：`canonical` / `hash` / `merkle` / `ed25519` / `aead` / `identity` / `manifest` / `authorsig` / `reqsig` / `release` / `markdown` / `attrs` / `progress` | — |

**取证结论**：铁律二的一半（只增不减）与铁律三的一半（票选机制）都在，缺的是**二者与「圈子」的接线**与**作用域界定**。

## 2. 六问逐条

### 2.1 问一：融合时的圈子规则 → **双轨制**

**约束**：融合动作是**节点数据面**行为（`SyncPeer`，无用户在场）；圈子是**用户身份**概念。二者不能直接等同。

**提案（双轨制）**：

| 轨道 | 触发条件 | 治理主体 | 成员的来源 |
|---|---|---|---|
| **A 参照既有圈子** | 内容携带 `circle.v1` 归属声明，且目标节点 `groups` 表已有该圈子 | 该圈子的 `DeriveSeats` 席位（`groupseats.go:134-174`） | 既有 `groups.member_ids_json` |
| **B 形成新圈子** | 内容**无归属**，或目标节点**无对应圈子** | 新圈子的席位（单成员时 `GovernorSeats(1)=1`） | `{该内容的 `items.author_id`}` |

- **新圈子口径（轨道 B）**：`creator_id` = 内容的 `items.author_id`；初始成员 = `{作者}`（单成员 ⇒ 治理者 = creator，`RemoveQuorum(1)=1`）。
- **无作者的内容**（`items.author_id=''`，如匿名导入）→ **不形成圈子**，登记为「无治理主体」：删除走既有**免票选旁路**（`govern.go:494-502`）或保持现状，**不新造规则**。
- **硬边界**：融合动作**恒只增不减**，**不受**圈子规则约束。圈子只决定「谁有权治理」，**不决定「能不能融合」**——否则铁律二会被圈子规则反噬（§4 风险 1）。

**为什么不是一个轨道**：只做「形成新圈子」会丢掉原话「参照圈子的规则」；只做「参照圈子」则无归属内容永远无治理主体。

### 2.2 问二：数据模型影响 → **最小新增**

**结论**：新增 **1 个事件类型 + 1 列 + 1 张节点侧表**；**不引入内容级圈子读权**。

| 变更 | 类型 | 落点 | 进内容包？ |
|---|---|---|---|
| `circle.v1` 事件类型 | 注册表加一行 + `handleEventPost` 加分支 + 新 handler，承载 `action: assign`（归属声明）/ `action: form`（成圈） | `internal/httpapi/event.go:25-31`、`:63-79` | **否**（事件不进 pack） |
| `groups.origin` 列 | 后加列迁移：`TEXT NOT NULL DEFAULT 'user'`，取值 `user` \| `fusion` | `internal/store/schema.go:287-294`（`groupColumnMigrations` 体例） | **否**（`groups` 不在 pack 五表内，见取证 10） |
| `circle_assignments` 表 | 新表（节点侧独立数据面，照 `directory_terms` 体例 `schema.go:255-268`） | `internal/store/schema.go` `schemaStatements` | **否** |
| `items` 表 | **不动** | — | 否 |
| 内容可见性 | **不动**：仍 `dist_class`（`schema.go:23`） | — | 否 |

`circle_assignments` 建表提案：

```sql
CREATE TABLE IF NOT EXISTS circle_assignments(
  item_id    TEXT    NOT NULL,
  circle_id  TEXT    NOT NULL,
  origin     TEXT    NOT NULL DEFAULT 'fusion',  -- fusion | user
  created_at INTEGER NOT NULL,
  PRIMARY KEY(item_id, circle_id)
)
```

**为什么归属不落 `items`**：`items` 是节点主表，加列会牵连 `export.go` 行映射与 `store.go` 查询面（取证 1 与 P3 的 `store` 数据层已冻结）；而 `directory_terms` 已确立「节点侧独立数据面：不新增 items 行、不进 segments、不进内容包」的体例（`schema.go:255-257`），归属关系照此办理即可。

**明确不做**：**不引入内容级圈子读权**（不给 `items` 加 `circle_id` 读权字段、不改公开读路由按圈子过滤）。内容可见性仍是 `dist_class`，圈子读权仍只覆盖 `GET /v1/group/{id}`（取证 5）。

### 2.3 问三：`vectors/` 影响 → **本册不新增，登记为 P6 交付物**

- `circle.v1` 是**事件类型**，不是纯算法；现有 5 种事件类型**均无**黄金向量（取证 15），故**本册不新增向量文件**。
- **但登记一条 P6 交付物**：若 P6 把席位派生（`GovernorSeats` / `ContributionRank` / `EventWatermark` / `DeriveSeats`）移植为 TS，**须补 `vectors/v1/seats.json`**。理由：`ContributionRank` 的注释明写「同分按 `actor_id` 的 hex 字典序升序（**各节点同解的前提**）」（`groupseats.go:56-60`）——跨实现不同解会让融合后的治理视图在 Go / Node 两侧漂移，正是 #70 §6 判据 5「治理派生视图逐条一致」的红线。
- 本册**不**新增该向量，避免越过「P4 只出提案」的边界。

### 2.4 问四：与 `#27` / `#58` 如何共处 → **三层分工，不新增门槛**

| 层 | 管什么 | 现状门槛 | 本册动作 |
|---|---|---|---|
| 圈子治理（`#33`） | **成员**（移出 / 解散） | `RemoveQuorum` = ⌈2k/3⌉；`DissolveVoteQuorum` = min(30, ⌊m/3⌋+1)（`groupseats.go:23-41`） | **保留，不改** |
| 节点级治理（`#27`） | **条目**（`remove` / `edit` / `revive`） | `remove` 3 / `edit`·`revive` 2（`govern.go:20-21`） | **保留，不改** |
| 目录准入（`#58`） | **词条**（`directory_add`） | 2（名册 < 10 豁免 1）（`govern.go:54-59`） | **保留，不改** |
| 融合治理（本册） | 条目**归属哪个圈子** | **无门槛**（不产生提案） | **新增归属，不加门槛** |

**共处口径**：**圈子管成员，节点级治理管条目，融合只决定条目的圈子归属**。融合**不改写、不删除**（铁律二），故**不产生任何提案**，不新增第三套门槛，也就不会与 `#27` / `#58` 的门槛语义打架。

### 2.5 问五：铁律三作用域 → **定位为既有提案语义**

**结论**：**内容自治 = `#27` 既有 `remove` / `edit` / `revive` 的语义定位**，**不新造创建期闸门**。

与 `#51` 登记的「不建审批闸门」调和（两条正交）：

| 维度 | `#51` 的「不建闸门」 | `#27` 的闸门（= 内容自治） |
|---|---|---|
| 时机 | **创建期** | **事后** |
| 对象 | 作者自己的新内容 | **他人的**已有条目 |
| 现状 | 恒 `active` / `public`，无授权分支（取证 14） | `remove` 3 / `edit`·`revive` 2 |
| 作者改自己的内容 | — | **永免审批**，指向 `POST /v1/submit`（`#27` 册 `:121,437`） |

⇒ 一句话：**创建自由，事后可被票选下架 / 改写**。二者不冲突，`#51` 措辞**不需修订**；本册只补作用域界定。

### 2.6 问六：票权口径 → **扩到全部载体**

**结论（用户已定）**：把 `course` / `lesson` 纳入 `meetsQualityGate`（`contributor.go:35-47` 现为显式 `return false`）。

**取证结论（2026-10-02，推翻初版提案）**：初版拟给 `lesson` 加「正文非空白字符数 ≥ 200（`LessonMinRunes`）」——**该口径在节点侧不可测**。[submit.go:86-90](`internal/httpapi/submit.go`) 定死容器 `segments` 三档语义：`seq<0` 只放属性行（`protocol.IsAttrKind`）、`seq=0` 只放一行 digest、`seq≥1` **只放子项引用**（课时的子项 kind 限 `article/video/audio/quiz`，`text` 存的是**子项 id**、不是正文）。⇒ **课时没有任何自有正文字段**，「课时正文 rune 数」无取数来源。故容器门槛一律改用**达标子项数**，不碰正文。

| 载体 | 现状 | 门槛（定稿） | 常量名 | 对齐依据 |
|---|---|---|---|---|
| `article` | ≥ 200 非空白字符 | 不变 | `ArticleMinRunes = 200` | 既有 |
| `video` | ≥ 60 秒 | 不变 | `VideoMinSeconds = 60` | 既有 |
| `quiz` | ≥ 3 题 | 不变 | `QuizMinQuestions = 3` | 既有 |
| `lesson` | **不计** | 含 **≥ 1 个达标子项**（子项按上三行既有门槛判定） | `LessonMinItems = 1` | 用「子项数」替掉不可测的 rune 口径 |
| `course` | **不计** | 含 **≥ 3 个达标课时**（课时按上一行判定） | `CourseMinLessons = 3` | 对齐 `QuizMinQuestions` |

- 常量仍是**文档级常量**，校准走「改册子 + 改常量」，照 `contributor.go:9` 体例，**不加配置项**。
- **防刷（已定）**：**一门课程及其达标课时按 1 条计**——课程计 1；其达标课时**不再计**；仅**无所属课程**的课时独立计 1（父课程靠课时 `item_id` 前缀 `course/<cid>/` **零 schema 解析**，见 §6 决策 6）。避免「一门课 N 课时 = N+1 票」刷榜。
- **判定深度**：至多两层（`course` → 达标课时 → 达标子项），全部落在既有表（`items` / `segments` / `articles` / `quizzes` / `media_meta`），**不新增表、不碰正文以外的字段**。

**影响面（必须登记，P6 前须实测）**：

1. **名册池变大** → `RosterTopN = 10` 的截断竞争加剧。**存量提案受快照水位保护**（`govern.go:156-177`）不受影响；**新提案**的票池口径变化。
2. **`#58` 小节点豁免触发面收窄**：豁免条件是「名册 **< 10**」（`govern.go:54-59`）——名册变大后，原本 < 10 的小节点可能 ≥ 10 而**失去豁免**，这与 `#65` 刚收敛的口径直接相关。**这是本册唯一可能反向影响既有行为的改动，P6 前必须实测**（§4 风险 3）。
3. `#65` 的门槛常量本体（`GovernThresholdForRoster`）**不动**，只动名册派生**输入**。

## 3. 数据模型变更清单（提案汇总）

| # | 变更 | 类别 | 进内容包 | 改 `schema_version` | 服务铁律 |
|---|---|---|---|---|---|
| 1 | `circle.v1` 事件类型（**单类型双 `action`**：`assign` / `form`，对齐 `group.v1` / `govern.v1` 体例） | 新事件类型 | 否 | 否 | ② |
| 2 | `groups.origin` 列（`user` \| `fusion`） | 后加列 | 否 | 否 | ② |
| 3 | `circle_assignments` 表 | 新表（节点侧） | 否 | 否 | ② |
| 4 | `meetsQualityGate` 扩 `course` / `lesson` | 派生逻辑 + 2 常量 | 否 | 否 | ③ |
| 5 | 黄金向量 | **不新增** | — | 否 | — |

**零改内容包规范 v1、零 bump `schema_version`、零新 HTTP 接口**（`circle.v1` 走既有 `POST /v1/event`）。

## 4. 风险与回退

| # | 风险 | 影响 | 处置 / 回退 |
|---|---|---|---|
| 1 | 圈子规则**反噬只增不减**：若让圈子规则决定「能不能融合」 | 铁律二被架空 | 本册 §2.1 写死：圆圈只决定**治理权**，不决定**融合**；融合恒只增不减 |
| 2 | **单成员圈子 = 作者自审**（轨道 B 初始成员 = {作者}，**2026-10-02 已定**） | 内容自治在该情形下无制衡 | 已定取舍：`m=1 ⇒ GovernorSeats=1 ⇒ Decidable=true`（恒可判定）、无名册快照、零额外取数；条目治理仍归 `#27`。回退方案 = 初始成员改为「作者 ∪ 目标节点名册」，但 `m=11 ⇒ k=3` 且新圈子零 `msg` 事件 ⇒ `Decidable=false`，**P6 若要改须先解决该不可判定态** |
| 3 | **票权扩载体 → `#58` 小节点豁免面收窄** | 小节点失去「名册 < 10」豁免 | P6 实现前实测；回退方案 = 两套票池解耦（内容自治用全载体池、目录准入仍用原三载体池）——用户已选「不采解耦」，故回退须重新确认 |
| 4 | **新旧节点混跑期 `circle.v1` 被拒** | 白名单 fail-closed：旧节点收新类型 → 400 `event_type_unknown`（取证 9） | 新事件**只能在双端升级后启用**；P6 交付物须含「先升节点、后开事件」的发布次序 |
| 5 | 跨实现席位派生不同解 | 融合后治理视图漂移，破 #70 §6 判据 5 | P6 补 `vectors/v1/seats.json`（§2.3） |
| 6 | 保底：容器质量门槛口径不易定 | 门槛失真致刷榜或误排除 | **已定**（§6 决策 5/6）：容器一律「达标子项数」口径（`LessonMinItems = 1` / `CourseMinLessons = 3`），且课程与其达标课时**合并计 1**。P6 实现后须实测刷榜面与误排除面 |
| 7 | **容器门槛的取数成本**：需顺 `segments` 反查子项再判达标 | `ContributorRoster` 取数变重（现只查 `items` 三载体，`contributor.go:90-164`） | P6 实现时评估批量查询（照 `ListArticles` / `ListQuizzes` / `ListMediaDurations` 既有批量体例）；本地条目量 1e3 量级，预期可接受 |

## 5. 追溯

| 铁律 | 本册落点 | 判定 |
|---|---|---|
| **一 同核双形态** | 不涉及（本册纯设计）；`circle.v1` 的 TS 实现随 P6，落在 `packages/core-ts` | 中性 |
| **二 融合只增不减** | §2.1 融合恒只增不减 + 圆圈只定治理权；`circle_assignments` 为**追加式**（PRIMARY KEY(item_id,circle_id)，只插不删） | ✅ 设计已守住 |
| **三 内容自治** | §2.5 定位为既有提案语义；§2.6 票权扩全部载体 | ✅ 作用域已界定 |

**与上游的一致性**：`#69 §2.2` 判定「融合治理零实现」→ 本册给出提案；`#69 §2.3` 判定「票权口径部分冲突」→ 本册 §2.6 扩载体；`#70 §4` 六问 → 本册 §2.1–§2.6 逐条回答。

## 6. 决策点（**8 项已全部拍板**，2026-10-02）

第一轮（范围级）：

| # | 决策 | 取 |
|---|---|---|
| 1 | 融合时的圈子主体 | **双轨制** |
| 2 | 内容自治作用域 | **定位为既有提案语义**（不新造闸门） |
| 3 | 票权口径 | **扩到全部载体** |
| 4 | 数据模型档位 | **最小新增** |

第二轮（口径级，2026-10-02 二次拍板；**本册 §2.6 / §3 / §4 已按此定稿**）：

| # | 决策 | 取 | 依据 |
|---|---|---|---|
| 5 | `lesson` / `course` 质量门槛口径 | **「达标子项数」口径**：`LessonMinItems = 1`（含 ≥1 个达标子项）/ `CourseMinLessons = 3`（含 ≥3 个达标课时）；**废弃** `LessonMinRunes` | 课时 `segments` 只存子项 id、**无自有正文** ⇒ rune 口径不可测（§2.6 取证） |
| 6 | 新圈子初始成员 | **仅 {作者}** | `m=1 ⇒ k=1 ⇒ Decidable=true`；加到名册则 `m=11 ⇒ k=3` 且零 `msg` ⇒ `Decidable=false`（§4 风险 2） |
| 7 | 课程与达标课时的贡献计数 | **合并计 1**（课程计 1；其达标课时不再计；仅无所属课程课时独立计 1） | 防「一门课 N 课时 = N+1 票」刷榜；父课程靠 `item_id` 前缀零 schema 解析 |
| 8 | `circle.v1` 形态 | **单类型双 `action`**（`assign` / `form`） | 对齐 `group.v1`（`msg`/`roster`/`roster_v2`）与 `govern.v1`（`create`/`vote`/`directory_add`）既有体例，白名单只加一条 |

**状态**：本册**待评审**（P4 设计轨）；一经评审通过，P5 方可开工（`#70 §1` 次序硬约束）。P6 实现轨的前置清单 = §3 数据模型变更清单 + 风险 3/7 的实测项 + `vectors/v1/seats.json`。

## 7. 不做

- **不写任何生产代码**（P4 是设计轨）。
- 不改内容包规范 v1、**不 bump `schema_version`**。
- **不引入内容级圈子读权**（`items` 不加 `circle_id`、公开读不按圈子过滤）。
- **不新增 HTTP 接口**（`circle.v1` 走既有 `POST /v1/event`）。
- **不改 `#27` / `#58` / `#33` 的门槛与语义**、不加配置项。
- **不新增黄金向量**（登记为 P6 交付物）。
- 不删 Go 实现、不碰 P5、不做 iOS。

## 附录 A：CLI 命令分发表审查（2026-10-02）

**性质**：登记项，**不构成契约**；来源 = 「执行 P4」同批任务。

### A.1 现状对照

| 维度 | Go `cmd/based/main.go` | Node `apps/node/src/main.ts` | 判定 |
|---|---|---|---|
| 命令条数 | **11** 条 | **8** 条 | 缺口 3 条 |
| 缺失项 | — | 缺 `import-video` / `peer-sync` / `scrub` | 属 **P3 余下批次**，非本批遗漏 |
| `usage` 串 | `main.go:47` | `host/cli.ts:4-5` | **逐字一致** ✅ |
| 无命令 / 未知命令 | `usage()` → `exit 2`（`main.go:11-14,39-42`） | 打印 USAGE → 返回 **2**（`cli.ts:16-19`） | **一致** ✅ |
| 未知 flag | `flag.NewFlagSet(..., flag.ExitOnError)` → **exit 2**（10 个子命令均如此） | 抛错 → `error:` + 返回 **1**（`cli.ts:22-26`、`flags.ts:34`） | **偏差**（已知） |
| 业务错误 | `must(err)` → **exit 1**（`main.go:50-54`） | 同上 → 返回 **1** | **一致** ✅ |

### A.2 结论

1. **缺口归属**：`import-video` / `peer-sync` / `scrub` 三条属 P3 余下批次（`#70 §1` P3 行「导入 / 导出 / 对端同步 / scrub / CLI / 门户」），**不在 P4 范围**。
2. **退出码偏差**：未知 flag Node=**1** vs Go=**2**。`CliHost` 属 `#72` 冻结面（`#70 §3.2` 附表），且 P3 册 §9.2 已登记为**不在 G8 范围**——本册**只登记不处置**；若 P5 判据 3「错误码语义一致」需要，须另开任务级计划。
3. **文档缺陷已修正**：`#70 §5` 的 CLI 名单曾写成 `import` / `importvideo` / `tlscert` / `storekey` / `peersync`，与真实分发表不符，已就地改为 `import-md` / `import-video` / `tls-cert` / `store-key` / `peer-sync` 并补齐 Node 侧缺口说明。

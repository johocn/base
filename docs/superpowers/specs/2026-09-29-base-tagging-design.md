# base 统一标签体系与治理写入设计（治理线 第 5 册）

- 日期：2026-09-29
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲；本册依据其 §0.8、§6.0、§3、§9、§12）
- 直接上游：`specs/2026-09-28-base-course-design.md`（#14：`segments` 容器承载与两条哈希口径）、`specs/2026-09-27-base-comment-event-sync-design.md`（#19：`comment.v1` 事件与 `comment/<event_id>` 投影主键）、`specs/2026-09-28-base-contribution-roles-design.md`（#23：**全站治理人名册** `GET /v1/contributors`）、`specs/2026-09-29-base-governance-circle-design.md`（#33：**圈子治理人** `governors` / `seat_count`、`govern.v1` 事件化与快照水位）、`specs/2026-09-28-base-submission-design.md`（#25 §0.2：`POST /v1/submit` 接受 `type=tag`）、`specs/2026-09-28-base-approval-governance-design.md`（#27 §0.5：`edit` 载体扩到 `tag` 型）
- 范围：**统一标签（`名称 / 章 / 节` 三元组）的一位条目、与 course / lesson / article / comment 的关联、治理人直打与改标提案、跨节点传播与手机端重建**
- 本册子**不覆盖**：学习进度与打卡（归 #8）；课程分类（归 #36）；考核与作答结果（归 #8）；标签的批量合并 / 重命名运维；② 类内容打标；标签全文检索与热度；内容包规范 v1 的任何字段变更

## 0. 改版说明

### 0.1 2026-09-29 初版

**动机**：用户口径为「站点课程、课时、文章、评论等重要内容都要与标签关联；统一标签有三个字段：标签名称、章、节；重要内容必须写标签，标签由治理人填写；其他都是标签使用者；全站治理人与圈子治理人都有权限给无标签内容打标签；有标签内容要更改，走治理原则」。站点此前**完全没有标签功能**——`articles.tags_json` 三处有列、全仓零使用。

**本册第一次定义（新增）：**

- **三元组语义与编码**：`名称 / 章 / 节` 三级**均必填**、全站唯一；三元组编码进 `item_id` ⇒ `tag/<名称>/<章>/<节>`，唯一性天然成立（§3.1）
- **标签是一等条目**：`source=tag` / `type=tag` / `sqlite_table=segments`（总纲 §0.8 已回填 §6.0）
- **关联的权威表 `tag_links(tag_id, target_id, kind)`**，`kind ∈ course | lesson | article | comment`；`pack.sqlite` **不加表**（§3.2、§3.3）
- **直打**：`POST /v1/submit` 的 `type=tag` 分支，资格 = #23 名册 ∪ #33 治者集合，**且只允许给「当前无标签」的目标打标签**（§3.4）
- **改标**：走 #27 提案（`edit`，2 票）——「有标签内容要更改，走治理原则」的落地（§3.5）
- **必填是软规则**：节点不强制、不拒写；缺失只以 UI「待补标签」标识呈现（§3.6）
- 手机端标签页 + 本地 `tag_links` 派生表 + 离线写入复用 #29 的 `my_submissions` 队列（§5）

**一处实现口径的收窄（结论不变，理由照实写）：** 评审时的口径是「`tag_links` 为权威，**导出时**把 `tag_links` 投影进标签条目的 `segments` 行」。本册把它落为「**写入时同一事务落投影行**」，`tag_links` 仍是唯一权威（写路径与提案都以它为准），`segments` 行只是同一次写入的**确定性物化**：

- 理由：条目级 `content_hash` 走 #14 §3.3 的容器口径（哈希**只看 `segments` 行**）。若节点库里没有这些行、只在导出那一刻才生成，则节点自身 `items.content_hash` 与导出 manifest 里的值会分叉——`GET /v1/catalog` 报一个哈希、接收侧按 `pack.sqlite` 重算是另一个，客户端会把它误报成「包损坏」。同事务写两处则**不可能分叉**（同一份输入、一次提交）。
- 由此的附带收益：`packexport` **零改动**（既有 `segments` 分支直接工作），不需要为标签新增任何导出分支。
- **对内容包与手机端的结论一字不变**：`pack.sqlite` 不加表、不 bump `schema_version`；关联经 `segments` 行传播；接收侧与手机端据这些行回填本地 `tag_links` 派生表（§3.3、§5.1）。

**明确沿用、不改动：**

- 内容包规范 v1 的 `manifest.json` 字段与 `pack.sqlite` 五表 DDL（**不新增表、不新增字段、不 bump `schema_version`**）
- #14 §3.1 的行语义与 §3.3 的**两条哈希口径**
- `POST /v1/submit` 的签名头鉴权、`author_sig` 五键签名域（`base/author-v1`）、占用口径、限速（#25）
- #27 的三动作、门槛（`remove` 3 票 / `edit`·`revive` 2 票）、生效事务、`govern_*` 投影（票权按 #33 §0.2 的**名册快照水位**）
- #23 名册的派生口径与 `GET /v1/contributors`；#33 的 `governors` / `seat_count` 与 `govern.v1` 传播通道
- #29 的本地台账 `my_submissions`（离线写入队列，**零新表**）
- `dist_class` 这一唯一的可见性维度

**实施前置（硬）：** 「圈子治理人」的判定依赖 **#35 Phase 1** 已落地（`groups.governors` / `seat_count`）。若 #35 未落地，本册只能以 #23 名册单源判定，**不得**自造圈子治者口径。

### 0.2 2026-09-30 执行期口径回填

实施计划（`plans/2026-09-30-base-tagging-plan.md`，#38）执行期与本册的六处差异，**结论按本节为准**：

1. **§4 的 `ListUntagged(kind, ids)` 作废**：实施期确认它**没有任何调用点**——「待补标签」的判定完全落在客户端（`core/tags.ts` 的 `untaggedTargets(items, rows)` 用本地 `tag_links` 反查），节点侧不做、也不提供该接口。`idx_tag_links_target` 索引保留（供「这个内容有哪些标签」使用）。
2. **§4 的 `tagColumnMigrations` 不必要**：`tag_links` 是全新表，由 `schemaStatements` 直接建；`tagColumnMigrations` 只对「给已有表补列」有意义。实施期**不新增**该常量。
3. **§5.3 的版本号作废**：该行写的 code `18` 已被 `0.13.1` 占用。本册实际发布 **`0.14.0` / `19`**（独立发布）；四步流程不变。
4. **§3.1 的归一化收窄**：原文「各段先 NFC 归一化、再去首尾空白」中的 **NFC 无法落地**（Go 标准库无 NFC，仓库不含 `golang.org/x/text`，不为一个归一化引入新依赖）。实施口径为「**去首尾空白（Go `strings.TrimSpace` / 客户端 `trim`）+ 归一化后非空 + ≤ 64 rune**；客户端**不**调 `String.prototype.normalize`」。其余（百分号编码、`title` 由 `item_id` 重建、不做 `slug` 校验）逐字不变。
5. **§3.5 的改标载荷存储**：原文只写「载荷为 `links[]`」未定义存储。实施口径为**新列 `govern_proposals.links_json TEXT NOT NULL DEFAULT ''`**（走既有 `governColumnMigrations` 幂等补列），存 `links[]` 的规范 JSON；**不复用 `body_md`**（`body_md` 是 article 载体的语义，混用会让 `scanProposal` 与前端看板都需要按载体二次解释）。空串按「空关联集」解（合法）。
6. **§4 的改动面漏了三处节点侧改动**：① `internal/httpapi/govern.go` 的 `edit` 校验必须从「写死 `it.SQLiteTable != "articles"` 就拒」改成**按载体系分流**（`articles` 走 `title`+`body_md`，`tag` 型走 `links[]`），且载体相关校验要挪到 `GetItem` **之后**；② 资格判定落在 **`internal/store` 的 `GovernorSet() map[string]bool`**（#23 名册 ∪ 各圈 `DeriveSeats().Governors` 的去重并集），`submit.go` 只调用它、不自己拼集合；③ 客户端侧新增本地列 `my_submissions.links_json`（离线标签投稿补发时重建草稿用，见本册 §5.2 的「断网入网 → 联网补发」链路）。

### 0.3 2026-10-01 上游回填（#58 立册）

标签**名称段**纳入节点级目录（`kind=tag`）；未 approved 的名称在全端显示「待票选」角标（`#58 §5`）。三元组编码、`tag_links` 表、直打与改标路径、软规则口径**一字不改**。

## 1. 目标与判定

| # | 目标 | 判定 |
|---|---|---|
| 1 | 标签有三个字段且全站唯一 | 三段相同（归一化后）必得同一 `item_id`，不产生第二条目（§3.1、AC 1） |
| 2 | 三段都必填 | 任一段归一化后为空 → 拒绝，不存在「只有名称的标签」（§3.1、AC 2） |
| 3 | 治理人能直接给无标签内容打标签 | 名册内提交 → 生效、`tag_links` 有行、导出后对端可读（§3.4、AC 3） |
| 4 | 不是治理人不能打标签 | 名册外提交 → `403 tag_not_governor`，不写入（§3.4、AC 4） |
| 5 | 有标签内容要更改走治理原则 | 对已有标签的目标再打标 → `403 tag_target_tagged`；走提案 2 票后生效（§3.5、AC 5） |
| 6 | 只在 ① 类内容上打标 | `group.v1` / `dm.v1` 的 `event_id` 一律拒（§3.7、AC 6） |
| 7 | 标签跨节点可传播 | A 节点打标 → 导出 → B 节点导入后 `tag_links` 逐行一致（§3.3、AC 7） |
| 8 | 内容包规范不变 | `schema_version` 仍 `1`、五表 DDL 未变、不加表不加字段（AC 8） |

**非目标**：不做标签层级超过三层、不做同义词与别名、不做批量合并运维、不做 ② 类打标、不做按标签的检索与热度。

## 2. 开工前已核实的现状缺口

| # | 现状 | 对本册的影响 |
|---|---|---|
| 1 | `articles.tags_json` 三处有列，**全仓无任何功能使用** | 标签**不**复用该列：它随 `articles` 行走、只能是「文章 → 词串」，无法承载「目标 → 标签」的任意 `kind`。本册走一等条目 + `tag_links` |
| 2 | `internal/store/segments.go` 的读写与哈希**完全通用**（不认 `source`） | 标签条目零新存储代码（总纲 §0.8 已扩值） |
| 3 | `internal/packexport` 的 `exportableTables` 白名单**已含 `segments`**，且按 `seq` 升序写出 | 标签条目按 `segments` 导出，**零改动**（§0.1 的口径收窄使其成立） |
| 4 | `ImportPack` 的 `sqlite_table` 分支**已含 `segments`** | 含标签条目的包可直接入库；**另需一段后处理**把行回填进 `tag_links`（§4.4） |
| 5 | `internal/store/comment.go` 的评论投影行主键是 **`EventID`**（`ListComments` 硬过滤 `type='comment.v1'`） | 评论引用形态定为 `comment/<event_id>`；`kind=comment` 的存在性校验必须查 `comment.v1`，这同时天然排除 ② 类 |
| 6 | `POST /v1/submit` 的 `type` 原本只接受 `article` / `quiz` | 已由 #25 §0.2 扩入 `tag`，并新增 `403 tag_not_governor` |
| 7 | #27 §0.3 原把 `edit` 限定在 `articles` 载体 | 已由 #27 §0.5 扩到 `tag` 型，载荷为 `links[]`（全量替换） |
| 8 | #23 已落地 `GET /v1/contributors` 与 `store.ContributorRoster()` | 「全站治理人」判定零新代码 |
| 9 | #33 的 `governors` / `seat_count` 由 **#35 Phase 1** 落地 | 「圈子治理人」判定**依赖 #35**，本册不自造（§0.1 实施前置） |
| 10 | #29 已落地 `my_submissions` 台账（兼投稿队列）与补发编排 | 标签写入的离线队列**零新表** |

## 3. 契约

### 3.1 三元组语义与编码

| 项 | 值 |
|---|---|
| 三个字段 | **名称** / **章** / **节**，三个**均必填** |
| 归一化 | 各段先 NFC 归一化、再去首尾空白；归一化后必须非空且 ≤ 64 rune |
| 编码 | 各段内的 `/` `\` `%` 及控制字符做百分号编码（`%2F` `%5C` `%25` 等），其余字符（含中文）原样保留 |
| `item_id` | `tag/` + `enc(名称)` + `/` + `enc(章)` + `/` + `enc(节)` |
| `items.title` | `<名称> · <章> · <节>`（三段**原文**以 ` · ` 连接，不编码） |

**唯一性由 `item_id` 天然承载**：三段归一化后完全相同 ⇒ 同一个 `item_id` ⇒ 同一个条目。**不引入额外的判重表或判重接口。**

- **`title` 不是自由字段**：服务端按 `item_id` 重建 `title` 并校验请求体所传 `title` 与之逐字相等，不等 → `400 item_title_invalid`（#25 §2.1 的既有码）。由此**改三段中的任何一段 = 换一个 `item_id` = 新建条目**，所以 #27 的 `edit` 对 tag 载体**不需要** `title` 字段（#27 §0.5）。
- **三段编码后不做 `slug` 校验**（#25 §2.4 已登记该例外）：标签名是人工词条，不是机器标识。

### 3.2 关联模型

**节点侧唯一权威 = `tag_links` 表**：

```sql
CREATE TABLE IF NOT EXISTS tag_links(
  tag_id     TEXT NOT NULL,   -- tag/<名称>/<章>/<节>
  target_id  TEXT NOT NULL,   -- 条目 item_id，或 comment/<event_id>
  kind       TEXT NOT NULL,   -- course | lesson | article | comment
  created_at TEXT NOT NULL,
  PRIMARY KEY (tag_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_id);
```

| `kind` | `target_id` 形态 | 存在性校验（提交时） |
|---|---|---|
| `course` | `course/<cid>` | 必须在本节点 `items` 表且 `state='active'` |
| `lesson` | `course/<cid>/lesson/<lid>` | 同上 |
| `article` | `article/<aid>` 或 `course/<cid>/lesson/<lid>/article/<aid>` | 同上 |
| `comment` | `comment/<event_id>` | 必须是本节点 `events` 表中 `type='comment.v1'` 的 `event_id`（**排除 ② 类**，§3.7） |

- **多对多**：一个目标可挂多个标签，一个标签可关联多个目标。
- **`video` 不设 `kind`**：要给视频打标就打在它所属的 `lesson` 上——刻意的边界，避免在「同一课时内多个视频」时产生归属歧义。
- **反查索引 `idx_tag_links_target`** 服务的正是两处查询：「这个内容有哪些标签」与「哪些内容还没有标签（待补）」。
- **目标被下架（`remove`）后不做级联删除**：`tag_links` 行保留，客户端按「悬空引用静默跳过」处理（与 #36 §3.2 同族口径）。

### 3.3 传播：物化的 `segments` 投影 + 接收侧回填

标签条目的 `segments` 行是**同一事务内的确定性物化**（§0.1 的口径收窄）：

| `seq` | `kind` | `text` |
|---|---|---|
| `1..n` | 该关联的 `kind`（`course` / `lesson` / `article` / `comment`） | 该关联的 `target_id` |

**排序口径（写死，否则导出不确定）**：先按 `kind` 的**固定序** `course` < `lesson` < `article` < `comment`，同 `kind` 内按 `target_id` **字典序升序**，`seq` 依次取 `1..n`。条目级 `content_hash` 由此确定（#14 §3.3 的容器口径）。

- 标签条目**不写** `seq=0` 简介行：标签的语义完全由三元组 + 关联集表达，没有「简介」这一维度。
- 标签条目**不由导入器产出**：标签是**治理动作**（§3.4），不是来源站内容——本地导入器与本册无关，不新增任何 front-matter 键。
- **接收侧回填**：`ImportPack` 入库后，对所有 `tag/` 前缀条目，按上表把 `segments` 行**幂等**写进本地 `tag_links`（先删该 `tag_id` 的行、再按行插入）；回填**不校验目标存在性**（评论事件未必已同步，引用允许悬空）。
- 手机端同理（§5.1）。

### 3.4 直打：治理人给**无标签内容**打标签

复用 `POST /v1/submit`（#25 §0.2），请求体：

```json
{
  "type": "tag",
  "item_id": "tag/<名称>/<章>/<节>",
  "title": "<名称> · <章> · <节>",
  "links": [ { "target_id": "course/<cid>", "kind": "course" } ],
  "author_sig": "<hex>"
}
```

**资格（本接口第一次出现「验签通过但仍可能无权写」）**：`author_id` 必须 ∈ **本节点治理人集合** = #23 名册（`store.ContributorRoster()`）**∪** #33 各圈治者集合的并集（`governors`）。不在集合内 → `403 tag_not_governor`。

**直打条件（节点强校验，「给无标签内容打标签」的落地）**：

> 本次提交涉及的**每一个** `target_id`，其当前标签集必须为空（`tag_links` 中不存在任何指向它的行）。

- 满足 ⇒ 生效：同一事务内写 `items` + `tag_links` + 物化的 `segments` 行。
- 任一目标**已有**标签 ⇒ **整体拒绝**，`403 tag_target_tagged`（人读文案引导「该内容已有标签，请走治理提案」，见 §3.5）。**不做部分生效、不做自动合并**（与 #25 的「无半条结果」同一口径）。
- `links` 为**全量替换**语义（复用 #27 §0.5 的同一份写函数）；`links` 为空数组时等价于「新建一条尚无关联的标签」，合法。
- 其余校验全部沿用 #25：签名头鉴权、`author_sig` 五键签名域、`item_id` / `type` 前缀一致、`title` 重建校验、占用口径（同 `item_id` 被他人占用 → `403 item_id_taken`）、`content_hash` 服务端算、限速与 `maxSubmitBytes`。
- **`content_hash` 是本册的签名锚点**：`links` 一变，条目级哈希必变，旧 `author_sig` 自然失效（#25 §3.2 的「改写必重签」在这里对标的是**整个关联集**，不是单条关联）。

### 3.5 改标：走 #27 提案（2 票）

**改动是否走提案，判定单位是「目标」而不是「标签」**（精确对应「给无标签内容打标签」与「有标签内容要更改」两句口径）：本次涉及的**每一个** `target_id` 当前都无标签 ⇒ 走直打（§3.4）；**只要涉及任一「已有标签」的目标**（给它换标、加标、摘标）⇒ 走 #27 的 `edit` 提案（2 票）。另有一条来自占用口径的硬约束：标签条目若已存在且**不属调用者**，直打一律 `403 item_id_taken`（#25 §3.1），同样只能走提案——故「给别人的标签追加一个目标」在跨治理人场景下必然落回提案。

`edit` 提案的请求体：

```json
{ "action": "edit", "item_id": "tag/<名称>/<章>/<节>",
  "edit": { "links": [ { "target_id": "course/<cid>", "kind": "course" } ] } }
```

- 门槛 **2 票**（#27 §0.2 分档不变）；票权按 #33 §0.2 的**名册快照水位**判定。
- 生效时**全量覆盖**该 `tag_id` 的 `tag_links` 行 → 重算物化 `segments` 行与 `content_hash` → **`author_id` / `author_sig` 不动**（#27 §0.5）。
- **已知特性（照实登记）**：提案的粒度是「**整个标签的关联集**」，不是单条关联。给标签 X 追加一个目标，等于对该标签的全部关联集投一次票。
- **提案自身的跨节点传播不新开通道**：走 #33 的 `govern.v1` 事件（反熵零改动）。本册**不做**标签类的跨节点提案同步。

### 3.6 必填范围与软规则

| 项 | 口径 |
|---|---|
| 必填范围 | `course` / `lesson` / `article` / `comment` 四类（「重要内容必须写标签」） |
| **强制程度 = 软规则** | 节点**不强制、不拒写、不加状态位**：无标签内容可以长期存在 |
| 呈现 | 仅在客户端 UI 以「**待补标签**」标识提示，供治理人补 |
| 评论的差别 | 「待补标签」标识只在 `course` / `lesson` / `article` 三类呈现；评论**仅在已有标签时**显示标签，**不**逐条标「待补」 |

### 3.7 只覆盖 ① 类

| 内容 | 能否打标 |
|---|---|
| `course` / `lesson` / `article`（① 类公开内容） | 能 |
| `comment/<event_id>`（`comment.v1`，① 类公开评论） | 能 |
| ② 类内容（`group.v1` 圈内发言、`dm.v1` 私信） | **不能**，其 `event_id` 提交一律拒 |
| ③ 类内容 | 不属于本系统（总纲 §2） |

**为什么 ② 类不打标**：节点的 `tag_links` 是**明文**表，打标等于用明文索引描述一份节点本不可读的内容（「谁把哪条密文归到哪个标签」），这正是总纲 §3 第 3 条禁止的「为 ② 类建立明文派生索引」。**这是红线，不是遗漏。**

## 4. 节点侧改动面

| 位置 | 改动 |
|---|---|
| `internal/store` | 新增 `tag_links` 表与 `tagColumnMigrations`（幂等建表，与既有 `groupColumnMigrations` 同法）；方法：`ReplaceTagLinks(tagID, links)`（事务内删旧行 + 写新行 + 写物化 `segments` 行 + 写 `items`）、`ListTagLinks(tagID)`、`ListTagsOf(targetID)`、`ListUntagged(kind, ids)`（「待补标签」反查） |
| `internal/httpapi/submit.go` | 新增 `type=tag` 分支：契约校验（§3.1 编码 + `title` 重建校验）、治理人资格判定（§3.4）、直打条件判定（§3.4）；错误码新增 `tag_not_governor`（#25 §0.2）与 `tag_target_tagged`（本册） |
| `internal/store`（导入侧） | `ImportPack` 收尾增一段后处理：把 `tag/` 前缀条目的 `segments` 行幂等回填进 `tag_links`（§3.3） |
| `internal/packexport` | **零改动**（§0.1 的口径收窄使其成立） |
| `internal/importer` | **零改动**（标签不由导入器产出） |
| 内容包规范 v1 | **零改动**：不加表、不加字段、不 bump `schema_version` |

## 5. 手机端设计

### 5.1 本地表与重建

```sql
CREATE TABLE IF NOT EXISTS tag_links(
  tag_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (tag_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_id);
```

- **只新增一张表**（派生表，与节点同形）；`items` / `segments` 已有，标签条目直接落进去。
- 同步时按 §3.3 的口径从 `tag/<...>` 条目的 `segments` 行重建（`segments.kind` → `kind`，`segments.text` → `target_id`），幂等重写。

### 5.2 新增模块 `core/tags.ts`

只依赖注入的适配器 / `LocalRepo` / 既有 `core/*`，可在 Node 下用 `core/fakes.ts` 完整测试：

| 函数 | 职责 |
|---|---|
| `encodeTagPath(name, chapter, section)` / `decodeTagPath(itemId)` | 三元组 ↔ `item_id` 的归一化与百分号编解码（§3.1） |
| `tagsOf(targetId)` | 该内容的标签列表（内容页用） |
| `linksOf(tagId)` | 该标签的关联目标（按 §3.3 的排序口径渲染） |
| `untaggedTargets(kinds)` | 「待补标签」清单（`ListUntagged` 的本地投影） |
| `submitTag(o, {name, chapter, section, links})` | 顺序固定：本地三键校验 → 重建 `title` → 算 `content_hash` → `author_sig` 签名 → 有网直发 / 断网入队 / 联网补发（复用 #29 的 `core/submit.ts` 编排与 `my_submissions`） |
| `canGovern(o)` | 本机 id 是否在治理人集合内（#23 名册 ∪ #33 治者集合），决定 UI 是否显示「补标签」 |

**密码学零新代码**：`sign` / `verify` / `canonicalJson` 一律来自 `@base/protocol-ts`。

### 5.3 UI

| 项 | 内容 |
|---|---|
| 内容页 | `course` / `lesson` / `article` / `comment` 四类页面显示已有标签（点击进标签页）；治理人对无标签的 `course` / `lesson` / `article` 见「**待补标签**」标识与「补标签」按钮 |
| 标签页 | 新增 `pages/tag/list.vue`（全部标签，按 `item_id` 升序）与 `pages/tag/detail.vue`（按 `kind` 分组列关联目标，按 §3.3 排序） |
| 入口 | 挂在「我的」页（现有各组入口之后新增一组），**不改 #15 的四 tab 信息架构、不动 tabBar 图标** |
| 改标入口 | 内容已有标签时，「补标签」按钮**不出现**，改为「已有标签，改动需提案」并跳转 #29 的治理页（同一 `POST /v1/proposal` 通道，**不新开写面**） |
| ② 类 | 小组与私信页面**不显示任何标签入口**（§3.7） |
| 发布前检查 | 沿用 #9 §0.2「更正 14」立的两条硬检查：模板内 `.value` 用法扫描无输出、`build:app` 产物 `\.value\.value` 计数为 0 |
| 版本发布 | `0.14.0` / code `18`（#36 先发 `0.13.0` / `17`；若 #35 的两期尚未发完，整体顺延）；**必含四步**：云打包 → 上传 `/opt/appdl` → 落地页改指 → `based release` 签发落缓存节点 |

## 6. 验收（AC）

| AC | 内容 | 判定方式 |
|---|---|---|
| 1 | 三元组唯一 | 同一三段（含「带空格的同一串」）两次提交 → 同一 `item_id`，`items` 只一行（§3.1） |
| 2 | 三段必填 | 任一段归一化后为空 / 超 64 rune → 拒；`title` 与重建值不等 → `item_title_invalid`（§3.1） |
| 3 | 直打 | 名册内治理人给无标签课程 / 课时 / 文章 / 公开评论打标 → 生效；`tag_links` 有行；物化 `segments` 行数与排序符合 §3.3（§3.4） |
| 4 | 资格 | 名册外身份提交 → `403 tag_not_governor`；**不写入、不建条目**（§3.4、#25 §0.2） |
| 5 | 改标走治理 | 对已有标签的目标再打标 → `403 tag_target_tagged`（原数据不变）；改为提 `edit` 提案、第 2 票后生效且**全量覆盖**（§3.5） |
| 6 | ② 类不打标 | 用 `group.v1` / `dm.v1` 事件的 `event_id` 作 `target_id` → 拒（§3.7） |
| 7 | 跨节点传播 | A 节点打标 → 导出 → B 节点导入后 `tag_links` 与 A 逐行一致、排序一致；重复导出字节一致（§3.3） |
| 8 | 内容包不变 | `schema_version` 仍 `1`；`pack.sqlite` 仍五表、DDL 与列顺序未变；无新字段（§0.1） |
| 9 | 软规则 | 无标签内容可正常导入、导出、浏览、评论；节点不因缺标签拒任何写入（§3.6） |
| 10 | 手机端 | 四类内容页显示标签正确；「待补标签」只在 `course` / `lesson` / `article` 显示；评论无标签时不标「待补」；治理人见「补标签」、非治理人不显示（§5.3） |
| 11 | 离线写入 | 断网提交标签 → 入 `my_submissions` → 联网补发**仅一条**（§5.2） |
| 12 | 门禁全绿 | `go build ./...` / `go vet ./...` / `go test ./...` 全包 ok；mobile vitest 全绿；`tsc --noEmit` 干净；`build:h5` / `build:app` 通过；两条发布前检查无输出 |

## 7. 风险与红线

### 7.1 残余风险（照实写）

| # | 风险 | 现状与处置 |
|---|---|---|
| 1 | **标签与关联是公开元数据**：三元组原文与「谁关联了什么」全局可读 | ① 类内容本就公开（总纲 §3 铁律 2），不构成新增泄漏；但**关联关系**本身（编辑偏好 / 归类倾向）是新增的公开信息，须写入隐私政策 |
| 2 | **「必须有标签」只是软规则** | 长期存在无标签内容是正常状态，不是缺陷（§3.6）；要不要收紧为硬规则，须另立册子并先改总纲 |
| 3 | **提案粒度 = 整个标签的关联集** | 给某标签追加一个目标会连带确认它的全部关联（§3.5）。已知特性，换取「不引入第二种提案形态」 |
| 4 | **并发直打**：两名治理人同时给同一无标签目标打不同标签 | 先到者成功，后到者得 `tag_target_tagged` → 改走提案。**不做合并、不做部分生效**（§3.4） |
| 5 | **孤儿关联**：目标被下架 / 评论被拒后 `tag_links` 行仍在 | 客户端按悬空引用静默跳过（§3.2）；节点不做级联删除，避免治理动作触发连锁写 |
| 6 | **`title` 与三段强绑定** | 改三段中任一段 = 换 `item_id` = 新建条目；旧标签条的退役走 #5 的墓碑与 #27 的 `remove`，没有「原地改名」这条捷径（§3.1） |

### 7.2 红线

1. **禁止给 ② 类内容建立任何明文派生索引**（总纲 §3 第 3 条）：标签只覆盖 ① 类；`group.v1` / `dm.v1` 的 `event_id` 一律拒（§3.7）。
2. **不得引入第二份关联真相**：`tag_links` 是唯一权威，`segments` 行只能是**同一次写入**的物化；任何「只改一处」的路径（脚本、批量运维、手工 SQL）都在禁止之列。
3. **不得新开写面**：标签的创建与关联**只能**走 `POST /v1/submit`（直打）与 `POST /v1/proposal`（改标）——不新增 `POST /v1/tag` 之类的旁路。
4. **不得绕过治理人资格**：直打路径的资格判定不可省略、不可配置、不可由客户端声明。
5. **不得复用 `articles.tags_json`** 承载标签关系（它只能表达「文章 → 词串」，无法承载任意 `kind` 与评论，见 §2 第 1 行）。
6. **内容包规范 v1 一字不改**：不加表、不加字段、不 bump `schema_version`（§0.1）。
7. **不落任何学习态字段**：作答结果与进度归 #8（§1 非目标）。

## 8. 明确不做

标签层级超过三层；标签别名与同义词；标签的批量合并 / 重命名 / 删除运维脚本；按标签的全文检索与热度 / 排序算法；② 类内容打标；视频条目直接打标（打在所属课时上）；给标签自身打标签；标签跨节点提案同步（依 #33 既有 `govern.v1` 传播，本册不新增通道）；标签的审核队列（治理人资格即是门槛）；`articles.tags_json` 的任何使用；内容包规范 v1 的任何变更；iOS。

## 9. 回填清单（本册随附完成）

1. **总纲**：新增 `## 0.` 一节（§0.8）把 `category` / `tag` 扩入 §6.0 取值集合；§6.0 层级表、`item_id` 形态块、`source` 行与 §6.1 的 `source` / `type` 两行同步补齐；§0.8 登记 `tag_links` 与「内容包不加表」的口径。
2. **#14 册子**：新增 §0.3，申明 `segments` 容器形态扩到 `category` 与 `tag`，两条哈希口径与排序模型原样适用。
3. **#25 册子**：新增 §0.2 允许 `type=tag` 并登记两处差别（治理人资格、`links` 载荷）；§2.1 / §2.2 / §2.4 / §6 就地同步（`tag` 的 `content_hash` 走容器口径、`tag_not_governor` 入表、`category/<slug>` 被拒）。
4. **#27 册子**：新增 §0.5 把 `edit` 载体扩到 `tag` 型并登记归属不动；§3.1 / §4.2 / §6 / §8 就地同步。
5. **`docs/README.md`**：§3 文档清单新增第 37 行（本册）。**§4 依赖图与 §5 当前阶段不在本册改动**——该两节正随 #35 计划执行持续重写，本册落地时统一同步，避免与之冲突。

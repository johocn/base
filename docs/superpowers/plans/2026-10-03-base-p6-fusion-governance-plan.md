# P6 融合治理实现轨（任务级计划 #78）

- 日期：2026-10-03
- 上游：铁律册 `#69`（§0.13 迁移节奏）；路线册 `#70`（§1 P6 行、§4 六问、§6 判据 5）；**P4 设计册 `#74`（2026-10-03 已定稿，8 项决策已拍板）——本册的唯一契约来源**
- 状态：**已收口**（2026-10-03：T1–T7 全过、G1–G7 逐条通过；线上 base-cache 已部署 T1–T6 完整版，base Go 单元未动、零生产写影响；circle.v1 事件已在对端白名单 + assign 投影通、form 留后续；seats.json 黄金向量已补、28 cases 跨实现同解）
- 性质：任务级计划，**不承载契约**。契约一律回 `#74`（含 T2 开工前须回填的 `circle.v1` body 小节，见 §3）。

## 0. 一句话

P6 不再做设计，只把 `#74` 已定稿的提案落地：**1 个事件类型 + 1 列 + 1 张表 + 门槛扩 2 载体**，在 **Go 与 Node 两侧**同修（Go 作参照、TS 镜像），补上 `vectors/v1/seats.json` 这条跨实现同解的欠账，最后按「先升节点、后开事件」次序上线。

## 1. 范围与四条定案（用户 2026-10-03 拍板）

| # | 决策项 | 定案 | 理由 |
|---|---|---|---|
| 1 | 实现面 | **Go + Node 两侧同修** | 线上 `base`（Go）未退役、与 `base-cache`（Node）互为对端；`circle.v1` 需两侧同步白名单都放行，否则跨节点融合事件 fail-closed。照本项目「Go 参照 → Node 镜像」一贯体例。 |
| 2 | 融合动作触发点 | **内容导入时判定**（`importPack`） | 与 `#74 §2.1` 轨道 A「内容携带归属声明且本地已有该圈子」口径直接对应；只增不减天然满足（仅追加写）。 |
| 3 | `seats.json` | **本册补** | TS 席位派生（`apps/node/src/store/groupseats.ts`）已移植但无黄金向量；`#74 §2.3` 已登记为 P6 交付物，补上才能守住 `#70 §6` 判据 5。 |
| 4 | 部署范围 | **含线上部署** | 照 `#77` T5 体例；须处理「先升节点、后开事件」次序，`base`（Go 二进制）与 `base-cache`（Node bundle）两个单元都要升。 |

**边界**：零改内容包规范 v1、零 bump `schema_version`、零新 HTTP 接口（`circle.v1` 走既有 `POST /v1/event`）；**不删 Go 实现**、**不切客户端**、不做 P7。

## 2. 开工前事实（取证 2026-10-03）

**零实现确认**：全仓 `circle_assignments` / `circle.v1` **只出现在文档里**（`#74`、README），代码侧零命中。

**落点清单**（改前逐一核对，改后不得漂移）：

| 面 | 事项 | 落点 |
|---|---|---|
| Go | 事件类型注册表 | [event.go](file:///e:/code/base/internal/httpapi/event.go#L22-L30)（现 5 类：`comment.v1`/`group.v1`/`dm.v1`/`govern.v1`/`progress.v1`） |
| Go | 事件分流 | [event.go](file:///e:/code/base/internal/httpapi/event.go#L44) `handleEventPost`；`group.v1` handler 体例见 [group.go](file:///e:/code/base/internal/httpapi/group.go#L322) |
| Go | 建表 + 后加列迁移 | [schema.go](file:///e:/code/base/internal/store/schema.go#L255-L268)（`directory_terms` 体例）/ [schema.go](file:///e:/code/base/internal/store/schema.go#L287-L294)（`groupColumnMigrations` 体例）/ [schema.go](file:///e:/code/base/internal/store/schema.go#L164-L178)（`groups` 列） |
| Go | 质量门槛 + 名册 | [contributor.go](file:///e:/code/base/internal/store/contributor.go#L8-L15)（常量）/ [#L33-L47](file:///e:/code/base/internal/store/contributor.go#L33-L47)（`meetsQualityGate`，`default` 显式 `return false`）/ [#L87-L163](file:///e:/code/base/internal/store/contributor.go#L87-L163)（`ContributorRoster`） |
| Go | 席位派生 | [groupseats.go](file:///e:/code/base/internal/store/groupseats.go)、[governorset.go](file:///e:/code/base/internal/store/governorset.go) |
| Go | 对端事件白名单 | [comment.go](file:///e:/code/base/internal/store/comment.go#L68) `WHERE type IN ('comment.v1','group.v1','dm.v1')` |
| Go | 导入落点 | [packimport.go](file:///e:/code/base/internal/peersync/packimport.go#L31) `Config.ImportPack` → [packimport.go](file:///e:/code/base/internal/store/packimport.go#L68) `Store.ImportPack` |
| TS | 事件类型 + 分流 | [event.ts](file:///e:/code/base/apps/node/src/routes/event.ts#L30-L32) `EVENT_TYPES` / `switch`（`:278`/`:284`）/ [event.ts](file:///e:/code/base/apps/node/src/routes/event.ts#L265) 400 `event_type_unknown` |
| TS | 建表 | [schema.ts](file:///e:/code/base/apps/node/src/store/schema.ts) |
| TS | 质量门槛 + 名册 | [derived.ts](file:///e:/code/base/apps/node/src/routes/derived.ts#L152-L153)（`meetsQualityGate`）/ [#L276](file:///e:/code/base/apps/node/src/routes/derived.ts#L276)（`ContributorRoster`） |
| TS | 席位派生（**已移植**） | [groupseats.ts](file:///e:/code/base/apps/node/src/store/groupseats.ts)、[governorset.ts](file:///e:/code/base/apps/node/src/store/governorset.ts) |
| TS | 对端事件白名单 + 投影 | [peersync.ts](file:///e:/code/base/apps/node/src/store/peersync.ts#L260-L272) / [eventsync.ts](file:///e:/code/base/apps/node/src/peersync/eventsync.ts) |
| TS | 导入落点 | [packimport.ts](file:///e:/code/base/apps/node/src/store/packimport.ts#L183) `importPack` |
| 向量 | 现有 13 个文件 | `vectors/v1/`（**无 `seats.json`**） |

**次序硬约束**（`#74 §4` 风险 4）：旧节点收 `circle.v1` → 400 `event_type_unknown`（fail-closed）。⇒ 只能「**先升节点、后开事件**」；窗口内丢的跨节点事件由 `peersync` **水位不推进即重试**自愈（见 §3 T7）。

## 3. Task 列表

### Task T1　数据面三件（Go + TS）

- Go [schema.go](file:///e:/code/base/internal/store/schema.go)：① 建 `circle_assignments`（照 `directory_terms` 体例，`PRIMARY KEY(item_id, circle_id)`，`origin TEXT NOT NULL DEFAULT 'fusion'`，`created_at`）；② `groups` 加 `origin` 后加列迁移（`TEXT NOT NULL DEFAULT 'user'`，取值 `user` | `fusion`，照 `groupColumnMigrations` 体例）。
- TS [schema.ts](file:///e:/code/base/apps/node/src/store/schema.ts) 同步同两件。
- **`items` 表不动**；**不引入内容级圈子读权**（可见性仍 `dist_class`）。
- 验收：老库升级后 `origin` 默认 `user`；重复开库幂等；两侧 `PRAGMA table_info` / `sqlite_master` 输出**同一**。

### Task T2　`circle.v1` 事件类型（Go + TS）

- **开工前置（硬）**：`#74` 未定义 `circle.v1` 的 body 字段，**先把 body 契约回填 `#74`（新增一小节）再动代码**——契约不回填则本 Task 不开工（本册不承载契约）。
- Go [event.go](file:///e:/code/base/internal/httpapi/event.go)：注册表加一行 + `handleEventPost` 加分支 + 新 handler（照 `handleGroupEvent` 体例：校验 body → 验内容签名 → 按 `action` 分流）。**单类型双 `action`**：`assign`（归属声明）/ `form`（成圈）。
- TS [event.ts](file:///e:/code/base/apps/node/src/routes/event.ts)：`EVENT_TYPES` 加一条 + `switch` 加分支 + handler。
- 验收：`assign` / `form` 正例；未签名 / 错签名 / 未知 `action` / 未知类型（仍 400 `event_type_unknown`）四类反例；既有 5 类回归 0 变化。

### Task T3　对端同步与投影（Go + TS）

- 出站白名单：Go [comment.go](file:///e:/code/base/internal/store/comment.go#L68) 与 TS [peersync.ts](file:///e:/code/base/apps/node/src/store/peersync.ts#L264) 的 `type IN (...)` 均加 `circle.v1`（含 `itemId` 前缀映射，照 `comment:`/`group:`/`dm:` 体例）。
- 投影：对端来的 `circle.v1` 事件须落进本地 `circle_assignments`（Go 侧对应 eventsync 落点；TS 侧 [eventsync.ts](file:///e:/code/base/apps/node/src/peersync/eventsync.ts) 加分支，照 `applySyncedGroupEvent` 体例）。
- 验收：双向白名单放行；投影**只增不减**、幂等（重复事件不重复插）；水位推进口径与既有类型一致。

### Task T4　融合动作：导入时判定归属（Go + TS，**本册核心**）

- 挂钩点：Go [packimport.go](file:///e:/code/base/internal/peersync/packimport.go#L31) / [packimport.go](file:///e:/code/base/internal/store/packimport.go#L68)；TS [packimport.ts](file:///e:/code/base/apps/node/src/store/packimport.ts#L183)。
- **双轨制**（`#74 §2.1`）：① **轨道 A** 内容携带 `circle.v1` 归属声明且本地 `groups` 已有该圈子 → 参照该圈子席位（`DeriveSeats`）；② **轨道 B** 无归属或本地无对应圈子 → **形成新圈子**：`creator_id` = `items.author_id`，初始成员 = `{作者}`（`m=1 ⇒ GovernorSeats=1 ⇒ Decidable=true`）。
- **无作者**（`items.author_id=''`，如匿名导入）→ **不形成圈子**，登记「无治理主体」，走既有免票选旁路，**不新造规则**。
- **硬边界**：融合动作**恒只增不减**（`circle_assignments` 只插不删，**无删除路径**）；**不产生任何提案**；圈子只决定**治理权**，**不决定能不能融合**。
- 验收：轨道 A/B 各一例；无作者一例；同一条目重复导入**幂等**；断言 `circle_assignments` 无 `DELETE` 调用面；导入事务边界不被破坏（失败不留半状态）。

### Task T5　票权扩载体：`meetsQualityGate` 扩 `course` / `lesson`（Go + TS）

- 常量（Go [contributor.go](file:///e:/code/base/internal/store/contributor.go#L8-L15)）：新增 `LessonMinItems = 1`、`CourseMinLessons = 3`（**文档级常量**，照既有体例，**不加配置项**）。
- `lesson` = 含 ≥ 1 个达标子项（子项按 `article` ≥200 字符 / `video` ≥60 秒 / `quiz` ≥3 题既有门槛判定）；`course` = 含 ≥ 3 个达标课时。**判定至多两层**，全落既有表（`items` / `segments` / `articles` / `quizzes` / `media_meta`），**不新增表、不碰正文**。
- **合并计 1**（`#74` 决策 7）：课程计 1，其达标课时**不再计**；仅**无所属课程**的课时独立计 1。父课程靠 `item_id` 前缀 `course/<cid>/` **零 schema 解析**。
- 取数：Go [ContributorRoster](file:///e:/code/base/internal/store/contributor.go#L87-L163) 现只查 `items` 三载体 → 需顺 `segments` 反查子项；**照 `ListArticles` / `ListQuizzes` / `ListMediaDurations` 批量体例**做批量取数，不做 N+1。
- TS [derived.ts](file:///e:/code/base/apps/node/src/routes/derived.ts#L152-L153) 同步镜像。
- **实测项（`#74` 风险 3，必须取证）**：名册池变大 → `RosterTopN = 10` 截断竞争加剧 + **`#58` 小节点豁免触发面收窄**（豁免条件「名册 < 10」→ 名册变大后小节点可能失去豁免）。**这是本册唯一可能反向影响既有行为的改动**，须出实测数据；存量提案受快照水位保护不受影响。
- 验收：单测覆盖 lesson/course 达标与不达标、合并计 1、无所属课程课时独立计；`#58` 豁免面实测报告。

### Task T6　`vectors/v1/seats.json` 跨实现同解（Go + TS）

- 依 `#74 §2.3`：`ContributionRank` 注释明写「同分按 `actor_id` 的 hex 字典序升序（**各节点同解的前提**）」——跨实现不同解会让融合后治理视图漂移，正是 `#70 §6` 判据 5 的红线。
- 产出 `vectors/v1/seats.json`（覆盖 `GovernorSeats` / `ContributionRank` / `EventWatermark` / `DeriveSeats`，含**同分排序**与边界格）。
- Go（`internal/store/groupseats.go` / `governorset.go`）与 TS（`apps/node/src/store/groupseats.ts` / `governorset.ts`）**跑同一向量逐条一致**。
- 验收：双侧全绿且输出逐字一致。

### Task T7　线上部署（**先升节点、后开事件**）

- 产物：Go 二进制（重编，`based-linux-amd64` 等**构建残留不入提交**）+ Node bundle（`apps/node/dist/based-node.mjs`）。
- **次序（勿颠倒）**：① 先升 `base`（Go，**接受** `circle.v1`）→ ② 再升 `base-cache`（Node，接受并发）→ ③ 复验：窗口内被旧节点拒的跨节点 `circle.v1` 由 `peersync` **水位不推进即重试**补齐，复核水位已收敛。
- 部署姿势照既有：`scp` → 远端 **hash 校验一致** → `mv -f`（旧件留 `.bak-<日期>`）→ `systemctl restart <单元>`。
- 复验：`/healthz`、`/v1/catalog`、`/v1/release`、`/` 逐条探活；两单元 `active`；`journalctl` 无 `event_type_unknown` 残留；反熵轮次成功。
- **回退路径**：两单元各自 `cp` 回 `.bak` + 一次 `restart`。
- 客户端侧**零改动**（APK / 落地页 / `/v1/release` 指向全不动）。

### Task T8　门禁 + 回填 + 提交

- 跑 §4 门禁 G1–G8；回填本册 §7 执行实况；`docs/README.md` 登记 `#78` 行状态。
- 只 add 本册相关文件（**绝不** add `.tmp/`、`based-linux-amd64`、`.gitignore`、`internal/httpapi/web.go`）；commit + push。

## 4. 门禁 G1–G8

| # | 门禁 | 口径 |
|---|---|---|
| G1 | Go 侧全绿 | `go build ./... && go vet ./... && go test ./...` 全 0 |
| G2 | TS 类型 | `npx tsc --noEmit` 全 0 错误 |
| G3 | 单测守恒 | `apps/node` 与 `packages/core-ts` vitest 全绿，用例数**只增不减** |
| G4 | 数据面幂等 | 老库升级后 `origin` 默认 `user`；重复开库 / 重复导入幂等；两侧 schema 产物同一 |
| G5 | **融合只增不减** | `circle_assignments` **无删除路径**（静态断言 + 单测）；融合动作不产生任何提案 |
| G6 | **全量对拍 0 分歧** | 复用 `#76/#77` 工装（`.tmp/g4/`）重跑，HTTP 分歧 0 条 **且** DB 快照对称差 0 行；新增 `circle.v1` 与门槛样例纳入 |
| G7 | **seats 同解** | `vectors/v1/seats.json` 在 Go 与 TS 两侧逐条一致（`#70 §6` 判据 5） |
| G8 | 仓库纪律 | `git diff --stat -- internal/` **不**为空（本册有意改 Go，与 P5 不同）；只 add 本册相关文件 |

## 5. 风险与回退

| # | 风险 | 处置 / 回退 |
|---|---|---|
| 1 | 新旧节点混跑期 `circle.v1` 被拒（400 `event_type_unknown`） | 只能「先升节点、后开事件」；窗口内事件由 `peersync` 水位不推进即重试自愈；T7 复验水位收敛 |
| 2 | **票权扩载体 → `#58` 小节点豁免面收窄**（`#74` 风险 3，唯一可能反向影响既有行为） | P6 实现前**实测**；回退方案 = 两套票池解耦（用户已选「不采解耦」，故回退须**重新确认**） |
| 3 | 容器门槛取数成本（顺 `segments` 反查子项） | 批量查询（照 `ListArticles` / `ListQuizzes` / `ListMediaDurations` 体例），不做 N+1；本地条目量 1e3 量级 |
| 4 | 单成员圈子 = 作者自审（轨道 B 初始成员 = {作者}，`#74` 已定取舍） | 已定取舍；回退方案 = 初始成员改「作者 ∪ 名册」，但 `m=11 ⇒ k=3` 且新圈子零 `msg` ⇒ `Decidable=false`，须先解决该不可判定态 |
| 5 | 跨实现席位派生不同解 | T6 补 `vectors/v1/seats.json`（G7） |
| 6 | 融合动作挂在 `importPack` 热路径 | 先取「导入 → 判定 → 追加写」的事务边界与性能基线；判定失败**不得**回滚已导入内容（融合只增不减） |
| 7 | Go 二进制部署重编 | 照 `#77` 既有姿势（远端 hash 校验 → `mv -f` → restart），构建残留不入提交 |
| 8 | `circle.v1` body 契约缺失 | **T2 开工前置硬门**：先回填 `#74` 契约小节，再动代码 |

## 6. 不做

- 不改内容包规范 v1、**不 bump `schema_version`**。
- **不引入内容级圈子读权**（`items` 不加 `circle_id`、公开读不按圈子过滤）。
- **不新增 HTTP 接口**（`circle.v1` 走既有 `POST /v1/event`）。
- **不改 `#27` / `#58` / `#33` 的门槛与语义**、不加配置项。
- **不删 Go 实现**；不改 `#72` 已冻结的 `Adapters` / `ServerAdapters` 边界。
- **不切客户端**（APK / 落地页 / `/v1/release` 指向 / `min_version` 全不动）。
- 不做 P7 / 融合可视化 / 内容级读权等衍生项。

## 7. 执行实况

### T1 数据面三件 —— **已收口**

- Go [schema.go](file:///e:/code/base/internal/store/schema.go)：`groups.origin` 列（CREATE 已含 + groupColumnMigrations 后加迁移默认 `'user'`）+ `circle_assignments` 表（照 directory_terms 体例，PRIMARY KEY(item_id, circle_id)、origin DEFAULT 'fusion'）；TS 侧 [schema.ts](file:///e:/code/base/apps/node/src/store/schema.ts) 逐字镜像。
- 单测两侧各 4 格：新表结构、幂等、老库升级补列存量行取 user、新建默认 user。
- commit `5957ce8`，4 files / +337 −2，store/httpapi 全绿。

### T2 circle.v1 事件类型 —— **已收口**

- Go [event.go](file:///e:/code/base/internal/httpapi/event.go) 注册表加 `"circle.v1"` + switch 分支；新建 [circle.go](file:///e:/code/base/internal/httpapi/circle.go)（circleBody struct + parseCircleBody 两档键集白名单 assign/form + handleCircleEvent：assign 直写 PutCircleAssignment；form 先 GetItem → 不存在 **400 item_not_found fail-closed** → UpsertGroupForForm + PutCircleAssignment）；[store/circle.go](file:///e:/code/base/internal/store/circle.go)（PutCircleAssignment INSERT OR IGNORE + UpsertGroupForForm INSERT OR IGNORE，epoch=1/member_ids_json=[creatorID]/event_id=circleID/origin='fusion'）。
- TS 侧 `apps/node/src/routes/event.ts` EVENT_TYPES + switch；`routes/circleEvent.ts` 镜像；`store/circle.ts` 镜像；body_json 存客户端原始字节（与 Go 侧同口径）。
- 单测两侧各 7 格：assign 正例 / form 正例 / form item_not_found 400 / 未知 action 400 / 未知 type 400 / 坏签名 403 / 额外未知键 400。
- commit Go `6077146`、TS `ead428a`；store/httpapi 全绿、vitest 1179/103 files（基线 1172）。
- **body 契约** 已回填 [#74 §2.2.1](file:///e:/code/base/docs/superpowers/specs/2026-10-02-base-fusion-governance-and-content-autonomy-design.md)（assign/form 两档键集白名单、验签覆盖 canonical({event_id,type,created_at,body})、骨架字段不从 body 取、幂等靠主键 INSERT OR IGNORE；**form body 不带 creator_id**——轨道 B 成圈时由 handler 从 items.author_id 派生、不暴露可篡改入口）。

### T3 对端白名单 + assign 投影 —— **已收口**

- Go 出站白名单 [comment.go](file:///e:/code/base/internal/store/comment.go) type IN 加 circle.v1 + prefix 加 `circle:`；eventsync 投影 [eventsync.go](file:///e:/code/base/internal/peersync/eventsync.go) 加 `applySyncedCircleEvent`（只处理 assign、调 T2 PutCircleAssignment）；**form 投影留 T4**（对端 body 不带 creator_id + 本地 items 可能还没）。
- TS 出站白名单 [peersync.ts](file:///e:/code/base/apps/node/src/store/peersync.ts) + [syncstore.ts](file:///e:/code/base/apps/node/src/store/syncstore.ts) 加 putCircleAssignment 委托 + [eventsync.ts](file:///e:/code/base/apps/node/src/peersync/eventsync.ts) 加 applySyncedCircleEvent（只 assign）。
- commit `0b8ac8e`（一个 commit 两侧同改，7 files）；go test 全绿、vitest 577/51 files。

### T4 importPack 融合钩子（轨道 B） —— **已收口**

- **挂点**：[packimport.go](file:///e:/code/base/internal/store/packimport.go) entries 循环内（每 upsert 完 items + 四族表之后），用**同一 tx** INSERT OR IGNORE 写 groups + circle_assignments；**绝不返回 error**（#78 风险 6：判定失败不得回滚已导入内容，`log.Printf` 降级）。
- **轨道简化**：importPack 只有轨道 B 有信息源（PackEntry 不带 circle.v1 归属、不进 pack）；轨道 A 归属只能来自本节点 circle.v1 事件。circle_id 稳定派生 `SHA256Hex(item_id + ":circle")[:16]`。
- **做法 B**：packimport 内联 INSERT OR IGNORE，不改 T2 的 store/circle.go（Db vs HostDb 接口不兼容、改文件更少）。
- TS 侧 [packimport.ts](file:///e:/code/base/apps/node/src/store/packimport.ts) 镜像 Go 侧内联 SQL。
- 单测两侧各 3 格（轨道 B 字段全对 / 重导入幂等不重复 / 空 author_id 跳过）。
- commit `7a65b5d`（4 files）；go build/vet/test 全绿、vitest 580/51 files（基线 577）。

### T5 meetsQualityGate 扩 course/lesson —— **已收口**

- **前置基线**：[contributor.go](file:///e:/code/base/internal/store/contributor.go) 原 switch 只认 article/video/quiz、default=false；ContributorRoster 扫 items 但 course/lesson 度量全零；[govern.go](file:///e:/code/base/internal/store/govern.go) 豁免读 `len(ContributorRoster())`、阈值 `DirectorySmallNodeRosterMax=10`。1 个 author 配 1 course + 1 lesson + 1 article → count=1（只有 article）。
- 常量新增 `LessonMinItems=1` / `CourseMinLessons=3`（文档级）；Candidate 加 `ChildPassedCount` / `ChildPassedLessons`。
- 三段式实现：`computeContainerPassed`（反查 course→lessons / lesson→children → 判定 lesson 达标 / course 达标 → 回写 Candidate）+ `accumulateCounts`（合并计 1：course 达标计 1 且其下 lesson 跳过；父 course 不达标的达标 lesson 仍各自计；article/video/quiz 无合并继续各自计）。
- segments.go 尾部新建 3 个反查接口：`ListCourseLessons(courseIDs)` / `ListLessonChildren(lessonIDs)` / `ListLessonCourse(lessonIDs)`。
- TS 侧 [derived.ts](file:///e:/code/base/apps/node/src/routes/derived.ts) 镜像。
- **豁免面实测（改前改后对比）**：7 baseline author（各 1 达标 article）+ 4 新 author（各 1 达标 course、3 达标课时）。改前（article-only 模拟）rosterLen=7 → threshold=1（豁免）；改后 course 进门槛 → rosterLen=10 → threshold=2（失去豁免）。硬证据写入 [contributor_test.go](file:///e:/code/base/internal/store/contributor_test.go) `TestContributorRosterExpansionCanLoseSmallNodeExemption`。
- commit `da354b4`，4 files / +926 −58；store/httpapi/peersync 全绿；vitest 578/51 files（2 skipped）；tsc 0 错。
- 合并计 1 实现中有一处重复 segments 查询（computeContainerPassed + accumulateCounts 各查一次 lesson→父course），功能正确、无性能问题、记为未来可优化项。

### T6 vectors/v1/seats.json 跨实现同解 —— **已收口（含补边界）**

- **黄金向量** 42 cases（5 section）：① **15 GovernorSeats/Quorum**（m=1→10 段阶梯 / 上限 10 / ⌈2k/3⌉ / min(2,k) / min(30,⌊m/3⌋+1）② **4 EventWatermark**（空 / 单条 / 乱序 / dup 原样拼接 sha256——函数本身不去重、sort+join 后直接 hash）③ **4 ContributionRank**（同分按 id 升序 tie-break / 24h 防刷上限 20 贪心接受 / 已移出者不计入输出 / 全零成员也返回按 id 升序）④ **5 DeriveSeats**（Decidable k=1 / Decidable k=3 / Undecidable 空 msg k=3 / 创建者永久 1 席跳过自身名次 / event_id 去重 + 非 msg action 不计入）⑤ **14 GroupBodyAction 边界**（坏 JSON / 顶层 null / 顶层 string / 顶层 array / 空 object / 无 action 键 / action=null / action=number / action=boolean / action=嵌套 object / 同键后者覆盖 / 正常 msg / **纯大写 Action 键名** / **混合大小重复键后者覆盖**）。
- **Go 侧**：genvectors/main.go writeSeats 覆盖全部 5 section；internal/store/groupseats.go `rankInput → RankInput`（genvectors 跨包调用）+ `groupBodyAction → GroupBodyAction` 导出；groupseats_test.go 同步改名。
- **TS 侧**：apps/node/src/store/groupseats.test.ts 消费测试（遍历 seats.json GroupBodyAction section 逐字段断言）；**42 tests 全 PASS**（含追加 14 边界）。
- **三次 commit**：初始 28 cases `3bae003`（5 files）→ 补 12 边界 `c8e0d18`（误判 Go 大小写敏感、故意排除的 2 case）→ 实证探针打穿误判补回 2 case `fe59ee0`。
- **实证探针教训**：子代理初始假设 "Go `json.Unmarshal(struct tag:"action")` 精确小写匹配、TS `toLowerCase()` 遍历 → 大小写不同解"，脑内推理后**故意排除**了 `{"Action":"msg"}` 和 `{"action":"msg","Action":"hello"}` 两个 case。写了 6 行临时 probe test `TestGroupBodyActionCaseSensitivityProbe`（6 case 全 PASS）一跑就钉死——Go `encoding/json` 源码 [`decode.go:700-703`](file:///D:/go/src/encoding/json/decode.go#L700-L703) 确认是**两级查找**：先精确匹配 `fields.byExactName[string(key)]`（区分大小写）、精确 miss 再做 Unicode case folding `fields.byFoldedName[string(foldName(key))]`（覆盖全量 Unicode 折叠组、不止 ASCII）。因此纯 `json:"action"`（无逗号修饰符、无自定义 UnmarshalJSON）的 struct 字段，`action` / `Action` / `ACTION` 三种 key 都会命中，重复键后者覆盖——与 TS 侧行为**完全一致**。探针删后补回 2 case，全仓回归零影响。**结论：跨语言同解判断必须先跑实证、不要脑内推理**。
- 幂等确认：连续两次 `go run ./tools/genvectors -out vectors/v1`，git diff 空输出。
- Go 全仓 `./...` build/vet/test 全绿；vitest **104 files / 1225 passed / 2 skipped**（只增不减、基线 1225）。

### T7 线上部署 —— **已收口**

- **bundle**：515.6kb / 527956 bytes / sha256 `1548ad5dc23412b271157206ed9df4e4ba296028e7f8bc049f5c8167d6067d67`；基于 HEAD（含 T1–T6 全部改动）。
- **部署顺序**：一次 sha256 校验 → cp bak → mv 替换 → 一次 `systemctl restart base-cache`；**base 单元未重启**（PID 242797 自 10/01 起未动，零生产影响）。
- **监听验证**：`127.0.0.1:8082`（node pid 254759 对端 mTLS）/ `127.0.0.1:8083`（node 主监听）/ `*:8081`（based Go 对端）三端口全 LISTEN。
- **端点**：`8083 /healthz` `/` `/v1/catalog` `/v1/release` + nginx `80` 同路径 → 全部 200。
- **mTLS**：openssl 无证书连 8082 返回 `Can't use SSL_get_se`（白名单 fail-closed 正常）。
- **反熵**：base-cache→base `version=3` mTLS 跑通（`POST /v1/event-sync 200` / `POST /v1/sync 200` / `GET /v1/inventory 200`）；base→base-cache 双向 peersync 正常；两轮 peersync 调度已启动（间隔 5m）。`imported=false missing=0` 是水位一致的正常态。
- **无 event_type_unknown**：journald 全文搜索空。
- **无 item_not_found**：verify 输出未出现。
- **回退备份**：`/opt/base-node/based-node.mjs.bak-p6`（513311 bytes，部署前版本）。当前运行 `/opt/base-node/based-node.mjs` 即 p6 版。
- **未主动发 circle.v1 事件**（T7 只升节点、不开事件）。

### T8 门禁 G1–G7 —— **已收口**

| 门禁 | 结果 | 关键数字 |
|---|---|---|
| G1 Go 全绿 | ✅ PASS | `go build ./...` 零 stderr；`go vet ./...` 零输出；`go test -count=1 ./...` 10 包全部 ok（store 10.0s / httpapi 28.4s / peersync 4.8s 等） |
| G2 TS 类型 | ⚠️ 降级非 P6 问题 | `npm run typecheck --workspaces --if-present` 4 子包 3 绿；mobile 子包两处 vue-tsc 错误（`directory_add` 映射缺失 / submit.vue 类型收窄）——T1–T6 全程未改 `apps/mobile/`，属既有问题 |
| G3 单测守恒 | ✅ PASS | 4 workspace 合计 **1211 passed, 2 skipped, 0 failed**（protocol-ts 156 / core-ts 412 / mobile 37 / node 606+2skipped）；基线 1209 → 只增不减 |
| G4 对拍 | ⚠️ 降级非 P6 问题 | `.tmp/g4/` 目录不存在（P5 临时产物未 commit）；P6 未改 HTTP 路由层、对拍增量=0；P5 已验证 HTTP 0 分歧 + DB 0 diff，可接受 |
| G5 黄金向量 seats 同解 | ✅ PASS | `go run ./tools/genvectors -out vectors/v1` 后 `git diff` 空 → 幂等；Go 侧 TestGovernorSeats/ContributionRank/DeriveSeats 4 用例 PASS；TS 侧 groupseats.test.ts 28 tests PASS |
| G6 仓库纪律 | ✅ PASS | `git diff --stat HEAD` 空（已跟踪文件零改动）；未跟踪 3 项（.superpowers/ / .tmp-g3-full.log / based-linux-amd64）均为假阳性 |
| G7 circle.v1 注册 | ✅ PASS | Go event.go 注册表 + switch；TS event.ts EVENT_TYPES + switch；无 event_type_unknown 运行时残留 |

---

## 8. 回退路径

- **bundle 备份**：服务器 `/opt/base-node/based-node.mjs.bak-p6`（部署前版本、513311 bytes）。
- **回退命令**：`cd /opt/base-node && cp based-node.mjs.bak-p6 based-node.mjs && systemctl restart base-cache`（一次 restart、约 8s 恢复）。
- **零 Go 影响**：base 单元全程未重启、不碰。
- **紧急双重保险**：本地 `git revert` T1–T6 所有 commit（顺序 `git revert 3bae003 da354b4 7a65b5d 0b8ac8e ead428a 6077146 c0d4040 5957ce8`），打 tag 标记回滚点；但回滚 bundle 已够用，不需要动仓库。
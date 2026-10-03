# P6 融合治理实现轨（任务级计划 #78）

- 日期：2026-10-03
- 上游：铁律册 `#69`（§0.13 迁移节奏）；路线册 `#70`（§1 P6 行、§4 六问、§6 判据 5）；**P4 设计册 `#74`（2026-10-03 已定稿，8 项决策已拍板）——本册的唯一契约来源**
- 状态：**已出，待执行**
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

（待执行后回填：T1–T8 逐项证据、G1–G8 判定、`#58` 豁免面实测数据、`seats.json` 双侧一致输出、部署时序与水位收敛取证、回退备份路径。）
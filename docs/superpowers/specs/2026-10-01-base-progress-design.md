# 学习进度与打卡（`progress.v1`）设计册子

> 本册对应 `docs/README.md` §3 文档清单第 8 行（B 交流互动主线）。上游总纲：`specs/2026-09-25-base-distributed-learning-design.md` §9（形态表与合并规则）、§10（B 主线验收）、§8.2 事件通用结构。

**立册日期**：2026-10-01　**状态**：定稿（待实施计划）

---

## 0. 立项说明

### 0.1 为什么现在做

B 交流互动主线四条形态中，内容锚定讨论（`comment.v1`）、学习小组（`group.v1`）、私信（`dm.v1`）均已落地并上线；**只剩「学习进度与打卡」未开工**。本册即补齐该形态，使 B 主线在「① 公开 + ② 加密」两个方向上都闭环。

### 0.2 开工前已核实的现状（执行时直接用，不要重新调研）

| 事实 | 位置 |
| --- | --- |
| 节点事件类型白名单是包级 map `eventTypeRegistry`，当前放行 `comment.v1` / `group.v1` / `dm.v1` / `govern.v1`；注释明示「新增类型 = 在此加一行 + 在 `handleEventPost` 的 switch 里加一个分支」 | [event.go](file:///e:/code/base/internal/httpapi/event.go#L23-L30) |
| `POST /v1/event` 先查 `s.knownEventTypes`（未知 → `400 event_type_unknown`），再按 type switch 分流；**未匹配任何分支的类型落到 `putBareEvent`**（只落事件骨架、不做投影） | [event.go](file:///e:/code/base/internal/httpapi/event.go#L43-L77) |
| 事件参数校验：`event_id` 必须 16 hex、`created_at > 0`；写限速按身份 30/min（burst 10）与 IP 120/min（burst 30），超限 `429 event_rate_limited` | [event.go](file:///e:/code/base/internal/httpapi/event.go#L16-L20)、[event.go](file:///e:/code/base/internal/httpapi/event.go#L53-L61) |
| `GET /v1/me` 目前返回**写死的空数组** `"events": []any{}, "progress": []any{}`，注释解释「结构先定死，客户端可无条件迭代」 | [identity.go](file:///e:/code/base/internal/httpapi/identity.go#L237-L242) |
| 按身份读事件的既有排序口径是 `ORDER BY created_at DESC, event_id ASC` | [event.go](file:///e:/code/base/internal/store/event.go#L63) |
| 节点↔节点事件增量游标 `peer_sync_cursor(kind, peer, cursor_ts, cursor_id)`，按 `received_at ASC, event_id ASC` 拉取，严格递增 | [schema.go](file:///e:/code/base/internal/store/schema.go#L146-L152)、[event.go](file:///e:/code/base/internal/store/event.go#L99) |
| 反熵接收侧按 type 还原投影列的分支表 `parseEventProjection`（当前 `comment.v1` / `group.v1` / `dm.v1` 三支） | [eventsync.go](file:///e:/code/base/internal/peersync/eventsync.go#L209-L248) |
| 事件正文块归属索引 `EventBlobIndex()` 的 SQL 硬编码 `type IN ('comment.v1','group.v1','dm.v1')`，并为三类各给归属前缀 | [comment.go](file:///e:/code/base/internal/store/comment.go#L63-L92) |
| 手机端本地库建表 DDL 集中一处；现有表含 `config` / `items` / `articles` / `blob_index` / `tombstone` / `user_state` / `quizzes` / `quiz_attempt` / `comment_out` / `segments` / `my_submissions` / `groups` / `group_keys` / `dm_keys` / `tag_links`；**无 `progress` 表**（总纲已预留但未落地） | [repo.ts](file:///e:/code/base/apps/mobile/src/core/repo.ts#L101-L148) |
| 离线待发队列就是 `comment_out(event_id,target_id,text,reply_to,wire,state,reason,queued_at)`，按 `queued_at ASC` 取待发；`CREATE TABLE IF NOT EXISTS` 不补列，故既有库靠 `ensureGroupColumns` 一类幂等补列手法演进 | [repo.ts](file:///e:/code/base/apps/mobile/src/core/repo.ts#L118-L121)、[repo.ts](file:///e:/code/base/apps/mobile/src/core/repo.ts#L148-L163) |
| `comment_out.wire` 存的是**已签名请求体本身**（`{event_id,type,created_at,body,sig}` 的 JSON 文本，逐字节冻结），补发时原样重放 ⇒ **跨事件类型复用无需加列**（`dm.v1` 即先例） | [dm.ts](file:///e:/code/base/apps/mobile/src/core/dm.ts#L295-L309)、[comment.ts](file:///e:/code/base/apps/mobile/src/core/comment.ts#L180-L213) |
| 事件体有通用构造器 `buildEventWire(ident, type, body)`，返回 `{eventId, wire}`，密码学零新代码 | `apps/mobile/src/core/wire.ts`（`dm.v1` 调用点 [dm.ts](file:///e:/code/base/apps/mobile/src/core/dm.ts#L306)） |
| 投稿编排：`enqueueOrSend` / `flushSubmissions` / `mapSubmitFailure` / `isPermanentSubmitFailure`；送达 → `sent`，断网·429·5xx → `pending`，其余 4xx → `failed` | [submit.ts](file:///e:/code/base/apps/mobile/src/core/submit.ts#L310)、[submit.ts](file:///e:/code/base/apps/mobile/src/core/submit.ts#L347)、[submit.ts](file:///e:/code/base/apps/mobile/src/core/submit.ts#L218-L229) |
| 文章页已有**不落盘**的阅读进度条（`progress` ref + 顶部 2px 细条），页面离开即丢 | [article.vue](file:///e:/code/base/apps/mobile/src/pages/article/article.vue#L68)、[article.vue](file:///e:/code/base/apps/mobile/src/pages/article/article.vue#L175)、[article.vue](file:///e:/code/base/apps/mobile/src/pages/article/article.vue#L258) |
| 手机端页面全量清单（24 页）：`article` / `lesson/detail` / `lesson/edit` / `course/course` / `course/detail` / `course/edit` / `quiz` / `submit` / `selfcheck` / `myitems` / `comment` / `mine` / `tag/apply` / `tag/detail` / `tag/list` / `governance` / `group` / `circle` / `dm/chat` / `dm/list` / `contribution` / `setting` / `search` / `favorite` | `apps/mobile/src/pages/**/*.vue` |
| 总纲 §9 形态表把「学习进度与打卡」登记为：锚定 `item_id` + 学习者 id、可见性「私有（仅本人可读，可选公开）」、载体「进度事件（LWW 合并）」 | 总纲 [L576-L581](file:///e:/code/base/docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md#L576-L581) |
| 总纲 §9 事件通用结构：线上形态 `{event_id, type, created_at, body}`，`event_id` 客户端自带 16 hex，归属用与请求无关的内容签名 `sig` | 总纲 [L583](file:///e:/code/base/docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md#L583) |
| 总纲 §9 合并规则：事件按因果序 + LWW 合并 | 总纲 [L590](file:///e:/code/base/docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md#L590) |
| 总纲 §9 手机端本地表清单已预留 `progress(item_id, position, updated_at, dirty)` | 总纲 [L515-L531](file:///e:/code/base/docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md#L515-L531) |
| 总纲登记「节点侧新表」的既有手法是开一条 `§0.x` 改版说明（先例：§0.8 登记 `tag_links`） | 总纲 [L148](file:///e:/code/base/docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md#L148) |
| 手机端当前版本 `0.16.0` / `21` | `apps/mobile/src/manifest.json` |
| 发布硬口径：凡手机端有用户可见改动，必须含四步（云打包 → 上传 `/opt/appdl` → 落地页改指 → `based release` 签发）+ 节点二进制重编部署 | `docs/README.md` §5、各 F 条计划「版本与发布」 |

---

## 1. 目标

让学习者**离线也能记录**「学到哪 / 学完没」，联网后自动补发；跨设备、跨节点能收敛到同一份进度；并由学习行为**自动**派生每日打卡与连续天数。

范围一句话：**一条新事件类型 `progress.v1` + 节点侧两张投影表 + 手机端两张本地表 + 三处展示落点**。

---

## 2. 明确不做（排除范围）

1. **不做跨身份可见性策略**——总纲 §9 形态表写的「可选公开」**本册延期不取消**，进度恒为私有（仅本人可读）。理由：本册上游「明确不做什么」已排除；且「公开」一旦成立就要连带回答「谁能看、看不看排行榜、公开后如何撤回」，超出 B 主线一册的边界。
2. **不做排名、积分、奖励结算、徽章**（沿用总纲对 B 主线的排除）。
3. **不做独立「学习进度」页、不做日历热力图**。展示只落在既有的内容页 / 课程页 / 我的页三处。
4. **不做跨设备冲突的人工介入 UI**（不弹「以哪台为准」）。冲突一律按 §3.4 的 LWW 口径静默收敛。
5. **不做学习时长统计**（不新增易漂移的计时字段与防刷逻辑）。
6. **不做 iOS**（沿用全项目口径）。
7. 不改内容包规范 v1、不 bump `schema_version`、不新增配置项、不新增 `source` / `type` 枚举值。

---

## 3. 数据模型

### 3.1 事件类型 `progress.v1`

- 线上形态沿用总纲 §8.2 通用结构：`{event_id, type:"progress.v1", created_at, body}`，`event_id` 客户端自带 16 hex，归属签名 `sig` 覆盖 `canonical({event_id,type,created_at,body})`。
- `body` 形状：

```json
{ "item_id": "<32hex>", "position": 640, "done": false, "day": "2026-10-01" }
```

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `item_id` | string | 32 hex | 被学习的条目（course / lesson / article / video / quiz）。 |
| `position` | int | `>= 0` | 归一化进度位，量纲按 `type` 分派，见 §3.2。 |
| `done` | bool | 必填 | 完成标记，**由客户端判定并显式上报**；节点只信该值，不反推。 |
| `day` | string | `YYYY-MM-DD` | **客户端本地时区**的打卡日，见 §3.5。 |

- 事件**不带正文块**（`payload_cid` 为空）：进度是纯结构化数据，没有需要上下游搬运的 blob。

### 3.2 `position` 归一化（按 type 分派，写死防漂）

| 条目 type | `position` 含义 | 取值区间 | `done` 判定 |
| --- | --- | --- | --- |
| `article` | 正文滚动千分比 | `0–1000` | 客户端：`position >= 1000` |
| `video` | 已看到秒数 | `0–maxInt` | 客户端：看到末尾（由视频页判定） |
| `quiz` | 已作答题数 | `0–题目总数` | 客户端：`position >= 题目总数` |
| `course` / `lesson` | **不上报**——容器自身无「阅读位置」 | — | 容器完成度由子条目聚合，见 §4.4 |

**这是唯一的量纲定义处**；Go / TS 两份实现与两侧单测都引用本表，不得各自另立口径。

### 3.3 「同一条目的进度」= 一个 LWW 寄存器

`(id, item_id)` 唯一确定一个寄存器，取值 = 该 `(id, item_id)` 下所有 `progress.v1` 事件经 §3.4 排序后的**首条**。

### 3.4 LWW 口径（写死）

**排序 = `created_at` 降序，平局取 `event_id` 升序；首条即胜者。**

- 该口径与节点侧按身份读事件的既有排序**逐字一致**（[event.go](file:///e:/code/base/internal/store/event.go#L63) 的 `ORDER BY created_at DESC, event_id ASC`），客户端本地合并复用同一比较函数。
- **已知既有不一致**：`internal/store/dm.go` 的 `ListDMEvents` 用 `event_id DESC`。本册**不跟** dm 口径（dm 的事件按对话阅读序展示，与寄存器取值语义不同），也不去改 dm——不在本册范围。
- 平局判据是**确定性**的：任意节点、任意到达顺序，收敛结果唯一。
- 为防双端漂移，新增契约向量 `vectors/v1/progress.json`（宿主：`position` 归一化用例 + LWW 平局用例），Go 与 TS 两侧测试同时消费——与 `vectors/v1/attrs.json` / `vectors/v1/markdown.json` 同机制。

### 3.5 打卡日与连续天数

- **打卡日界 = 客户端本地时区**。`day` 由客户端在产生事件时算好并写进 `body`；节点**不**用 `created_at` 反推。理由：若按节点 UTC 推，CST 早上 08:00 的学习（= UTC 前一日 24:00 前后）会被记进前一天，用户会看到「明明学了却没打上卡」。
- **某一天已打卡** ⇔ 该身份存在至少一条 `day == 该日` 的 `progress.v1` 事件。
- **连续天数**：从「今天（客户端本地时区）」起向前逐日回溯已打卡日集合，首个缺口即断。今天尚未打卡时，从昨天起算（当天不判断签）。
- **打卡日必须独立存储，不能从折叠后的进度表派生**：`(id,item_id)` 是 LWW 寄存器，一个条目只留最后一次的 `day`，会把该条目历史上的打卡日冲掉。故采用**一条事件、两张投影表**（节点侧 `progress` + `checkin_days`；手机端同构），见 §4.2 / §5.2。

---

## 4. 节点侧改动面

### 4.1 放行与分流

- [event.go](file:///e:/code/base/internal/httpapi/event.go#L23-L30) 的 `eventTypeRegistry` 加一行 `"progress.v1": {}`。
- [event.go](file:///e:/code/base/internal/httpapi/event.go#L62-L75) 的 switch 加 `case "progress.v1"` 分支，走本册的校验 + 双投影写入。
- **不**沿用 `putBareEvent`：「只落骨架」会让节点侧两张投影表永远为空，`GET /v1/me` 也就没东西可返回。

### 4.2 两张投影表

| 表 | 主键 | 列 | 语义 |
| --- | --- | --- | --- |
| `progress` | `(id, item_id)` | `id, item_id, position, done, day, updated_at, event_id, dirty` | 每个寄存器只留 LWW 胜者（upsert）。 |
| `checkin_days` | `(id, day)` | `id, day, first_event_id, created_at` | 打卡日集合（insert-or-ignore，保留首次）。 |

- `dirty` 沿用总纲 §9 预留语义：标记「本地已变、待纳入反熵游标」的待处理位，与 `peer_sync_cursor` 的严格递增配合，不得引入第二套游标。
- **写入是同一事务**：一次 `progress.v1` 同时 upsert `progress` 与 insert-or-ignore `checkin_days`，避免反熵中断留下半条状态。

### 4.3 反熵

- [eventsync.go](file:///e:/code/base/internal/peersync/eventsync.go#L209-L248) 的 `parseEventProjection` 加 `progress.v1` 分支，从 `body_json` 还原上述两表的列。
- **不需要**动 [comment.go](file:///e:/code/base/internal/store/comment.go#L63-L92) 的 `EventBlobIndex()`：`progress.v1` 不带 `payload_cid`，块归属问题不存在（该 SQL 的 `type IN (…)` 白名单保持不变）。

### 4.4 `GET /v1/me` 接真

- [identity.go](file:///e:/code/base/internal/httpapi/identity.go#L237-L242) 的 `"progress": []any{}` 改为**按签名身份返回真实进度**：数组元素形如 `{item_id, position, done, day, updated_at}`。
- `events` 数组本册**保持现状**（空数组），不扩面——它属于另一条待办，不在本册范围。
- 现有断言「恒为空数组而非 null」保留：改为真数据后仍是数组，`null` 红线不破。

### 4.5 限速风险（须在计划里处理）

既有写限速是**身份 30 次/分钟**（[event.go](file:///e:/code/base/internal/httpapi/event.go#L16-L20)）。进度是高频事件，若上报过密会撞 `429`。本册的应对是**客户端节流**（§5.3），**不放宽节点限速**——放宽会削弱 §4.1 的既有防护，属越界改动。

---

## 5. 手机端改动面

### 5.1 本地表

| 表 | 主键 | 列 | 说明 |
| --- | --- | --- | --- |
| `progress` | `item_id` | `item_id, position, done, day, updated_at, dirty` | **总纲 §9 已预留**（`item_id, position, updated_at, dirty`），本册**补 `done` 与 `day` 两列**；因本地单人库故无 `id` 列。 |
| `checkin_days` | `day` | `day, first_event_id, created_at` | 新增；与节点侧同构。 |

- 建表写进 [repo.ts](file:///e:/code/base/apps/mobile/src/core/repo.ts#L101-L148) 的 DDL 清单；**既有库靠幂等补列手法演进**（`CREATE TABLE IF NOT EXISTS` 不补列），沿用 [repo.ts](file:///e:/code/base/apps/mobile/src/core/repo.ts#L148-L163) 既有的 `ensureGroupColumns` 同款手法，为存量库补 `done` / `day`。

### 5.2 写入顺序

**先写本地、再进队列**：同一事务写 `progress` 行（`dirty=1`）+ insert-or-ignore `checkin_days`，然后生成 `progress.v1` 事件体投递。

### 5.3 上报时机与节流

- **触发点**：进入内容页记起点；**离开页面 / 切前后台 / 标记完成**时上报一次。
- **节流**：同一 `item_id` 两次上报间隔 `>= 5s`；不足间隔则丢弃本次（下一次触发点仍会带上最新位置）。
- **明确不做「滚动即写」**：队列会被滚动事件淹没，且必然撞 §4.5 的限速。
- 上报内容一律是**当前位置的绝对值**（不是增量），故丢一次上报不会造成累计误差——这是节流能安全丢帧的前提。

### 5.4 离线复用既有队列

- 复用 [repo.ts](file:///e:/code/base/apps/mobile/src/core/repo.ts#L118-L121) 的 `comment_out` 作为待发队列（与 `group.v1` / `dm.v1` 的离线发言同口径，**不加列**）。
- **承载口径**（`comment_out` 没有 type 列，类型由 `wire` 自带，故无需区分）：`wire` = `buildEventWire(ident,'progress.v1', body)` 产出的**已签名请求体**（逐字节冻结、补发原样重放）；`target_id` = `item_id`（便于排查）；`text` / `reply_to` 留空字面量。先例见 [dm.ts](file:///e:/code/base/apps/mobile/src/core/dm.ts#L295-L309)。
- 状态机沿用 [submit.ts](file:///e:/code/base/apps/mobile/src/core/submit.ts#L218-L229) 的分类：送达 → `sent`；断网 / `429` / 5xx → `pending` 等下轮；其余 4xx → `failed`（永久失败，不再重试）。
- 补发挂到 [submit.ts](file:///e:/code/base/apps/mobile/src/core/submit.ts#L347) 的 `flushSubmissions` 既有编排上，按 `queued_at ASC` 顺序补发。

### 5.5 本地读取

页面上读进度一律走本地表（离线可用）；`GET /v1/me` 只在**同步时**拉一次并按 §3.4 同一比较函数合并进本地表（LWW 后写回），不参与页面渲染路径。

---

## 6. 展示落点（三处）

| 落点 | 文件 | 内容 |
| --- | --- | --- |
| 内容页 | [article.vue](file:///e:/code/base/apps/mobile/src/pages/article/article.vue#L68)、`pages/lesson/detail.vue`、`pages/quiz/quiz.vue` | 进入时**续位**到上次位置（文章滚动到千分比对应处）；顶栏细进度条复用 [article.vue](file:///e:/code/base/apps/mobile/src/pages/article/article.vue#L258) 已有的那根，改为读本地 `progress` 而非页面瞬时值。 |
| 课程页 | [course.vue](file:///e:/code/base/apps/mobile/src/pages/course/course.vue) | 每门课显示**完成度** = 已完成课时数 / 总课时数（按 §4.4 的容器聚合口径派生，不新增存储）。 |
| 我的页 | [mine.vue](file:///e:/code/base/apps/mobile/src/pages/mine/mine.vue) | 新增**进度卡**：今日是否已打卡、连续天数、在学中列表（有进度但 `done=false` 的条目）。**这是自动打卡唯一的可见处**——自动打卡没有按钮，不落展示就等于没做。 |

**容器完成度聚合口径**：`course` / `lesson` 的完成度 = 其可获得子条目中 `done=true` 的比例；不可得的子条目（未下载）不计入分母。该口径只用于展示，**不产生事件、不落表**。

---

## 7. 上游回填清单（按项目规则：**先改上游册子，再写计划**）

对 `specs/2026-09-25-base-distributed-learning-design.md`：

1. **§9 形态表第 579 行**：可见性由「私有（仅本人可读，可选公开）」改为「私有（仅本人可读）；**「可选公开」延期不取消**（#8 册子 §2 第 1 条）」。
2. **§9 追加 `progress.v1` 事件语义小节**：`body` 形状、`position` 归一化表（§3.2）、LWW 口径（§3.4）、打卡日界（§3.5）。
3. **§9 手机端本地表清单（L515–L531）**：`progress` 表补 `done` 与 `day` 两列；新增 `checkin_days(day, first_event_id, created_at)` 一行。
4. **新增 `§0.11` 改版说明**：登记**节点侧新表** `progress(id, item_id, position, done, day, updated_at, event_id, dirty)` 与 `checkin_days(id, day, first_event_id, created_at)`，并声明「列不删、不 bump `schema_version`」（沿用 §0.7 / §0.8 的措辞）。
5. **§10 B 主线验收行**：补一条「进度离线写 → 联网补发 → 跨节点收敛到同一份」。

对 `docs/README.md`：§3 第 8 行状态、§4 依赖图（`进度 (#8)` 分支）、§5 当前阶段与下一步。

---

## 8. 验收

### 8.1 自动化（本册必须实测）

| 层 | 断言 |
| --- | --- |
| Go 单测 | `progress.v1` 放行与校验（未知 type 仍 `event_type_unknown`、非法 `day` / `position` 被拒）；双投影同事务写入；`GET /v1/me` 返回真实进度且非 `null`；LWW 取值（含 `created_at` 平局取 `event_id` 升序）；`checkin_days` insert-or-ignore 保留首次。 |
| Go 反熵 | 两节点间 `progress.v1` 传播后，两侧 `progress` / `checkin_days` 逐字一致；重复投递幂等。 |
| vitest | `position` 归一化（文章千分比 / 视频秒 / 题库题数）；节流 `>= 5s` 丢帧且不产生累计误差；本地 LWW 合并与 Go 侧同一比较函数；连续天数（含「今天未打卡不断签」「跨月」「本地时区跨日」）；离线入队 → 补发 → 状态迁移。 |
| 契约向量 | `vectors/v1/progress.json` 被 Go 与 TS 两侧测试同时消费全绿（`position` 归一化 + LWW 平局），防双端漂移。 |
| 门禁 | 仓库根 `go build ./...` / `go vet ./...` / `go test ./...`；`cd apps/mobile` → `npx vitest run`、`npx tsc --noEmit`、`npm run build:h5`；模板 `.value` 硬检查无输出；`scripts/acceptance-d.ps1`。 |

### 8.2 真机（**本册延后，不阻塞实施**）

按用户明确指令「真机测试延后」，本册的真机项**不在实施计划内消耗**，统一登记为待人工：内容页续位与细进度条、课程页完成度、我的页进度卡与连续天数、跨设备收敛、断网写入后联网补发。登记处：本册本节 + `docs/README.md` §5「待人工」。

---

## 9. 版本与发布

- 手机端版本 `0.17.0` / `22`（当前 `0.16.0` / `21`）。
- 手机端有用户可见改动 ⇒ 四步发布强制：云打包 APK → 上传 `/opt/appdl/base-0.17.0.apk` → 落地页 `/opt/appdl/index.html` 整页重写改指 → `based release` 签发落 `/opt/base-cache/data/release.json`。
- 节点侧新增两张表与一条事件类型 ⇒ **必须重编节点二进制并部署**：交叉编译 linux/amd64 → `mv` 原子替换 `/opt/base/based` + `chmod 0755` → 保留回滚件 → 重启 `base` 与 `base-cache` → 探活（发布文档校验走 `:80`，路由存在性探活走 `:443`）。
- 证书 SHA1 必须仍是 `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`，否则不能覆盖安装。

---

## 10. 风险与已知代价

1. **限速与上报频率的张力**（§4.5）：节点限速不放宽，全靠客户端节流。若节流阈值未来被调小，会直接撞 `429`。**代价已接受**：宁可丢帧（绝对值上报无累计误差），也不放宽节点防护。
2. **`day` 依赖客户端时钟**：客户端本地时区被改或时钟被回拨，会污染打卡日集合。本册**不做**时钟可信性校验（属节点侧不可验证的客户端自述数据），登记为已知代价。
3. **打卡日不可撤回**：`checkin_days` 是 insert-or-ignore 的只增集合，没有「取消打卡」路径。**明确接受**——打卡是自我记录，不是可撤销的授权。
4. **老包（≤ `0.16.0`）看不到进度**：本册新增事件类型对老客户端是不可见增量，老包不发也不读，**无兼容断层**（与 F5 的字面量标记不同，本册不产生需降级的显示面）。
5. **LWW 按 `(id, item_id)` 寄存器**：多设备同时学同一条目时，后写入者覆盖前者，**会丢失另一台设备的部分进度位置**。**明确接受**：进度是「一个位置」而非「多条记录」，语义上就该如此；若要保留历史需另开册子。
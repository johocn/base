# base 点赞与举报设计（like.v1 / report.v1）

* 日期：2026-10-06

* 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）

* 直接上游：`specs/2026-09-27-base-comment-event-sync-design.md`（下称 #19）§1 L87「不做点赞、举报…」与 §9 L573 挂账行

* 范围：**事件类型登记（like.v1 / report.v1）· 计数即时聚合（零新表）· 读面内联 like_count · 审核面举报列表 · 跨节点同步投影 · mobile 点赞与举报 UI**

* 本册子**不覆盖**：条目 report.v1（条目举报走治理快捷提案，§7.4）；点赞者列表；离线点赞/举报队列；举报阈值自动处置；H5 门户点赞展示；审核工具化（#19 既有挂账）；iOS

## 0. 改版说明

### 0.1 2026-10-06 初版

**新增（本册子首次定义）：**

* 事件类型 `like.v1` / `report.v1` 的 body 契约与严格键集（§3）

* 计数语义：like 的 LWW 合并口径与 report 的去重计数（§4）——答 #19 §9 L573「计数需要合并语义，须单开册子」

* 读面内联：`GET /v1/comment` 与 `GET /v1/catalog` 响应内联 `like_count`（§5.1 / §5.2）

* 审核面新路由 `POST /v1/admin/review/reported`（§5.3）

* `events` 表新索引 `idx_events_type_target`（§4.3）

* peersync `parseEventProjection` 扩两分支（§6）

* mobile 本地表 `like_out`、`items` 补列 `like_count`，评论页点赞/举报、阅读页点赞、条目举报快捷提案（§7）

**明确沿用、不改动：**

* `POST /v1/event` 的验签管线与既有准入语义：签名头管准入、事件体内容签名 `sig` 管**归属**（覆盖 `canonical({event_id,type,created_at,body})`）——两新类型**不新增签名域常量**（同 govern.v1 先例）

* 事件限速（30/min/ID，burst 10）——点赞/举报同受其约束，不另设限额

* `event-sync` 与墓碑增量两段反熵：**零改动**（事件增量本就不按 type 过滤，`peer.go:243` → `store/event.go:92`）

* `comment_tombstone` 与 `POST /v1/admin/review/fetch` / `reject` 既有语义——举报处置仍用 fetch 取正文 + reject 删块

* 双实现纪律（P6 先例）：Go 与 Node 两侧同修同口径；客户端 `@base/core-ts` 本地库的幂等迁移手法（`packages/core-ts/src/repo.ts` L216+ 同款 `ALTER TABLE` 补列）

### 0.2 定案记录（2026-10-06 问答结论）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 对象范围 | **全量覆盖**：评论点赞/举报 + 条目点赞都做；条目举报单列（#2） |
| 2 | 条目举报去向 | **快捷提案**：条目举报不进 report.v1，mobile 跳治理页预填 `remove` 提案（复用 #29/#30 既有流），节点侧零改动 |
| 3 | 取消点赞 | **支持 unlike**：LWW 取 `(created_at, event_id)` 最大者为最新状态，取消即发 `action=unlike` 事件 |
| 4 | 评论举报消费 | **审核面加专用列表**：新增 `POST /v1/admin/review/reported`（X-Base-Review-Key），处置仍走既有 fetch→reject |
| 5 | 计数实现 | **方案 A 即时聚合**：零新表，读时对 events 聚合；`events` 加 `(type, target_id)` 索引；十万级事件后与 #19 §9 规模 revisit 同期换冗余表 |

### 0.3 取证修正（设计期三处，如实登记）

| # | 初稿口径 | 取证事实 | 定稿口径 |
|---|---|---|---|
| 1 | 写侧新增 `POST /v1/like`、`POST /v1/report` 路由 | 总纲 §9 写路由表（L519）与 `internal/httpapi/event.go:25` 证实写侧统一走 `POST /v1/event` + `eventTypeRegistry` | **注册两新类型，写侧零新路由**；`handleEventPost` 的 switch 加两分支 |
| 2 | `POST /v1/admin/review/fetch` 加过滤参数列出被举报评论 | `internal/httpapi/comment.go:106` 证实 fetch 是**按 payload_cid 取单条正文**的工具，审核面本无列表接口 | **新增 `POST /v1/admin/review/reported` 专用列表路由**（§5.3），fetch/reject 不动 |
| 3 | 「事件增量类型白名单扩两类型」 | `internal/httpapi/peer.go:243` 与 `internal/store/event.go:92` 证实 event-sync 拉取**不按 type 过滤**（#19 §0.2 第 3 条已定案） | **同步面零过滤改动**；唯一落点是接收侧 `parseEventProjection` 扩两分支（§6）；`EventBlobIndex` 白名单不动（两类型无 payload，同 progress.v1 先例） |

## 1. 范围与不做什么

**做六件事：**

1. **事件类型登记**：`like.v1` / `report.v1` 进 `eventTypeRegistry`，`POST /v1/event` 按 switch 分流到各自处理器（`internal/httpapi/event.go`）。
2. **点赞写入**：评论（16 hex 事件 id）与条目（路径式 item_id）都可 like / unlike；target 本地校验；落事件行填 `target_id` 投影列。
3. **举报写入**：仅评论 target；四值 reason 严格校验；重复举报不拒、计数去重。
4. **计数与读面**：`GET /v1/comment` 与 `GET /v1/catalog` 内联 `like_count`；审核面新增举报列表。
5. **跨节点传播**：接收侧投影重建扩两分支；事件与块反熵零改动。
6. **mobile UI**：评论页点赞按钮 + 举报四原因弹层；文章/课时阅读页条目点赞；条目举报跳治理页预填 `remove` 提案。

**明确不做：**

* **不做条目 report.v1**。条目举报经治理提案处置（有门槛、有多签、有既有 UX），节点侧再养一套条目举报计数是重复状态面。若运营期证明需要，另开册子（§11）。

* **不做点赞者列表路由**。公开面只给计数；谁点了赞不暴露（隐私与简化双理由）。

* **不做举报阈值自动处置**。举报聚合只呈现给人，处置动作永远人工（fetch→reject）；自动下架的误伤面大，留挂账。

* **不做离线点赞/举报队列**。两类事件都是无正文的轻写，离线时的价值存疑；offline 点击一律 toast「需联网」，不进 `comment_out`（留挂账 §11）。

* **不做 H5 门户点赞展示**。门户是 P3 对拍冻结面，本册不碰 `web/` 与门户模板。

* **不做审核工具化**。维持 #19 口径：手工 curl / 脚本调用。

* **不做客户端侧评论 like_count 的离线持久化**（评论域）。评论计数随在线列表刷新；条目计数例外（§7.3，随 catalog 同步落本地）。

## 2. 契约边界

### 2.1 不可改（任何实现都不得偏离）

| 项 | 约束 | 出处 |
|---|---|---|
| 写路由 | 新类型只经 `POST /v1/event`；不得新开 `/v1/like`、`/v1/report` 写面 | 总纲 §9、本册 §0.3-1 |
| 事件归属 | `sig` 覆盖 `canonical({event_id,type,created_at,body})`；**不新增签名域常量** | #19 §3.4 |
| 准入 | 必须签名头 + 已登记身份；`event_id` 16 hex；`created_at > 0`；未登记 type → 400 `event_type_unknown`；体 ≤64 KiB | #19 §2.1 |
| body 键集 | 严格键集：多一个未知键即 400 `event_param_invalid`（同 `parseCommentBody` 纪律，防止「签了一份、存了另一份」） | `event.go:208-247` |
| 投影列 | `like.v1` / `report.v1` 落行时 `payload_cid` / `reply_to` 置空、`target_id` 必填 | events 表 DDL（`schema.go:122`） |
| append-only | 事件不删不改；取消 = 新 unlike 事件；无墓碑机制（点赞/举报无正文可删） | #19 §0.2 第 5 条 |
| 公开面隐私 | `GET /v1/comment`、`GET /v1/catalog`、`GET /v1/blob/*` 零 report 字段、零点赞者名单 | 本册 §5.4 |
| 审核面鉴权 | `X-Base-Review-Key`；未配置则路由不注册；密钥不符回 404 `not_found` | `comment.go:89-99` |
| 双实现 | Go 与 Node 两侧同修；`internal/` 改动须有 `apps/node` 镜像 | P6 先例（#78） |

### 2.2 允许新增（v1 之外）

* `eventTypeRegistry` 加两行；`handleEventPost` switch 加两分支；各类型独立 body 解析函数（同 `parseCommentBody` 体例）。

* `events` 表加索引 `idx_events_type_target(type, target_id)`（§4.3）。

* 新读路由 `POST /v1/admin/review/reported`（注册在 `server.go` 审核面两路由旁）。

* 既有响应结构加字段：`commentDTO` 加 `like_count`、catalog 条目对象加 `like_count`——**纯增字段**，消费端向后兼容。

* mobile/`core-ts`：新表 `like_out`、`items` 补列 `like_count`（幂等 `ALTER TABLE` 手法）。

## 3. 事件模型

### 3.1 like.v1

```
{ "event_id": <16hex>, "type": "like.v1", "created_at": <ms>,
  "body": { "target_id": <string>, "action": "like" | "unlike" },
  "sig": <128hex> }
```

* `target_id` 两形态：**16 hex** = 评论事件 id；**路径式 item_id**（`article/<aid>`、`course/<cid>`、`lesson/<lid>` 等，沿用总纲 §6.0 命名空间，`validTargetID` 校验）= 条目。

* `action=like` 点赞、`action=unlike` 取消；无第三值。

* **无 payload**：不落块，`payload_cid` / `reply_to` 置空。

* 落库 `body_json = canonical({target_id, action, sig})`——与 comment.v1 的减化同例（存归属签名为证）。

### 3.2 report.v1

```
{ "event_id": <16hex>, "type": "report.v1", "created_at": <ms>,
  "body": { "target_id": <16hex 评论事件 id>, "reason": "spam"|"abuse"|"illegal"|"other" },
  "sig": <128hex> }
```

* target **仅评论**；四值 reason 之外一律 400 `event_param_invalid`。

* 重复举报（同人同目标再发）**不拒**：新事件照常落行，计数按去重口径聚合（§4.2）——重复举报本身是信号（骚扰性举报由审核面人眼判断）。

* **无 payload**，同上。

### 3.3 target 校验与错误码（写侧，接收侧不校验）

| 校验 | 失败响应 | 说明 |
|---|---|---|
| `action` / `reason` 非法或 body 多键缺键 | 400 `event_param_invalid` | 复用既有码，不新增 |
| 评论 target 不存在（`GetEventByID` 未命中或 type ≠ comment.v1） | 404 `target_not_found`（**新码**） | 事件级新码，仅此一处分婏 |
| 评论 target 已墓碑 | 410 `target_gone`（**新码**） | like 与 report 同口径：墓碑目标一律拒绝，避免「给死人点赞」 |
| 条目 target 不存在或 `items.state ≠ 'active'` | 404 `target_not_found` | 下架（remove 生效）后不可再点赞 |
| report target 非路径式评论形态 | 400 `event_param_invalid` | report 只收 16 hex |

**接收侧（反熵）不重放这些校验**：与 comment.v1 同口径——对端事件直接落行，target 可能尚未同步到本地（§6），计数查询天然按「本地存在的行」聚合，不存在悬空引用问题（悬空行的 target 在本地无消费者）。

### 3.4 幂等

同 `event_id` 重发走既有 `PutEvent` upsert：响应同首次 `received_at`，事件不重复落行，计数不变。客户端对点赞按钮做本地防抖（§7.2），服务端幂等兜底。

## 4. 计数语义（方案 A：即时聚合）

### 4.1 like_count（LWW 合并）

同 `(actor id, target_id)` 的所有 like.v1 事件按 `(created_at, event_id)` 取**最大者为最新状态**；计数 = 最新状态为 `action='like'` 的**去重 actor 数**：

```sql
SELECT COUNT(DISTINCT e.id)
FROM events e
WHERE e.type='like.v1' AND e.target_id=:t
  AND json_extract(e.body_json,'$.action')='like'
  AND NOT EXISTS (
    SELECT 1 FROM events e2
    WHERE e2.type='like.v1' AND e2.id=e.id AND e2.target_id=:t
      AND (e2.created_at > e.created_at
           OR (e2.created_at = e.created_at AND e2.event_id > e.event_id)))
```

* `action` 从 `body_json` 取（SQLite JSON1；Go 驱动与 `node-sqlite3-wasm` 两侧同支持，黄金对拍覆盖 §9）。

* 乱序到达（旧 `created_at` 的 like 晚到）不翻转状态：NOT EXISTS 只保留每个 `(id,target)` 的最新行，天然幂序。

### 4.2 report_count（去重求和）

```sql
SELECT COUNT(DISTINCT id) FROM events WHERE type='report.v1' AND target_id=:t
```

无 LWW、无取消语义（举报不可撤回——举报人若误报，由审核人判断，不提供反悔通道）。

### 4.3 索引

```sql
CREATE INDEX IF NOT EXISTS idx_events_type_target ON events(type, target_id)
```

现有三索引（`schema.go:417-419`）均不覆盖 `(type, target_id)` 前缀；本索引同时服务：评论页按页聚合、catalog 按页聚合、reported 列表的 report 计数。建列次序沿用补列后建索引的既有纪律（`schema.go:366` 注释）。

### 4.4 聚合方式与规模边界

* **按页聚合**：评论列表与 catalog 都对**当页 target 集合**做一条 `GROUP BY target_id` 查询取计数，禁止逐行 N+1。

* 规模上限十万级事件：单 target 的 like 行数=点赞人数（几百量级），索引下 GROUP BY 毫秒级。超过后与 #19 §9 L579「event-sync 规模 revisit」**同期**评估冗余计数表（`like_count(target_id, cnt)` + 事件驱动增减），本册不预建。

## 5. 读面与审核面

### 5.1 GET /v1/comment 内联 like_count

`commentDTO` 加 `like_count`（int，≥0）。`handleCommentList`（`comment.go:36`）在既有 `ListComments` 之后对当页 `event_id` 集合做一次 §4.1 聚合，DTO 逐行填值。**墓碑排除语义不变**（store 层 NOT EXISTS 照旧）。

### 5.2 GET /v1/catalog 内联 like_count

`handleCatalog`（`public.go:58`）对当页条目 `item_id` 集合做同一条聚合（like.v1 的条目 target 与 items.item_id 同形）。响应条目对象加 `like_count`。`?since` 短路与游标分页语义不动。

### 5.3 POST /v1/admin/review/reported（新路由）

* **鉴权与可见性**：挂 `requireReviewKey` 同款——`X-Base-Review-Key` 头；未配置 `ReviewKey` 的节点**不注册**此路由；密钥不符回 404 `not_found`（`comment.go:89-99` 手法原样复用）。

* **请求**：空体 `{}`（无参数；列表短小，不分页）。

* **响应**：

```json
{ "reports": [ {
    "event_id": "<评论 16hex>", "actor": "<评论作者 id>",
    "target_id": "<评论所属目标>", "payload_cid": "<评论正文块>",
    "reply_to": null, "created_at": 123,
    "report_count": 3, "reporters": ["<举报人 id>", "..."]
} ] }
```

  行 = **被举报评论**（非举报事件）：按举报事件 `GROUP BY target_id` 联回评论行；`report_count` 按 §4.2；`reporters` = 去重举报人 id 数组；`payload_cid` 供审核者接既有 `POST /v1/admin/review/fetch` 取正文，处置仍走 `reject`。

* **排序**：`report_count` 降序，次键 `(created_at, event_id)` 降序——最热者最先。

* **过滤**：`type='comment.v1'` 内联（评论必须本地已同步到）；排除墓碑评论（NOT EXISTS `comment_tombstone`）——已处置的不再出现。评论尚未从对端同步到的举报行**暂不出现**，反熵到位后自然浮现（§3.3 同口径，登记 §10 风险 4）。

### 5.4 隐私口径

举报人身份只出现在三处：① 节点 `events` 表（body 与 `id` 列，节点内数据）；② `GET /v1/me` 自查本人事件（既有语义，本人可见本人举报）；③ 审核面 `reporters[]`。**公开读面（comment / catalog / blob / 门户）零 report 字段、零点赞者名单**——点赞只有计数，谁点了赞不公开。

## 6. 跨节点同步

* **事件增量**：零改动。`handleEventSync`（`peer.go:243`）→ `ListEventsAfter`（`store/event.go:92`）不按 type 过滤，like/report 事件自动随反熵传播。

* **接收侧投影**：`parseEventProjection`（`internal/peersync/eventsync.go:222`）switch 加一分支：

```go
case "like.v1", "report.v1":
    // body 减化形态 {target_id, action|reason, sig}；无 payload，投影只填 target_id。
```

  `payload_cid` / `reply_to` 保持零值。

* **块归属白名单**：`EventBlobIndex`（`store/comment.go:66`）**不动**——两类型无 payload，同 progress.v1 先例（`eventsync.go:258` 注释）。

* **墓碑不级联**：评论被审核删（reject）时，指向它的 like/report 事件**不删不墓碑**——它们无正文、无公开展示面，计数消费方（§5.1/§5.2）按 target 维度聚合，目标评论已从列表排除后这些行成为纯存量数据。**条目**被 remove 下架后同理：like 行留存，catalog 不再展示该条目。

## 7. 客户端（mobile）

### 7.1 本地库（`packages/core-ts/src/repo.ts`）

* **新表** `like_out(target_id TEXT PRIMARY KEY, action TEXT NOT NULL, updated_at INTEGER NOT NULL)`——**我的点赞台账**，评论与条目共用；一行 = 我对该 target 的最新动作。高亮态唯一来源（服务端不提供 liked_by_me，读面保持匿名零改动）。

* **补列** `items.like_count INTEGER NOT NULL DEFAULT 0`——条目计数本地落库（离线阅读页可见）。沿用 `ensureXxxColumns` 幂等 `ALTER TABLE` 手法（`repo.ts:216+` 先例）。

* 评论计数**不落本地**：评论页在线拉取即权威（#19 §1「不做评论本地持久化」同口径）。

### 7.2 评论页（`apps/mobile/src/pages/comment/comment.vue` + `core/comment.ts`）

* 每条评论行加点赞按钮：`like_count` 显示 + `like_out` 高亮态；点击=发 like/unlike（已赞则取消），**按钮本地防抖**（发送中禁点）。

* 每条评论行加举报入口（长按或 ⋯ 菜单）→ 弹层四原因（spam / abuse / illegal / other，中文文案）→ 确认即发 report.v1 → 成功 toast「已提交，感谢反馈」。

* 成功后本地计数 ±1 显示；下次拉列表以服务端为准。

### 7.3 阅读页条目点赞（文章页 / 课时页）

* 页脚点赞条：计数读本地 `items.like_count`（进页时若在线用 catalog 内联值校正），点击发 like.v1 → 本地乐观 ±1 写回 `items.like_count`；**离线可读计数但点击 toast「点赞需联网」**。

* 高亮态同读 `like_out`。

### 7.4 条目举报 → 治理快捷提案

* 文章/课时页菜单加「举报此条目」入口 → 跳治理页并**预填 `remove` 提案**（目标 item_id 与理由占位），复用 #29/#30 的提案表单与投票流——不新增任何节点接口。

* 预填理由映射：用户在弹层选的 reason 填入提案描述（「举报类型：垃圾内容」等）。

### 7.5 离线口径

like / report **仅在线**；离线点击 toast，不进 `comment_out` 队列、不落待发区（两类写无正文、无补发价值，挂账 §11 留口）。

## 8. Node 镜像（双实现同修）

与 Go 侧逐条对齐（P6 纪律），落点：

| 面 | Go | Node |
|---|---|---|
| registry + 分流 | `internal/httpapi/event.go` | `apps/node/src/routes/event.ts` |
| 评论列表内联 | `internal/httpapi/comment.go` | `apps/node/src/routes/comment.ts` |
| catalog 内联 | `internal/httpapi/public.go` | `apps/node/src/routes/catalog.ts` |
| reported 路由 | `internal/httpapi/comment.go`（或新文件）+ `server.go` 注册 | `apps/node/src/routes/review.ts` |
| 索引与聚合 SQL | `internal/store/schema.go` / `store` 各文件 | `apps/node/src/store/schema.ts` / `store/events.ts` |
| 同步投影 | `internal/peersync/eventsync.go` | `apps/node/src/peersync/eventsync.ts` |

**对拍口径**：`GET /v1/comment`（含 like_count）、`GET /v1/catalog`（含 like_count）、`POST /v1/admin/review/reported` 三面同数据集字节一致（沿用 P3 批 A G4 门禁口径：status / 头 / body 逐条比对）；`POST /v1/event` 的错误码层（`target_not_found` / `target_gone` / `event_param_invalid` / `event_sig_invalid`）两侧同值。

## 9. 验收（AC）

### 9.1 自动 12 条

1. **幂等**：同 event_id 重发 like.v1 → 200、`received_at` 同首次、计数不变。
2. **LWW 取消**：同 (actor,target) 先 like 后 unlike → 计数回落 0；旧 `created_at` 的 like 晚到不翻转。
3. **去重计数**：同 actor 两条不同 event_id 的 like → 计数 1；两 actor → 2。
4. **评论内联**：`GET /v1/comment` 的 `like_count` 与手算一致；无赞评论为 0。
5. **catalog 内联**：条目对象 `like_count` 与评论域同口径；`?since` 短路响应不受影响（`unchanged:true` 无该字段时不破坏既有消费端）。
6. **举报去重**：同 actor 重复举报 → `report_count=1`、`reporters` 去重；异 actor 累加。
7. **审核鉴权**：reported 路由无密钥节点 404、错密钥 404 `not_found`、正确密钥 200。
8. **reported 过滤**：墓碑评论不出现；`report_count` 降序；`payload_cid` 可接 fetch 取到正文。
9. **错误码**：target 不存在 → 404 `target_not_found`；墓碑 target → 410 `target_gone`；非法 action/reason/未知键 → 400 `event_param_invalid`；条目 target 已 remove → 404。
10. **回归**：未登记类型仍 400 `event_type_unknown`；comment.v1 六步与限速行为不变。
11. **跨节点**：A 节点点赞 → B 节点反熵后 `GET /v1/comment` 计数一致（投影列重建成立）；B 本地无该评论事件时聚合不崩（悬空行无消费者）。
12. **双端对拍**：Go 与 Node 同数据集三读面（comment / catalog / reported）字节一致，写面错误码同值。

### 9.2 真机 3 条

1. 评论页：点赞高亮/取消/计数联动正确；举报弹层四原因可选、提交成功有反馈。
2. 阅读页：条目点赞乐观 ±1；杀进程重进计数保持（本地落库生效）；断网点赞 toast。
3. 条目举报：入口跳治理页、`remove` 提案预填目标正确、既有投票流可走通。

## 10. 风险

1. **JSON1 依赖**：计数走 `json_extract`，两侧 SQLite 构建须含 JSON1——黄金对拍（AC 12）兜底，任一侧缺 JSON1 即阻塞而非降级。
2. **读放大**：评论页/目录每页多一条 GROUP BY；`(type,target_id)` 索引下成本可控。热 target（千人赞）单查仍在毫秒级；十万级事件触发 §4.4 revisit。
3. **时钟偏差**：LWW 按客户端 `created_at`——与评论排序同一已知代价（#19 §8 已记），不新增机制。
4. **举报先于评论到达**：审核节点可能短暂看不到 target 未同步的举报行（§5.3）——反熵收敛后浮现，审核面无丢数据，只有延迟。
5. **事件量放大**：like/report 单体 <200B，但数量可能远超评论；`received_at` 游标增量下单轮拉取行数变多——limit 与限速既有护栏覆盖，规模 revisit 同 §4.4。
6. **对拍冻结面**：catalog / comment 是 P3 批 A 对拍过的面，本册改其响应体——两侧必须**同 commit 语义**落地，先双实现后对拍，禁止只改一侧。

## 11. 待定挂账

* **条目 report.v1**：运营期若需节点侧条目举报计数（而非快捷提案），另开册子——需先回答「条目举报与治理提案的职责边界」。
* **离线点赞/举报**：若真机反馈强需求，评估复用 `comment_out`（wire 已带 type，可行）。
* **点赞者列表**：需要时加 `GET /v1/likes?target_id=`（鉴权口径另议）。
* **举报阈值自动处置**：需先有申诉与撤销墓碑机制（#19 §9「审核工具化」前置）。
* **H5 门户点赞**：门户解冻后随内容展示补。
* **计数冗余表**：与 #19 §9 L579 事件规模 revisit 同期（§4.4）。

## 12. 上游回填清单（本册提交时执行）

1. `docs/README.md`：§3 表加第 79 行（本册）；§5 末尾追加一段「评论挂账四功能之点赞/举报已立册」。
2. 总纲 `specs/2026-09-25-base-distributed-learning-design.md` §9 写路由表 `POST /v1/event` 行：`eventTypeRegistry` 枚举追加 `like.v1`、`report.v1`（2026-10-06 #79 补）。
3. #19 `specs/2026-09-27-base-comment-event-sync-design.md`：§1 L87「不做点赞、举报…」与 §9 L573 挂账行各加注「2026-10-06 由 #79 解挂」。

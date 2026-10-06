# base 评论事件同步设计（① 公开讨论）

* 日期：2026-09-27

* 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）

* 直接上游：`specs/2026-09-27-base-mobile-release-design.md` §7「圈子 / 评论（本版占位页）」及其阻塞项表

* 范围：**事件类型登记 · 评论写入与正文落块 · 公开读接口 · 跨节点事件反熵 · 审核最小闭环 · 评论页落地**

* 本册子**不覆盖**：圈子（② 加密 / 组密钥 / 成员名单，总纲排 C 阶段，本版仍占位）；私信；学习进度上报；离线评论队列；评论附件与图片；评论的编辑与作者自删；点赞 / 举报；客户端侧验签与昵称

## 0. 改版说明

### 0.1 2026-09-27 初版

**新增（本册子首次定义）：**

* 事件类型登记机制与 `comment.v1` 事件体（§3）

* 评论正文的落块口径与 `payload_cid`（§3.3）

* 事件内容签名 `sig`（§3.4）——使事件跨节点传播后仍可验归属

* 公开读接口 `GET /v1/comment`（§4.2）

* 审核接口 `POST /v1/admin/review/fetch` / `POST /v1/admin/review/reject` 与审核密钥（§4.3）

* 节点间事件增量接口 `POST /v1/event-sync`（§4.4）

* 审核删块与反熵的相互作用护栏（§4.5）

* 节点新表 `comment_tombstone` / `peer_sync_cursor`，以及 `events` 表加列（§5）

* 客户端 `HttpAdapter.post`、`src/core/comment.ts`、`pages/comment/comment` 落地、文章页评论入口（§6）

**明确沿用、不改动：**

* S1 已落地的签名头管线（`X-Base-Id` / `Alg` / `Ts` / `Nonce` / `Sig`，ts ±300s、nonce 10 分钟、体 ≤64 KiB），见 `2026-09-26-base-identity-tls-design.md` §3

* `POST /v1/event` 的既有准入语义：必须签名头、必须已登记身份、`event_id` 为 16 hex、`created_at > 0`

* `blob_id = hex(sha256(逻辑字节))[0:32]`（总纲 §3.2）与块目录布局 `data/blobs/<h0..1>/<h2..3>/<blob_id>`

* `GET /v1/blob/{blob_id}` 的匿名可读语义（总纲 §7.3）——评论正文复用同一条读路径

* `data/` 的 L4a′ 透明静态加密（总纲 §12.1.1）：块的磁盘表示变了，`payload_cid` 不变

* 客户端↔节点明文 HTTP（F1，总纲 §12.2）

### 0.2 定案记录（2026-09-27 问答结论）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 本册范围 | **只做评论（①），圈子继续占位**，不动总纲的 C 阶段边界 |
| 2 | 读接口形态 | **按 `target_id` 公开分页读**，`target_id` 可选（缺省 = 全站最新） |
| 3 | 传播范围 | **事件与 ① 正文块都参与反熵** |
| 4 | 审核 | **最小闭环**：取正文 + `rejected` → 删块 + 写墓碑 |
| 5 | 撤回语义 | **只能审核删，作者不能删改** → 事件 append-only，`comment.v1` 是唯一类型 |
| 6 | 传播机制 | **新增 peer 侧事件增量接口**，不复用 `inventory/fetch` |
| 7 | 审核入口 | **环境变量 `BASE_REVIEW_KEY` + 请求头**，未配置该密钥的节点上审核路由**不存在**（404） |
| 8 | `event_id` 归属 | **以落地为准**（客户端自带 16 hex），订正总纲 §9 的「节点签发 ULID」 |

## 1. 范围与不做什么

**做六件事：**

1. **事件类型登记**：把 `comment.v1` 放进节点的类型表，`POST /v1/event` 对其它类型继续 400。
2. **评论写入**：客户端一条签名请求同时提交事件与正文明文；节点验签 → 算 `payload_cid` → 落块 → 落事件行。
3. **评论读取**：`GET /v1/comment` 匿名分页读事件索引，正文走既有 `GET /v1/blob/{payload_cid}`。
4. **跨节点传播**：新增 `POST /v1/event-sync`，按 `received_at` 游标增量拉事件与墓碑；正文块复用既有反熵零改动。
5. **审核最小闭环**：运营密钥取正文；`rejected` → 删块 + 写 `comment_tombstone`；墓碑随反熵传播，各节点删块且不再拉回。
6. **评论页落地**：`pages/comment/comment` 从占位替换为可用页；文章页加评论入口；圈子 tab 保持占位。

**明确不做：**

* **不做圈子**。② 类加密、组密钥、成员名单全在总纲 C 阶段；本册子一行不碰。

* **不做作者自删与编辑**。事件 append-only；想改就再发一条。理由：正文按哈希寻址，字节不可变，编辑语义与寻址模型直接冲突（§0.2 #5）。

* **不做离线评论队列**。评论是上行写，需要联网；离线时明确提示「评论需联网」。总纲 §8.1 的 `events_out` 表本册子不使用、不建。

* **不做评论本地持久化**。不建本地评论表；每次进评论页在线拉取，节点返回即权威。代价是评论离线不可用（§8 风险 7）。

* **不做 `PUT /v1/blob`**。正文随事件内联提交，节点在**已验签的事件上下文里**落块——杜绝「写了块却没人引用」的孤儿块，也不新增一个可被滥用的匿名写块面。评论附件（图片等）需要独立写块，留待后续册子。

* **不做点赞、举报、@、富文本、楼层排序、已读标记**。（点赞 / 举报已由 2026-10-06 册子 #79 解挂；@ 与富文本等其余仍挂账）

* **不做客户端侧验签**。客户端只信任本节点的返回（§8 风险 5）；`sig` 仍然入库存证，供后续客户端验签与第三方核验。

* **不做事件配额与 GC**。只做单条正文上限与写限速（§4.1）。

* **不做审核工具化**。审核是手工 `curl` / 脚本调用，不做后台界面。

* 不做节点↔节点的事件**删除同步**（`extra 仅记录不删`，总纲 §7.4）：只传播墓碑，删块由各节点自行执行。

## 2. 契约边界

### 2.1 不可改（任何实现都不得偏离）

| 项 | 约束 | 出处 |
|---|---|---|
| 寻址算法 | `blob_id = hex(sha256(逻辑字节))[0:32]`（128 bit），① 类逻辑字节 = 明文；**不得修改算法与输入** | 总纲 §3.2 |
| 块目录 | `data/blobs/<h0..1>/<h2..3>/<blob_id>` | 总纲 §3.2 |
| 客户端↔节点传输 | 明文 HTTP，不引入 TLS/HSTS | 总纲 §12.2（F1） |
| 签名头 | 头名、`canonical({method,path,query,body_sha256,ts,nonce})` 待签口径、±300s 窗口、nonce 10 分钟 | S1 册子 §3 |
| `POST /v1/event` 准入 | 必须签名头 + 已登记身份；`event_id` 16 hex；`created_at > 0`；未登记 `type` → 400 `event_type_unknown`；体 ≤64 KiB | S1 册子 §5.6 + 落地 |
| 公开读语义 | `GET /v1/blob/{blob_id}` 匿名可读、不鉴权；① 类正文因此全网可复制 | 总纲 §3 铁律 2、§7.3 |
| 内部路由红线 | `inventory` / `sync` / `fetch` / `scrub` **只挂对端监听**；本册子新增的 `event-sync` 同理 | S1 册子 §5.1 |
| 反熵不删 | `extra` 仅记录，不主动删除本地块 | 总纲 §7.4 第 5 步 |
| 前缀即归属 | `target_id` 沿用路径式命名空间（`article/<aid>` 等） | 总纲 §6.0 |

### 2.2 允许新增（v1 之外）

* 节点 `events` 表加三列 `target_id` / `payload_cid` / `reply_to`（可空）+ 两个索引（§5.1）。

* 节点新表 `comment_tombstone`、`peer_sync_cursor`（§5.2）。

* 事件体新增顶层字段 `sig`（事件内容签名，§3.4）。

* 公开读路由 `GET /v1/comment`；内部路由 `POST /v1/event-sync`；运营路由 `POST /v1/admin/review/reject`。

* 节点配置 `BASE_REVIEW_KEY`。

* `internal/httpapi` 新增 `comment.go`（读接口与投影解析）；`internal/store` 新增评论投影与墓碑、游标方法。

* 靶向护栏：`fetch` 拒绝拉回墓碑中的 `payload_cid`；`scrub` 跳过之（§4.5）——这是**既有处理器的行为收紧**，不新增路由。

* 客户端 `HttpAdapter.post`、`src/core/comment.ts`、`pages/comment/comment` 落地、文章页评论入口、`core/comment.ts` 的待锚定态。

### 2.3 对总纲的回填（本册子通过后一并改）

| 总纲位置 | 现状 | 回填为 |
|---|---|---|
| §9 写路径 | 「节点签发 `event_id`（ULID）」 | **「客户端自带 `event_id`（16 hex），节点只登记、不签发」**（与 S1 落地一致，§0.2 #8） |
| §9 「事件通用结构」 | `{type, target_id, actor, payload, causal_parent}` | 补一句：落地形态为 `{event_id, type, created_at, body}` + 事件内容签名 `sig`；`actor` 即签名头的 `id`；`causal_parent` 由 `body.reply_to` 表达 |
| §7.3 公开读表 | 无 `GET /v1/comment` | 补一行（§4.2） |
| §7.3 写接口表 | `POST /v1/event` 未提签名域 | 补「事件体含内容签名 `sig`，覆盖 `canonical({event_id,type,created_at,body})`」 |
| §7.3 内部表 | 无事件同步 | 补 `POST /v1/event-sync`（§4.4） |
| §7.3 运营表 | 只有 `review/fetch` | 补 `POST /v1/admin/review/reject`（§4.3） |

### 2.4 对 S1 册子与发布册子的回填

* `2026-09-26-base-identity-tls-design.md` §5.6 只写了「本册子只落地验签管线与落库骨架，不定义任何事件类型」；「B 阶段只需往该表登记类型，管线与本处理器都不用改」这句过于乐观的预判出现在**落地代码注释**里（`internal/httpapi/event.go` 与 `internal/store/event.go` 的包内注释）。**实测该预判不成立**：B 阶段需要给事件体加 `sig`、给 `events` 表加三列、并在 `handleEventPost` 内按类型写投影。

  * §5.6 应补一条回填：「B 阶段会登记类型、扩展事件体与表列、并在处理器内按类型写投影」。

  * 上述两处代码注释在实施阶段一并订正（本册子只记录，不改生产代码）。

* `2026-09-27-base-mobile-release-design.md` §7 的阻塞项表逐条处置：

| 阻塞项 | 处置 |
|---|---|
| 事件类型登记 | **本册子解决**（§3.1） |
| 事件读接口 | **本册子解决**（§4.2） |
| 评论正文上行 | **本册子解决**（正文随事件内联，§3.3） |
| 事件传播 | **本册子解决**（§4.4） |
| 审核 | **本册子解决**（§4.3） |
| 圈子成员 / 组密钥 / ② 类加密 | **仍阻塞**，总纲 C 阶段，圈子 tab 继续占位 |

* 该册子 §7「本版只渲染一个占位状态」的表述随之收窄为**只适用于圈子**；评论 tab 由本册子落地。

## 3. 事件模型

### 3.1 类型登记

`knownEventTypes` 由「构造时赋空」改为「从包级注册表拷贝」：

```go
// internal/httpapi/event.go
// eventTypeRegistry 是节点放行的事件类型表。
// 新增类型 = 在此加一行 + 在 validateEventBody 里加一个分支，不改管线。
var eventTypeRegistry = map[string]struct{}{
    "comment.v1": {},
}
```

* 未登记类型 → **400 `event_type_unknown`**（语义与 S1 一致，不新增错误码）。

* 本册子只登记 `comment.v1`。进度、私信等类型的登记归各自册子。

### 3.2 `comment.v1` 事件体

线上请求体（`POST /v1/event`）：

```json
{
  "event_id": "a1b2c3d4e5f60718",
  "type": "comment.v1",
  "created_at": 1790000000000,
  "body": {
    "target_id": "article/hello-base",
    "text": "正文明文（UTF-8）",
    "reply_to": "0011223344556677"
  },
  "sig": "<128 hex>"
}
```

| 字段 | 约束 |
|---|---|
| `body.target_id` | 必填，ASCII，长度 1..=256，路径式命名空间（总纲 §6.0） |
| `body.text` | 必填，UTF-8 字节长度 1..=`maxCommentBytes`（8192） |
| `body.reply_to` | 可选，16 hex；**不校验被回复事件是否存在**（跨节点时序，§8 风险 8） |
| `sig` | 必填，128 hex，事件内容签名（§3.4） |

* `actor` 即签名头的 `X-Base-Id`，不在 `body` 里重复。

* `maxCommentBytes = 8192` 远小于 `maxJSONBody = 64 KiB`，两者不冲突。

### 3.3 正文与 `payload_cid`

节点在**验签通过之后**执行：

1. `payload_cid = hex(sha256(utf8(text)))[0:32]`（与总纲 §3.2 同算法，① 类逻辑字节 = 明文）。
2. 写块 `data/blobs/<h0..1>/<h2..3>/<payload_cid>`；**已存在即跳过**（同文天然同 id，天然幂等）。
3. `events.body_json` 存**减化形态**，不含 `text`：

```json
{ "target_id": "article/hello-base", "payload_cid": "<32 hex>", "reply_to": "0011223344556677", "sig": "<128 hex>" }
```

* 正文只在块里存一份，读时走 `GET /v1/blob/{payload_cid}`，与内容包的块共用同一套反熵、秒传、副本因子。

* 该设计正是总纲 §9 写路径的字面描述：**验签 → 存正文 blob → 落事件**。区别仅是「同一个请求内完成」，客户端不经过一个独立的写块接口。

### 3.4 事件内容签名 `sig`（本册子的关键补齐）

签名头（S1）覆盖的是**一次 HTTP 请求**：`canonical({method, path, query, body_sha256, ts, nonce})`。它绑定了方法、路径、时间戳与 nonce，**无法在事件被反熵搬到另一个节点后重新验证**——ts 早已超出 ±300s 窗口，且重放会命中 nonce 去重。

因此事件需要一层**与请求无关的内容签名**：

```
sig = Ed25519_sign(actor_priv, utf8(canonicalize({ event_id, type, created_at, body })))
```

* 键名全为 ASCII（`event_id` / `type` / `created_at` / `body` / `target_id` / `text` / `reply_to`），`canonicalize` 可用；`created_at` 为有限整数；`text` 是中文值，**键的 ASCII 限制不影响值**。

* 节点在 ingest 时：请求签名头保证**准入**（身份已登记、非重放），内容签名保证**归属**（这条事件确实由该身份所写）。二者都要，缺一即拒绝。

* 节点用签名头的 `id` 对应公钥验 `sig`；不符 → **403 `event_sig_invalid`**。

* 事件被搬到 B 节点后，B 只需 `GET /v1/identity/{actor}?` 的公钥即可独立验签——这正是内容签名存在的理由。

* **重新验签的路径**：`sig` 覆盖含 `text` 的完整 `body`，而 `text` 在块里仍可取（① 类明文），故任何持有该块的节点/客户端都能重建待验字节。

* 本册子**不实现**客户端侧验签（§1 不做），但签名字节入库，后续可验。

### 3.5 顺序与游标

* 事件**没有** Merkle root，也没有全局单调序号。`event_id` 是客户端随机 16 hex，不可排序。

* 读与传播一律用**节点本地 `received_at` + `event_id`** 复合游标（`received_at ASC, event_id ASC`）。

* `received_at` 由接收节点用本机 `now` 生成，且 `PutEvent` 的 `ON CONFLICT` **不覆盖**它（保留首次值，S1 落地即如此）——这是游标单调推进的前提。

* 时钟回拨护栏：写游标时若 `now <= cursor_ts`，取 `cursor_ts + 1`，保证游标严格递增。

## 4. 节点接口

### 4.1 `POST /v1/event`（扩展，客户端监听）

在既有准入（签名头 + 已登记身份 + 16 hex `event_id` + `created_at > 0`）之后，按 `type` 分流：

```
type == "comment.v1":
  1. 校验 body 三字段（§3.2）；不合法 → 400 event_param_invalid
  2. 校验 sig（§3.4）；不符 → 403 event_sig_invalid
  3. event_id 若已在 comment_tombstone → 400 event_revoked
  4. 算 payload_cid 并落块（§3.3）
  5. 写 events 行（event_id, id=actor, type, body_json, created_at, received_at,
                   target_id, payload_cid, reply_to）
  6. 200 {"event_id", "payload_cid", "received_at"}
```

* **幂等**：同 `event_id` 重复提交 → `PutEvent` 覆盖，不产生第二行（S1 既有行为）。第二次提交的 `payload_cid` 若不同，以最后一次为准（同 id 不同正文属客户端异常，节点不做额外裁决）。

* **限速**：按 `X-Base-Id` + 客户端 IP 双维度，形态复用 `internal/httpapi` 既有的 `ipLimiter`。超限 → **429 `event_rate_limited`**（新错误码）。

* 未登记类型的行为、错误码、响应形状**一律不变**。

### 4.2 `GET /v1/comment`（新，公开读，匿名）

| 参数 | 必填 | 说明 |
|---|---|---|
| `target_id` | 否 | 缺省 = 全站最新 |
| `cursor` | 否 | 不透明串 `<created_at>_<event_id>`，由上一页的 `next_cursor` 原样带回 |
| `limit` | 否 | 默认 30，上限 100；非法值回落到默认 |

响应：

```json
{
  "comments": [
    { "event_id": "…", "actor": "…32 hex…", "target_id": "article/hello-base",
      "payload_cid": "…32 hex…", "reply_to": "…" | null, "created_at": 1790000000000 }
  ],
  "next_cursor": "1790000000000_a1b2c3d4e5f60718" | null
}
```

* 只返回 `type = 'comment.v1'`；排序固定 `created_at DESC, event_id DESC`（最新在前，`target_id` 有无都一样）。

* **过滤墓碑**：`NOT EXISTS (SELECT 1 FROM comment_tombstone t WHERE t.event_id = e.event_id)`。客户端因此不需要知道墓碑的存在。

* 正文**不在**此接口；客户端对每条 `payload_cid` 取 `GET /v1/blob/{payload_cid}`（匿名，已存在）。

* 不返回公钥与昵称：需显示昵称时另取 `GET /v1/identity/{actor}`（§9 未闭环）。

### 4.3 审核（新，运营密钥）

**密钥**：节点配置环境变量 `BASE_REVIEW_KEY`。

* **未配置该变量 → 两条审核路由根本不注册**（对客户端监听返回 404）。与「内部路由不进 publicMux」同一条红线：不存在比「存在但被拦」更安全。

* 已配置 → 请求必须带 `X-Base-Review-Key`，与配置值做**定长比较**（`subtle.ConstantTimeCompare`）。不符 → 404（不暴露路由存在性）。

**`POST /v1/admin/review/fetch`**

```json
{ "payload_cid": "<32 hex>" }
```

* 从块目录读明文，返回 `200 {"payload_cid", "text"}`。

* 块不存在（已被删或从未有过）→ `404 blob_not_found`。

* 节点**不校验**该块是否属于 `comment.v1`——审核只需按 `payload_cid` 取证（与总纲 §7.3 一致）。

**`POST /v1/admin/review/reject`**

```json
{ "event_id": "<16 hex>", "reason": "自由文本，可选" }
```

1. 查 `events` 得 `payload_cid`；无此行 → `404 event_not_found`。
2. 写 `comment_tombstone(event_id, payload_cid, reason, at, received_at)`；已存在则覆盖（幂等）。
3. **删本地块** `data/blobs/…/<payload_cid>`（不存在即跳过）。
4. `200 {"event_id", "payload_cid"}`。

### 4.4 `POST /v1/event-sync`（新，**只挂对端监听**）

红线段落同 `mountInternal`：一旦挂到 `publicMux` 就等于把事件库暴露给任意客户端。鉴权沿用 `X-Base-Node-Key`。

请求：

```json
{ "kind": "event" | "tombstone", "after": { "ts": 0, "id": "" }, "limit": 200 }
```

响应（`kind = "event"`）：

```json
{
  "items": [ { "event_id": "…", "id": "<actor>", "type": "comment.v1",
               "body_json": "…", "created_at": 0, "received_at": 0 } ],
  "next": { "ts": 1790000000000, "id": "a1b2c3d4e5f60718" } | null
}
```

响应（`kind = "tombstone"`）：

```json
{
  "items": [ { "event_id": "…", "payload_cid": "…", "reason": "…", "at": 0, "received_at": 0 } ],
  "next": { "ts": …, "id": … } | null
}
```

* 排序固定 `received_at ASC, event_id ASC`，严格大于 `after`；`next = null` 表示本 kind 已拉完。

* 拉取方把 `next` 存进 `peer_sync_cursor(peer, kind, …)`，下一轮从它继续。

* 落库：`kind=event` → `PutEvent`（本地 `received_at = now`，**不用对端的值**；对端的值只进游标）；`kind=tombstone` → upsert 墓碑，并**主动删本地同 `payload_cid` 的块**。

* 幂等：`PutEvent` 与墓碑 upsert 都幂等，重复拉取无副作用。

* 传播闭环：A → B → A 的第二轮因游标已推进而不再重复；即使重复也无副作用。

### 4.5 审核删块与反熵的相互作用（护栏）

总纲 §7.4 定「`extra` 仅记录，不主动删除」。若照此执行，A 节点删掉的评论块会被反熵从 B 节点**拉回来**——删除失效。因此需要三条护栏：

1. **拉取前过滤**：`POST /v1/fetch` 请求中的 `blob_id` 若命中 `comment_tombstone.payload_cid`，该块**不返回**（跳过，其余照常）。

2. **落库前过滤**：接收方写块前再查一次墓碑，命中即丢弃（防对端是未收到墓碑的旧节点）。

3. **scrub 跳过**：`scrub` 遇到墓碑中的块不做「坏块 → 从邻居补齐」，直接删除本地副本。

护栏只收紧行为，不改既有请求/响应契约。三处都要查同一张 `comment_tombstone`。

## 5. 节点数据层

### 5.1 `events` 表加列（含迁移）

```sql
-- 新库：直接建在 CREATE TABLE 里
-- 已有库：列存在性检查（PRAGMA table_info(events)）→ 缺列则逐条 ALTER
ALTER TABLE events ADD COLUMN target_id   TEXT;   -- 仅 comment.v1 有值
ALTER TABLE events ADD COLUMN payload_cid TEXT;
ALTER TABLE events ADD COLUMN reply_to    TEXT;

CREATE INDEX IF NOT EXISTS idx_events_target   ON events(target_id, created_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_events_recent   ON events(created_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at ASC, event_id ASC);
```

* 迁移**必须幂等**：`schema.go` 现有语句全是 `CREATE TABLE/INDEX IF NOT EXISTS`，不会补列，所以列检查是必需的（不是可选优化）。

* 生产 `events` 表目前为空（`knownEventTypes` 恒空，从未写入），迁移风险为零；但代码仍须按通用情形写。

### 5.2 新表

```sql
CREATE TABLE IF NOT EXISTS comment_tombstone(
  event_id    TEXT PRIMARY KEY,
  payload_cid TEXT NOT NULL,
  reason      TEXT,
  at          INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comment_tombstone_cid ON comment_tombstone(payload_cid);
CREATE INDEX IF NOT EXISTS idx_comment_tombstone_recv ON comment_tombstone(received_at, event_id);

CREATE TABLE IF NOT EXISTS peer_sync_cursor(
  peer       TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- 'event' | 'tombstone'
  cursor_ts  INTEGER NOT NULL,
  cursor_id  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(peer, kind)
);
```

* 墓碑的 `received_at` 与事件同口径（接收节点本机 `now`），供 `kind=tombstone` 游标使用。

### 5.3 store 新增方法

| 方法 | 语义 |
|---|---|
| `PutEvent`（扩展） | 结构体加 `TargetID` / `PayloadCID` / `ReplyTo` 三个可空字段，写入对应列 |
| `ListComments(targetID string, cursor int64, cursorID string, limit int) ([]CommentRow, error)` | `targetID == ""` 时不过滤；倒序；联表排除墓碑 |
| `GetEventByID(eventID string) (Event, bool, error)` | 审核 `reject` 用 |
| `PutCommentTombstone(t CommentTombstone) error` | upsert |
| `IsRevokedPayload(cid string) (bool, error)` | `fetch` / `scrub` / 落块三处护栏共用 |
| `ListRevokedPayloads() (map[string]struct{}, error)` | 批量护栏用（可按需缓存） |
| `ListEventsAfter(ts int64, id string, limit int) ([]Event, error)` | `kind=event` 增量 |
| `ListTombstonesAfter(ts int64, id string, limit int) ([]CommentTombstone, error)` | `kind=tombstone` 增量 |
| `GetPeerCursor(peer, kind string) (ts int64, id string, err error)` / `PutPeerCursor(peer, kind string, ts int64, id string) error` | 游标持久化（写入时套用 §3.5 的严格递增护栏） |

## 6. 客户端

### 6.1 新增与改动

| 位置 | 改动 |
|---|---|
| `src/platform/adapter.ts` | `HttpAdapter` 增 `post(url, body: Uint8Array, headers?: Record<string,string>): Promise<HttpResponse>`（非 2xx 不抛错，与 `get` 一致） |
| `src/platform/uni.ts` | 实现 `post`（`uni.request`，`ArrayBuffer` 收发，与既有 `get` 同构） |
| `src/core/comment.ts`（新） | `ensureRegistered()`、`listComments()`、`fetchCommentText()`、`postComment()`、`setPendingTarget()` / `takePendingTarget()` |
| `src/core/comment.test.ts`（新） | 用 `core/fakes.ts` 的假 `HttpAdapter` 覆盖下述四条路径 |
| `src/pages/comment/comment.vue` | 占位 → 落地（§6.2） |
| `src/pages/article/article.vue` | 加「评论」入口（§6.3） |
| `src/pages.json` | 评论页已在 tabBar 中（0.3.0 定案），**本册子不改 `pages.json`** |

**`ensureRegistered()`**：本地身份存在但节点侧未登记时，调 `POST /v1/identity/register`（匿名，无签名头）→ 成功后置本地标记 `identity.registered = '1'`（存 `config`）。失败不阻断阅读，只让评论功能不可用。

**`postComment({ targetId, text, replyTo? })`**：

1. 取本地身份（无则按 S1 生成）。
2. `ensureRegistered()`。
3. 组 `body = { event_id: random16hex(), type: 'comment.v1', created_at: Date.now(), body: { target_id, text, reply_to? } }`。
4. `sig = sign(seedHex, utf8(canonicalize(body)))`；请求体 = `{...body, sig}`。
5. 用 `signRequestHeaders(ident, {method:'POST', path:'/v1/event', body: bytes})` 生成 5 个签名头，`post`。
6. 200 → 返回 `{eventId, payloadCid}`；非 2xx → 按 `code` 映射成用户可读提示。

**`listComments({ targetId?, cursor? })`**：`GET /v1/comment`，把 `next_cursor` 原样传回。

**`fetchCommentText(payloadCid)`**：`GET /v1/blob/{payloadCid}` → UTF-8 解码。**取正文失败的单条降级为「正文暂不可用」占位**，不让一条坏数据打断整页。

### 6.2 评论页（`pages/comment/comment`，tab）

* 顶部一行选择器：`全部最新`（默认）+ 本地已下载内容列表（来自 `listItems()`，**零网络**）。

* 列表：每条显示 `actor` 前 8 位 + 相对时间 + 正文 + （若有）被回复者的前 8 位；正文按纯文本渲染，不做 markdown。

* 分页：滚到底加载 `next_cursor`。

* 底部输入框 + 「发表」：仅在选定某个 `target_id` 时可用；选「全部最新」时输入框置灰并提示「选择一项内容后可以评论」。

* 空态：「还没有评论」。

* **`target_id` 跨 tab 传递**：tab 页不能带 query。文章页把 `target_id` 写进 `core/comment.ts` 的模块级待锚定态，`uni.switchTab` 到评论页，评论页 `onShow` 调 `takePendingTarget()` 消费并清空。

### 6.3 文章页入口

阅读器底部加「评论」按钮 → `setPendingTarget(item_id)` → `uni.switchTab({ url: '/pages/comment/comment' })`。

* 不显示评论数（需要额外请求；§9 未闭环）。

### 6.4 失败与离线语义

| 情形 | 行为 |
|---|---|
| 未配节点地址 | 评论页显示「未配置节点」，不报错 |
| 网络失败 / 超时 | 列表区显示「无法连接节点，请稍后重试」+ 重试按钮；**不打断其它 tab** |
| `identity_unregistered` / 登记失败 | 发表时提示「身份未就绪，请重试」 |
| `event_rate_limited` | 提示「发言过于频繁」 |
| `event_revoked` / `event_sig_invalid` | 提示「该评论已被处理」/「提交被拒绝」，不重试 |
| 离线 | 列表不可用（无本地缓存，§1）；发表不可用 |

**红线：评论页的任何失败都不得影响课程、答题、我的三个 tab。** 评论是新增的可选能力，不能成为 DoS 客户端的入口。

## 7. 验收

| # | 验收项 | 判定 |
|---|---|---|
| 1 | 类型登记 | `POST /v1/event` 带 `type=comment.v1` → 200；带其它 `type` → 400 `event_type_unknown` |
| 2 | 正文落块 | 发表后返回 `payload_cid`；`GET /v1/blob/{payload_cid}` 取回的字节 == 原文 UTF-8 |
| 3 | 幂等 | 同 `event_id` 连发两次 → `events` 只有一行；`GET /v1/comment` 只出现一条 |
| 4 | 归属签名 | 篡改 `text` 一位后重签请求头但**不重签 `sig`** → 403 `event_sig_invalid` |
| 5 | 准入 | 未登记身份直接写 → 403 `identity_unregistered`（S1 既有行为不回归） |
| 6 | 公开读·按内容 | 对某 `target_id` 发 3 条 → `GET /v1/comment?target_id=…` 返回 3 条，最新在前；`limit=2` 时 `next_cursor` 可续取 |
| 7 | 公开读·全站 | 不发 `target_id` → 返回跨内容的混合列表，倒序 |
| 8 | 跨节点传播 | A 节点写一条 → 触发一轮反熵 → B 节点 `GET /v1/comment` 可见该条，且 B 能取到正文块 |
| 9 | 审核·取正文 | 配 `BASE_REVIEW_KEY` 后 `review/fetch` 返回明文；密钥错 → 404 |
| 10 | 审核·未配置 | 不配 `BASE_REVIEW_KEY` 的节点上两条审核路由 → 404 |
| 11 | 审核·闭环 | `review/reject` 后：列表不再返回该条；`GET /v1/blob/{cid}` → 404；再跑一轮反熵**不复活** |
| 12 | 反熵护栏 | B 节点仍持有被删块时，A 节点 `fetch` 该 `blob_id` → 不在响应中；`scrub` 后 A 本地仍无该块 |
| 13 | 客户端·浏览 | 评论 tab 显示全站最新；选某内容后显示该内容评论；正文正确解码中文 |
| 14 | 客户端·发表 | 文章页「评论」→ 跳到评论 tab 且已锚定该文章 → 发表成功 → 列表出现 |
| 15 | 客户端·降级 | 节点不可达时评论 tab 显示重试提示；课程/答题/我的三 tab 完全不受影响 |
| 16 | 圈子占位不回归 | 圈子 tab 仍显示未开放说明，无报错、无假数据 |
| 17 | 单测与迁移 | §5.3 各方法、`event-sync` 游标推进与幂等、墓碑过滤、`events` 列迁移幂等（空库与旧库两种输入）全绿 |

## 8. 风险与红线

1. **明文 HTTP 上的写请求可被旁观**（总纲 F1 已知代价）。处置 = 签名；旁观者可读正文但**不可伪造、不可冒用身份**。评论正文在链路上是明文，须写入隐私提示。

2. **公开即全网可复制**：① 类评论一旦发出，任何节点与客户端都能留存副本，**除审核删外无法撤回**。这是模式固有前提（总纲 §3 铁律 2），不是缺陷。用户提示里必须说清「评论是公开的」。

3. **删块与反熵的复活窗口**（§4.5）：护栏覆盖 `fetch` / 落块 / `scrub` 三处；若某节点尚未收到墓碑，它仍持有该块——但任何**新**拉取都会被护栏拦下，故不会扩散回已删节点。遗留副本只能等该节点收到墓碑后自行删除。

4. **游标依赖本机时钟**（§3.5）：`received_at` 由本机 `now` 生成。若系统时钟被回拨，游标可能停滞。处置 = 写游标时强制严格递增（`now <= cursor_ts` 时取 `cursor_ts + 1`），代价是时钟回拨期间新事件的 `received_at` 略偏离真实时间（仅影响排序观感，不影响正确性）。

5. **客户端不验签**：客户端只信任本节点的返回，因此一个恶意节点可以伪造任意 `actor` 的评论并展示给客户端。缓解 = 签名字节已入库，客户端验签（含公钥缓存）是明确的后续项（§9）。本册子接受的取舍是：**先让评论跑通，再补端到端验签**。

6. **存储滥用**：内联正文上限 8 KiB + 按身份/IP 限速，但**没有总量配额**。一个登记身份可以持续灌入 8 KiB 评论，且这些块会随反熵扩散到邻居。处置优先级见 §9——不在本册子。

7. **评论离线不可用**：无本地缓存（§1）。这是刻意的取舍：缓存评论就要处理「墓碑到达后删本地缓存」「离线看到的旧评论 vs 在线权威列表」两套冲突语义，成本远高于收益。代价必须写进用户提示。

8. **`reply_to` 不校验存在性**：跨节点时序下被回复事件可能尚未到达，客户端需对悬空回复降级显示（只显示 id 前缀）。不视为缺陷。

9. **审核路由的存在性即信息**：已按「未配密钥则 404」处理（§4.3），且密钥不符也返回 404。任何「403 + 明确提示」的实现都算红线。

10. **评论页是新入口**：其失败必须隔离在自身 tab 内（§6.4 红线）。任何让评论请求阻塞启动或影响其它 tab 的实现都算红线。

## 9. 待定与未闭环

* **圈子**：② 类加密、组密钥、成员名单全部未动。这是四 tab 里最后一个占位，且需要先改总纲的 C 阶段边界。

* **客户端端到端验签**：需要 `actor → pubkey` 的本地缓存与 `GET /v1/identity/{id}` 的批量取法（当前一次一个）。属独立优化项。

* **昵称与身份展示**：现在只显示 `id` 前 8 位。需要一个「用户名 / 昵称 → id」的展示层来源。

* **离线评论队列**：总纲 §8.1 的 `events_out(local_id, type, target_id, payload_path, state, retry)` 表本册子不建；离线写评论、联网补报（总纲 §10 B 阶段验收项「离线写讨论 → 联网补 `event_id`」）留待后续。

* **评论附件与图片**：需要独立的 `PUT /v1/blob` 写接口及其限速/配额。本册子刻意不引入该面。

* **存储配额与 GC**：孤儿块（写了块但事件落库失败）与长期无人引用的块需要回收策略；以及邻居反熵的存储放大。属节点运维项。

* **审核工具化**：当前是手工 HTTP 调用；批量审核、申诉、恢复（撤销墓碑）都没有。

* **举报与点赞**：需要新的类型（`report.v1` / `like.v1`），以及「计数」这类需要合并语义（LWW / 求和）的事件——与 append-only 评论不同，须单开册子。（**已解挂**：2026-10-06 册子 #79 单开，事件模型 / LWW 计数 / 审核举报列表见该册 §3–§5；其 §0.3 如实登记三处取证修正）

* **`GET /v1/me` 的 `progress`**：S1 落地时恒为空数组；学习进度上报仍未闭环，本册子不涉及。

* **评论数展示**：文章页不显示评论数（需额外请求或节点侧计数接口）。

* **`event-sync` 的规模上限**：当前按 `received_at` 游标增量拉取，未做「对端已无新数据」的短路协商，每轮至少一次请求。事件量进入十万级后需要 revisit（例如引入事件集的 Merkle root 做先比对后拉取）。
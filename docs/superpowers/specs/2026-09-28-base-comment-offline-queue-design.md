# base 评论离线发表队列与在线拉取约定设计

* 日期：2026-09-28

* 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）

* 直接上游：

  * `specs/2026-09-27-base-comment-event-sync-design.md` §6（客户端约定）与 §9 待定项「离线评论队列」（总纲 §8.1 的 `events_out`、§10 B 阶段验收「离线写讨论 → 联网补 `event_id`」）

  * `specs/2026-09-27-base-selfcheck-design.md` §4（能力标志与降级）、§11（不影响面红线）

* 范围：**纯客户端**。离线入队 · 联网补发 · 待发项展示与删除 · 自检探测 10 判定口径修正

* 本册子**不覆盖**：节点侧任何改动（接口 / 表 / 错误码一律不动）；他人评论的本地缓存；后台自动补发与推送；网络状态监听；待发项编辑；点赞 / 举报；圈子

## 0. 改版说明

### 0.1 2026-09-28 初版

**新增（本册子首次定义）：**

* 本地新表 `comment_out` 与其 `LocalRepo` 方法（§3）

* `core/comment.ts` 的 `sendComment`（纯发送）/ `flushPending`（补发编排），以及 `postComment` 的离线兜底（§4）

* 队列项两态与失败分类口径（§5）

* 评论页待发区、「离线仅显示待发」提示、失败项删除出口（§6）

* 自检探测 10 的「网络不可达 → `skip`」修正（§7）

**明确沿用、不改动：**

* `POST /v1/event` 的准入（签名头 + 已登记身份）与 `event_id` 幂等（`ON CONFLICT(event_id)`）——**节点零改动**，补发就是重放

* `CommentError` 的错误码与用户可读文案映射（`core/comment.ts` 的 `mapPostFailure`）

* `GET /v1/comment` 的 `target_id` / `cursor` / `limit` 分页与 `created_at DESC, event_id DESC` 排序

* `blob_id = hex(sha256(逻辑字节))[0:32]` 与 `sig = Ed25519_sign(actor, canonical({event_id,type,created_at,body}))`（上上册 §3.3 / §3.4）

* 「只有明确 `fail` 才降级，`unknown` 不降级」的取值约定（自检册 §4）

* 「评论不落本地缓存、离线列表不可用」的刻意取舍（上上册 §1、§8 风险 7）——本册子只把**自己的待发**补进离线视图

### 0.2 定案记录（2026-09-28 问答结论）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 队列存储形态 | 存**已签名的完整请求体字节**（wire 文本）；`event_id` / `created_at` / `sig` 全部冻结，补发 = 逐字节重放，节点侧天然幂等 |
| 2 | 补发时机 | **进评论页 `onShow` + 页面「重试」按钮**；不引入 `uni.onNetworkStatusChange`，不做后台任务 |
| 3 | 失败处置 | **分类处置**：以 `CommentError.code` 分「永久失败」与「暂时保留」（§5.2） |
| 4 | 在线拉取 | 进页面 / 下拉刷新即拉最新；**不缓存他人评论**；离线时列表只显示本地待发 |

## 1. 目标与判定

| # | 目标 | 判定 |
|---|---|---|
| 1 | 离线也能写评论，不丢字 | 断网发表 → 立即出现在「待发送」；杀进程重开仍在 |
| 2 | 联网后不重复、不重排 | 补发用原 wire，节点 `event_id` 幂等；列表只出现一条，`created_at` 仍是发表时刻 |
| 3 | 永久失败不吞字、不刷屏 | 标「发送失败 + 原因」，不再自动重试，原文与目标可见，可手动删除 |
| 4 | 不污染既有路径 | 节点零改动；评论页失败仍隔离在自身 tab（上上册 §6.4 红线） |

**非目标**：不做后台 / 定时自动补发，不做推送与角标，不做他人评论缓存，不做待发项编辑，不做队列配额与 TTL。

## 2. 实现取向（三选一，取 A）

| 取向 | 做法 | 取舍 |
|---|---|---|
| **A（采用）** | 本地 SQLite 新表 `comment_out` + `LocalRepo` 新方法 | 与 `items` / `blob_index` / `user_state` 同一套事务与测试假件（`MemoryRepo`）；`bootstrap()` 每次启动执行 `SCHEMA_SQL`，老装机升级即自动补表，**无需迁移代码** |
| B | 队列塞进 `config` 的一段 JSON | 不建表，但整段读写、并发覆盖、排序与体量全在应用层手搓，且滥用 KV 语义 |
| C | 队列落到文件 `_doc/base/comment-out/*.json` | 绕开 DB schema，但要 fs + db 两套能力，`fsOk` 失败即队列全废，还得自己做原子写与清理 |

## 3. 本地队列表

### 3.1 建表（追加到 `repo.ts` 的 `SCHEMA_SQL`）

```sql
CREATE TABLE IF NOT EXISTS comment_out(
  event_id   TEXT PRIMARY KEY,
  target_id  TEXT NOT NULL,
  text       TEXT NOT NULL,
  reply_to   TEXT,
  wire       TEXT NOT NULL,      -- 已签名的完整请求体（UTF-8 JSON 文本）
  state      TEXT NOT NULL,      -- 'pending' | 'failed'
  reason     TEXT,               -- state='failed' 时的用户可读原因
  queued_at  TEXT NOT NULL       -- 入队时刻 ISO8601，排序用
);
CREATE INDEX IF NOT EXISTS idx_comment_out_queued ON comment_out(queued_at);
```

* **迁移**：`bootstrap()` 每次启动逐条执行全部 `SCHEMA_SQL`（`platform/index.ts:29`），新表靠 `CREATE TABLE IF NOT EXISTS` 自动补上；**这是新增表而不是给旧表加列，故不需要列存在性检查**（与节点侧 `events` 加列的情形不同）。

* **`wire` 用 TEXT 存**：JSON 是 UTF-8 文本，SQLite TEXT 即原字节；补发时 `utf8(wire)` 还原。**必须逐字节相同**——`sig` 覆盖的是 `canonicalize` 出来的确定字节序，任何重排都会让 `sig` 失效。存文本正是为了锁住这一点。

* `text` / `target_id` / `reply_to` 冗余存一份，只为**离线展示待发项**（不解析 wire），避免「展示解析」与「发送字节」两份逻辑。所有列在入队后不再变更，无一致性风险。

* 不存 `created_at` / `retry`：前者在 wire 内且展示用 `queued_at` 即可；后者无重试上限，计数没有功能用途（YAGNI）。

### 3.2 `LocalRepo` 新方法（4 个）

| 方法 | 语义 |
|---|---|
| `enqueueComment(row: CommentOutRow): Promise<void>` | `INSERT ... ON CONFLICT(event_id) DO NOTHING`（同 `event_id` 重复入队无副作用） |
| `listCommentOut(): Promise<CommentOutRow[]>` | 全部，按 `queued_at ASC`（先入队先补发） |
| `markCommentOutFailed(eventId: string, reason: string): Promise<void>` | 置 `state='failed'` 与原因（单向：失败项不会回到 pending） |
| `removeCommentOut(eventId: string): Promise<void>` | 删一条（用户对失败项点「删除」，或补发成功后清行） |

`CommentOutRow` 定义在 `core/types.ts`：`{ eventId, targetId, text, replyTo: string | null, wire: string, state: 'pending' | 'failed', reason: string | null, queuedAt: string }`。

* `MemoryRepo`（`core/fakes.ts`）必须同步实现这 4 个方法——它是 `LocalRepo` 的手写假件，测试**不经过** `MemoryDb` 的 SQL 解析，因此本册子不给 `MemoryDb` 加任何 SQL 支持。

## 4. `core/comment.ts` 改动

### 4.1 拆出 `sendComment`（纯发送，不落队列）

现在「构造 wire → 组签名头 → POST」全在 `postComment` 内（`comment.ts:152-193`）。拆成：

```ts
export interface CommentInput {
  targetId: string;
  text: string;
  replyTo?: string;
  /** 补发专用：已签名的完整请求体文本。传入即逐字节重放，不重算 event_id / sig（§3.1）。 */
  wire?: string;
  /** 与 `wire` 配套的 event_id（传入 wire 时必填）。 */
  eventId?: string;
}

/** 直接发送一条评论：构造（本地）→ 登记 → POST /v1/event。失败抛 CommentError。不落本地队列。 */
export async function sendComment(o: CommentOptions, input: CommentInput): Promise<{ eventId: string; payloadCid: string }>

/** 发表一条评论：sendComment 失败且为网络不可达时入队，返回 queued=true。 */
export async function postComment(o: CommentOptions, input: CommentInput): Promise<{ eventId: string; payloadCid: string | null; queued: boolean }>
```

* `sendComment` 内部顺序不变：`ensureRegistered()` → 本地构造（`event_id` / `created_at` / `sig` / 签名头）→ `POST`。构造段抽成私有 `buildCommentWire(ident, input)`，返回 `{ eventId, wireText }`。

* **`sendComment` 是补发与自检探针共用的唯一发送入口**。自检探测 10 从 `postComment` 改为 `sendComment`（§7），否则离线跑自检会把 `selfcheck` 事件塞进用户队列。

### 4.2 `postComment` 的离线兜底

```
1. 若 nodeBaseUrl === '' → 抛 CommentError('client', '未配置节点地址，无法发表')   // 不入队
2. try  sendComment(o, input)                                        → 成功返回 { queued: false }
3. catch e:
     e.code === 'network'  → 入队（若入队时报错则原样抛出）→ 返回 { eventId, payloadCid: null, queued: true }
     其它                  → 原样抛出（沿用上上册 §6.4 的既有文案）
```

* **入队条件严格限定为「网络不可达」**：节点给了任何 HTTP 响应（4xx / 5xx）都不入队，而是把既有错误文案直接给用户——此时用户就在页面上、草稿仍在输入框里，立即重试比静默入队更清楚。

* **未配置节点不入队**（`nodeBaseUrl === ''` 时 `uni.request` 也会表现为网络失败，若不拦会把队列变成永远发不出去的垃圾桶）。

* 入队前 `event_id` 已生成且 `sig` 已算好，故 `queued_at` 与事件的 `created_at` 只差毫秒级；`created_at` 以 wire 内的值为准。

### 4.3 `flushPending`（补发编排）

```ts
export interface FlushResult { sent: number; failed: number; remaining: number; error: string }
export async function flushPending(o: CommentOptions): Promise<FlushResult>
```

```
1. nodeBaseUrl === '' → 直接返回全 0（不报错）
2. 模块级 inflight 守卫：已有进行中的 flush 则复用它（并发调用只跑一轮）
3. rows = repo.listCommentOut()（queued_at ASC）；只处理 state === 'pending' 的行
4. 逐条 sendComment(o, { targetId, text, replyTo: row.replyTo ?? undefined, wire: row.wire, eventId: row.eventId })：
     —— 传 `wire` 即逐字节重放冻结的请求体（`sig` 不重算）；**请求签名头每轮新算**（`ts` 一次性、`nonce` 会被节点去重），故只重放 body 字节
     成功         → repo.removeCommentOut(eventId)；sent++
     永久失败     → repo.markCommentOutFailed(eventId, msg)；failed++
     暂时失败     → 保留 pending；error = msg；remaining++ **并中止本轮**
5. 返回 { sent, failed, remaining, error }
```

* **不抛错**：补发结果只经返回值与页面文案体现，绝不打断调用方（上上册 §6.4 红线：评论页的失败不得影响其它 tab）。

* **暂时失败即中止本轮**：网络刚断或已被限速时，后续条目必然同错；中止省掉一串无用请求。下次进页面继续。

* **补发不读能力标志**：`writeOk` 只由用户主动跑自检更新，可能已经过期；用它拦住补发会让「节点恢复正常但仍显示旧标志」变成永久卡死。标志只用于拦**用户主动发表**（自检册 §4）。

* 已 `failed` 的行**永不自动重试**，只能由用户删除。

## 5. 队列语义

### 5.1 两项状态

| 状态 | 含义 | 出口 |
|---|---|---|
| `pending` | 待发送 / 上次暂时失败 | 下次 `flushPending` 继续；成功后删行 |
| `failed` | 节点明确拒绝，重发无意义 | 页面显示原因 + 「删除」；不自动重试 |

内存中不设「发送中」持久态：补发是顺序执行的短过程，无需落盘。

### 5.2 失败分类（本册唯一判定函数）

**适用范围**：本表描述的是**补发（`flushPending`）**阶段遇到各类错误的处置。**首次发表只对 `network` 入队**，节点给了任何 HTTP 响应都不入队（§4.2）。

```ts
function isPermanentFailure(e: unknown): boolean {
  return e instanceof CommentError && (e.code === 'revoked' || e.code === 'rejected');
}
```

| 来源（节点错误码 → `CommentError.code`） | 分类 | 处置 |
|---|---|---|
| 网络不可达 / 超时 → `network` | — | **首次发表**：入队；**补发中**：保留 `pending` 并中止本轮 |
| `event_revoked` → `revoked` | 永久 | `failed`，提示「该评论已被处理」 |
| `event_sig_invalid` / `event_param_invalid` / `event_type_unknown` → `rejected` | 永久 | `failed`，提示「提交被拒绝」 |
| `event_rate_limited` → `rate_limited` | 暂时 | 保留 `pending`（本轮中止，下次再试） |
| `identity_unregistered` / 登记非 200 → `unregistered` | 暂时 | 保留 `pending` |
| 其它非 2xx → `server` | 暂时 | 保留 `pending` |
| 本地构造 / 解析失败 → `client` | 暂时 | 保留 `pending`（不丢用户写的字） |

## 6. 评论页改动（`pages/comment/comment.vue`）

* **待发区**（在线列表之上，`v-if="pending.length > 0"`）：标题「待发送 N 条」；每条显示「目标内容标题 · 正文」，右侧状态为「待发送」或「发送失败：<reason>」；失败项带「删除」；区内一个「**立即补发**」按钮（触发 `flushPending` 后刷新）。与在线列表错误态的既有「重试」按钮区分开，避免两个同名按钮。

* **待发区不随 `target` 过滤**，始终显示全部待发项，每条标注目标标题。理由：待发项是「尚未生效的本地状态」，按当前选中内容过滤会造成「切到另一条内容就以为没待发了」的错觉。目标标题取自既有 `ctx.repo.listItems()`（零网络），找不到则显示 `target_id`。

* **离线时**：在线列表沿用既有文案「无法连接节点，请稍后重试」+「重试」；若同时存在待发项，额外显示一行「离线，仅显示待发送」。不新增分支语言，只在既有错误态上加一行。

* **发表**：`postComment` 返回 `queued === true` → 清空草稿、`notice = '已保存，联网后自动补发'`、刷新待发区；返回 `queued === false` → 既有「已发表」+ 刷新列表。其余错误沿用既有 `notice` 文案。

* **未配置节点**：composer 一并禁用（`:disabled="unconfigured || target === ''"`，`canSend` 也加 `!unconfigured`），避免「未配置 → 假装离线入队」。

* **`onShow` 顺序**：`load()` → 渲染待发区 → `await refresh()`（在线列表）→ `void flush()`（**不 await**，不让补发阻塞首屏）→ 补发结束后（`sent + failed > 0`）刷新待发区，`sent > 0` 时再 `refresh()` 一次。

* 页面直接调 `ctx.repo.listCommentOut()` / `removeCommentOut()`（与既有 `ctx.repo.listItems()` 同惯例），不为「列一次 / 删一条」在 `core/comment.ts` 再造薄封装。

## 7. 自检探测 10 的判定口径修正（关键）

**现状**（自检册 §3 第 10 条）：向 `target_id=selfcheck` 发一条自检事件并拿到 200 回执 → 计入 `writeOk`；`PROBES` 里该条 `flag: 'writeOk'`，任一条 `fail` 即 `writeOk='fail'`。

**问题**：离线时跑自检 → 探测 10 必然失败 → `writeOk='fail'` → 评论页发表按钮被禁用 → **本册子的离线入队直接被自己禁掉**。

**修正口径**（三态重写）：

| 探测 10 的实际结果 | 判定 |
|---|---|
| 200 回执 | `ok`（detail 保留 `event_id` 前 8 位） |
| 节点给出明确响应（4xx / 5xx，链路是通的） | `fail`（真不可写） |
| 网络不可达 / 超时（`CommentError.code === 'network'`） | **`skip`**，detail「节点不可达，未探测」 |

* `skip` 不计入标志（自检册既有规则）→ `writeOk` 保持 `unknown` → 不降级 → 发表可用 → 离线入队可用。

* 判据落地：探针内 `catch` 到 `code === 'network'` 的 `CommentError` 时抛既有的 `ProbeSkip`（`selfcheck.ts` 已用于「未配置节点」那条），其它错误照旧由探针框架记为 `fail`。

* 探测 10 的调用从 `postComment` 换成 `sendComment`（§4.1）：探针**不得**把 `selfcheck` 事件写进用户待发队列，也不应受 `postComment` 的兜底逻辑影响。

* 其余 11 条探测、`cryptoOk` / `fsOk` / `dbOk` 的判定与「只有明确 fail 才降级」的约定一律不变。

## 8. 测试

`apps/mobile/src/core/comment.test.ts`（Node + `MemoryRepo` + `FakeHttp`）：

| # | 用例 | 断言 |
|---|---|---|
| 1 | 离线发表入队 | `post` 抛错 → `postComment` 返回 `queued=true`、`payloadCid=null`；`listCommentOut()` 1 行 `pending`；`targetId` / `text` / `replyTo` 与入参一致 |
| 2 | 在线发表不入队 | `post` 200 → `queued=false`；队列为空 |
| 3 | 节点明确拒绝不入队 | `post` 500 → 抛 `CommentError('server')`；队列为空（草稿留给页面，用户可原地重试） |
| 4 | 未配置节点不入队 | `nodeBaseUrl=''` → 抛错且队列为空 |
| 5 | 补发成功且字节一致 | 先入队 2 条，**清空 `FakeHttp.posted`**，再让 `post` 返回 200 → `sent=2`、队列空；断言补发阶段 `posted` 收到的字节 == 入队时存的 `utf8(wire)`（证明 `sig` 未被重算） |
| 6 | 补发永久失败 | `post` 403 `event_sig_invalid` → 该行 `state='failed'`、`reason` 含「提交被拒绝」、仍在队列；`flushPending` 不抛 |
| 7 | 补发暂时失败即止 | 队列 3 条、清空 `posted` 后 `post` 抛网络错 → `sent=0`、三条仍 `pending`、**补发阶段 `posted.length === 1`**（中止本轮） |
| 8 | 并发只跑一轮 | 队列 2 条、清空 `posted`，同时调两次 `flushPending` → 补发阶段 `posted.length === 2`（不翻倍） |
| 9 | 删除失败项 | `removeCommentOut` → 列表少一条 |

`apps/mobile/src/core/selfcheck.test.ts` 追加：

| # | 用例 | 断言 |
|---|---|---|
| 10 | 探测 10 网络不可达 | `post` 抛错 → 该条 `skip`、`writeOk` 仍 `unknown`、`canPostComment` 仍为真；**且 `listCommentOut()` 为空**（探针不污染队列） |
| 11 | 探测 10 节点明确拒绝 | `post` 403 → 该条 `fail`、`writeOk='fail'` |

* 既有 85 项单测、`npx tsc --noEmit`、`npm run build:app` 必须全绿（不回归）。

## 9. 真机验收

| # | 验收项 | 判定 |
|---|---|---|
| 1 | 断网发表 | 提示「已保存，联网后自动补发」，待发区出现该条，输入框清空 |
| 2 | 杀进程重开 | 待发区仍有该条（落盘验证） |
| 3 | 联网进评论页 | 自动补发 → 待发区清空 → 在线列表出现该条，且**只有一条**、时间显示为发表时刻 |
| 4 | 离线跑自检 | 探测 10 为 ➖（未探测），评论页发表按钮**仍可用** |
| 5 | 失败可见 | 造一条永久失败（篡改本地 wire 使 `sig` 失效后补发）→ 标「发送失败：提交被拒绝」，原文仍在，可「删除」 |
| 6 | 不干扰 | 离线与失败期间，课程 / 答题 / 我的三 tab 完全正常 |

## 10. 风险与已知取舍

| # | 风险 / 取舍 | 处置 |
|---|---|---|
| 1 | 补发后评论「插进旧位置」：`created_at` 冻结在发表时刻，`GET /v1/comment` 按 `created_at DESC` 排序，故离线写了三天的评论补发后不在列表顶部 | **这是期望语义**（评论时刻不因补发而变），写进文档，不做修正 |
| 2 | 队列无上限、无 TTL：可无限离线攒评论 | 单条 ≤ 8 KiB、只存本机、需用户主动发表；不做配额（YAGNI），记入节点运维项之外的本机存储项 |
| 3 | 待发区不随 `target` 过滤 | 刻意（§6）：不让用户误以为「没待发了」 |
| 4 | `failed` 项需人工删除，否则永久留在列表 | 永久失败本就该被看见；提供唯一出口「删除」 |
| 5 | 本地库含 `wire`（正文 + 内容签名 `sig`） | 与文章正文同级明文，不新增保护面。**wire 不构成可重放凭据**：请求签名头的 `ts` 已过 ±300s 窗口、`nonce` 会被节点去重，第三方拿到 wire 也无法为其生成新的合法签名头 |
| 6 | 「网络不可达」在 `uni.request` 层可能表现为各种裸错误而非明确的离线信号 | 入队判据用 `CommentError('network')`（`sendComment` 已把 `http.post` 的抛错统一映射为它），不依赖平台离线 API；代价是「DNS 失败 / 节点 502」也会入队——二者都属「请求未成功送达语义」，可接受 |
| 7 | 探测 10 口径修正会改变 0.5.0 已发布行为 | 仅在「网络不可达」时由 `fail` 改判 `skip`，属修正（否则离线入队自相矛盾）；原机升级后行为变化见 §7 |
| 8 | 队列与 `applyPack` 无交互，内容被墓碑撤下后其待发评论仍会补发 | 评论的 `target_id` 是路径式命名空间字符串，节点不校验目标存在性（上上册 §3.2）；同理接受 |

## 11. 不影响面（红线）

* **节点侧零改动**：不新增 / 不改动任何接口、表、列、错误码、限速与反熵行为。

* 不改 `GET /v1/comment` 的游标与排序语义；**不引入他人评论的本地缓存**。

* 不引入网络状态监听（`uni.onNetworkStatusChange`）、不做后台任务、不做推送与角标。

* 不改既有同步（`core/sync.ts`）、升级（`core/update.ts`）的任何语义。

* 自检页其余 11 条探测与 `cryptoOk` / `fsOk` / `dbOk` 判定不变；只改探测 10 的三态归属与调用入口。

* 评论页任何失败（含补发失败）都不得影响其它 tab（上上册 §6.4 红线）。

* 不引入新的外部依赖。
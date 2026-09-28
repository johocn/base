# base 审批治理设计（治理主线 第 3 册）

- 日期：2026-09-28
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）；册子 #23 `specs/2026-09-28-base-contribution-roles-design.md`（名册语义与契约出口）；册子 #25 `specs/2026-09-28-base-submission-design.md`（第 2 册，本册的拒绝口径来源）；册子 #5 `specs/2026-09-26-base-content-distribution-design.md`（墓碑与 `revoked_rev` 语义）
- 范围：**他人条目的下架、改写与复活的审批授权** —— 提案 → 授权票达门槛（`remove` 3 票、`edit` / `revive` 2 票）→ 生效
- 本册子**不覆盖**：创作 UI（第 4 册）；成员治理（拉黑 / 封禁 / 举报 / 申诉）；跨节点提案同步；审核队列；评论审核（#19 的 `BASE_REVIEW_KEY` 通道，只作用于评论）；内容分发与墓碑机制本身（#5 已定，本册只调用）

## 0. 改版说明

### 0.1 2026-09-28 初版

**新增（本册子首次定义）：**

- 审批授权模型：受审动作三选一（`remove` / `edit` / `revive`）、受审对象口径、提案人与投票人资格、门槛与冷启动（§2）
- 三个契约入口：`POST /v1/proposal`（签名写）、`POST /v1/proposal/{proposal_id}/vote`（签名写）、`GET /v1/proposal`（匿名公开读）（§3）
- 三个动作的落地语义与「改写必然影响归属」的后果登记（§4）
- 生效事务与前置条件判定（§4.4）
- 两张新表 `govern_proposals` / `govern_votes`（§5）
- 11 条新错误码（§6）

**答掉上游点名的两处开放项（#23 §8.1、§8.2）：**

| 开放项 | 本册结论 |
|---|---|
| #23 §8.1 冷启动死锁（≥2 人审批不成立） | **挂起，零破例**：名册人数不足该动作的门槛时提案恒不达标（`remove` 需 3 人、`edit` / `revive` 需 2 人，§2.4） |
| #23 §8.2 授权票绑定哪个节点的名册 | **本节点自治**：提案与票只存本节点、不跨节点；资格按本节点实时名册判（§2.5） |

**明确沿用、不改动：**

- `author_sig` 的待签字节定义（#23 §2.1 契约出口）——本册**不新增、不改动任何签名域**，因此**不新增契约向量**（§3.4）
- `GET /v1/contributors` 的名册语义与 `store.ContributorRoster()` 的派生口径（#23 §4.4、§5.1）
- 写路径鉴权一律走既有 `internal/httpapi/authmw.go`（签名头 + 300s 时间窗 + nonce 防重放），**不新增鉴权形态**
- `items` / `articles` / `quizzes` 的既有列与 `items.state` 的既有取值（`active` / `removed`）
- 内容包规范 v1 的字段与包级签名；`blob_id` 算法与其输入；`revoked_rev` 语义（#5 §9.1）
- 可见性仍只有 `dist_class` 一维
- 写限速复用既有 `ipLimiter`

### 0.2 2026-09-28 门槛分层更正

**作废：** §2.1 与 §2.4 原定的「三个动作同一门槛（2 票）」。

**改为：** `remove` 需 **3 票**；`edit` / `revive` 保持 **2 票**。

**理由：** 下架是三个动作里唯一**切断分发**的一步（源节点虽按 §4.1 保留内容行与块，但接收侧一应用墓碑就删行删块），而且它的唯一补偿手段是 `revive`——复活本身还要**依赖对端在线补齐**（§4.3）。破坏面与恢复代价都最大，故单独抬高一票。

**连带改动：** §2.4 的冷启动论证补肾到 `remove` 情形；§4.4 的门槛判定改为按动作取值；`GET /v1/proposal` 新增 `threshold` 字段（客户端不必硬编码按动作的常量，可直接渲染「已 2/3 票」）；§8 的测试与 AC 拆成两档。

## 1. 范围与不做什么

**做四件事：**

1. 定义**谁有权动别人的条目**：提案人必须是治理者，授权票达到该动作的门槛即生效，资格以本节点实时名册为准。
2. 定义**三个受审动作**及其落地：`remove`（写墓碑）、`edit`（覆盖标题/正文）、`revive`（撤回墓碑、复活条目）。
3. 定义**生效事务**：把有效票数推到该动作门槛的那一张票落库时，在同一事务内执行动作；前置条件不满足则作废。
4. 定义**公开可读的治理面**：任何一方（含未登录）都能看到「有哪些提案、谁提的、谁投的、当前是几票」。

**明确不做：**

- **不做创作 UI**：节点页与手机端的治理入口、提案表单、投票界面归第 4 册；本册只交数据面。
- **不做成员治理**：不拉黑、不封禁、不处理举报、无申诉通道（沿用 #23 §1）。
- **不做跨节点提案同步**：提案与票不进 `events`、不参与反熵、不留跨节点痕迹（§2.5）。
- **不做提案的过期与撤回**：提案一经提交不可改、不可撤、不过期（§3.1）。
- **不做同目标动作去重**：同一 `item_id` 的同一动作可以并存多个提案（§2.1）。
- **不做治理者操作日志与审计视图**：治理面就是 `GET /v1/proposal` 本身，不另存审计表（沿用 #23 §1）。
- **不开运营后门**：持 `BASE_SIGN_KEY` 的节点运维方**不**获得绕过审批直接改写/下架的能力（第 2 册 §3.3 已明确不放行；运营仍走导入器，那是内容注入，不是治理）。
- **不复用 `BASE_REVIEW_KEY`**：那条通道只作用于评论，是节点运维方的单方动作，与自治治理是两个模型（§7）。
- **不改 `author_sig` 签名域**：不新增 `base/gov-v1` 之类的治理签名域（§3.4）。
- **不设内容下限**：与第 2 册一致，`edit` 载荷只设上限（§3.1）。

## 2. 授权模型

### 2.1 受审动作（三选一）

| `action` | 语义 | 门槛 | 目标 `state` 前提（受理时与生效时都判） |
|---|---|---|---|
| `remove` | 下架：写墓碑 + 置 `state='removed'` | **3 票** | `state = 'active'` |
| `edit` | 改写：覆盖 `title` / `body_md` | **2 票** | `state = 'active'` |
| `revive` | 复活：删墓碑行 + 置 `state='active'` | **2 票** | `state = 'removed'` |

- **门槛分两档，按动作取值**（§0.2 更正）：`remove` 单独抬到 3 票，因为它是三个动作里唯一**切断分发**的一步，且唯一的补偿手段 `revive` 还要依赖对端在线补齐——破坏面与恢复代价都最大。`edit` 与 `revive` 都不让内容从网络上消失，保持 2 票。
- **提案人对任何动作都只提供 1 票。** 于是 `remove` 的 3 票意味着「提案人 + 至少 2 名其他治理者」。
- **不去重**：同一 `item_id` 的同一动作可并存多个提案，各自独立计票。先达标的先执行；后达标时因前置条件不再满足而呈 `void`（§4.4）。不做去重的理由：去重要么引入「同 (item_id, action) 唯一」的额外约束与冲突分支，要么引入幂等合并语义，收益仅为少几条冗余行。

### 2.2 受审对象

**受审对象是「不属于提案人」的条目**，判定只看 `items.author_id`：

| 目标的 `items.author_id` | 是否可被提案 |
|---|---|
| `= 提案人` | **拒绝** → `403 item_self_owned`，并指向第 2 册的 `POST /v1/submit`（自己改自己走签名写路径，不需要审批） |
| `≠ 提案人`（他人） | 可 |
| `空`（导入器与 `tools/migrate` 的存量内容） | **可** |

- **空归属条目可治，且治理改写不产生任何归属**：第 2 册 §3.1 拒的是「投稿认领下来污染名册」，而治理改写**不会**凭空造出 `author_sig`——改完仍是无归属、仍不计贡献。两者不冲突。
- 若不允许治理空归属条目，则导入错的内容在本册没有任何出口（原件无法改、投稿又拒），故必须放行。
- 判定与 `state` 无关：墓碑条目同样可以被 `revive` 提案（这正是复活的入口），而 `remove` / `edit` 对墓碑条目会被 `item_state_mismatch` 拒绝。

### 2.3 提案人与投票人资格（名册实时复判）

| 项 | 规则 |
|---|---|
| 提案人 | 必须是**提交时刻**本节点名册内的治理者；否则 `403 proposer_not_governor` |
| 提案人自计票 | 签名提案**即自动构成第 1 票**（受理事务内同写一行 `govern_votes`） |
| 投票人 | 必须是**投票时刻**本节点名册内的治理者；否则 `403 voter_not_governor` |
| 重复投票 | 同一身份对同一提案只能有一票（主键挡住）→ `409 already_voted` |
| 资格来源 | 一律调用既有 `store.ContributorRoster()`（#23 §4.4 口径），**不新造身份体系、不缓存名册** |

**票的时效：实时复判。** 一张票的有效性 = 「此刻该投票人仍在本节点名册内」：

- 投票落库时判一次（资格校验）；
- **每次计票（含生效判定与 `GET /v1/proposal` 展示）再判一次**；
- 投票人跌出前 10 → 其票即时失效；重新入榜 → 其票即时恢复。

这与 #23 §4.4「不存名册、无任期；跌出前 10 **立即**失去治理者身份」严格自洽。代价是票数可能自发回退（某人跌出 → 提案退回未达标），这是**正确行为**，不是缺陷。

### 2.4 门槛与冷启动

| 项 | 规则 |
|---|---|
| 门槛 | `remove` **3 票**；`edit` / `revive` **2 票**。提案人在任一动作下都只贡献 1 票 |
| 名册人数 < 该动作门槛 | **挂起，零破例**：提案可创建，但有效票数恒不达门槛，永不生效 |
| 名册人数 ≥ 该动作门槛 | 正常判定 |

**为什么「挂起」不造成实际阻塞**（答 #23 §8.1）：

- **`edit` / `revive` 需 2 人**：名册 < 2 意味着本节点至多只有 1 个有归属内容的作者。他自己的条目归第 2 册（`POST /v1/submit`），不需要审批；需要审批的「他人有归属条目」在这种节点上**根本不存在**；剩下只有空归属的存量条目，它们是运营注入内容的修正，而运营路径（导入器 / `tools/migrate`）仍然可用，不属于治理范畴。
- **`remove` 需 3 人**：名册 < 3 时下架提案恒不达标。这**不**意味着该节点有内容改不掉（`edit` 仍可用），只意味着它在凑齐 3 名治理者之前无法让任何条目从分发中消失。
- 两档门槛都只看「本节点名册人数」，**不引入运维方指定初始名册**这类破例。

**「零破例」的直接代价（显式登记）：** 名册长期停留在 1–2 人的节点**没有任何下架能力**，即便某条内容明显有害。缓解只有一条：名册随内容增长自然扩张——出现第 3 个达门槛作者（1 篇 ≥200 字的文章即可，§23 §4.3）即解锁 `remove`。本册接受这个代价，把它记进 §9。

### 2.5 域：本节点自治（答 #23 §8.2）

- **提案与票只存本节点**：不进 `events`、不参与反熵、不跨节点同步。零新同步通道。
- **资格按本节点实时名册判**：授权票绑定的就是「本节点名册」。
- **同一提案在不同节点的判定可以不同**：这不构成矛盾——提案**只存在一个节点上**，跨节点传播的是治理的**结果**（墓碑 / 新版本内容），不是提案本身。接收节点按既有 `content_version` / `revoked_rev` 口径裁决（#5 §9.2、§9.4），它信任的是发行节点的**包级签名**，与「谁投了票」无关。
- 这条边界与总纲 §6.5「墓碑只能在签名 manifest 中传播，节点无法伪造」完全一致：治理决定的是**本节点签什么**，签名与传播仍是既有机制。

## 3. 契约边界

### 3.1 `POST /v1/proposal`（签名写路径）

走既有 `requireAuth`，与评论写路径、`POST /v1/profile`、`POST /v1/submit` 同一条鉴权路。

请求体：

```json
{
  "action": "edit",
  "item_id": "article/<aid>",
  "reason": "可选短文本",
  "edit": { "title": "新的标题", "body_md": "新的 Markdown 正文" }
}
```

- `edit` 字段**仅**在 `action = "edit"` 时有意义；其它动作携带时**一律忽略**（与第 2 册对 `content_hash` 的「携带即忽略」同口径）。
- `reason` **可选**，缺省空串。给定时：去首尾空白后长度 1..200（rune）、不含控制字符（U+0000–U+001F、U+007F）；不通过 → `400 proposal_reason_invalid`。

**`edit` 载荷是全量替换，不是补丁**：`title` 与 `body_md` 都必填，生效时整体覆盖目标条目。没有「只改其中一项」的合并语义——要只改标题，就把原正文原样再传一遍。

`201 Created`：

```json
{ "proposal_id": "7", "action": "edit", "item_id": "article/<aid>", "vote_count": 1, "threshold": 2, "status": "pending" }
```

**硬约束：**

- 提案人**只能**取自鉴权中间件解析出的身份。请求体**不得**携带 `proposer_id` / `author_id`——否则等于替他人提案。违反 → `400 author_id_forbidden`（沿用第 2 册的既有码，不新造）。
- `action` 取 `remove` / `edit` / `revive` 三者之一；其余 → `400 proposal_action_unsupported`。
- `item_id` 必须是本节点 `items` 表中**已存在**的条目；不存在 → `404 item_not_found`。不限定前缀（本册对 `course/...` 与 `article/...` 一视同仁——治理对象是「已存在的条目」，不是「可投稿的形态」）。
- 目标 `items.author_id == 提案人` → `403 item_self_owned`。
- 动作与目标当前 `state` 不匹配（`remove`/`edit` 需 `active`；`revive` 需 `removed`）→ `400 item_state_mismatch`。
- `edit` 载荷：`title` 校验同第 2 册（去首尾空白后 1..200 rune、不含控制字符）→ 不合规 `400 proposal_edit_invalid`；`title` + `body_md` 的 UTF-8 字节之和超过 `maxSubmitBytes`（32768，**复用第 2 册的既有常量**）→ `413 proposal_too_large`。
- **受理时记录目标 `content_hash` 快照**（写入提案行的 `base_content_hash`），供生效时判前置条件（§4.4）。
- **不过期、不可改、不可撤**：提案一经提交即固定，没有修改或删除接口。

### 3.2 `POST /v1/proposal/{proposal_id}/vote`（签名写路径）

同样走 `requireAuth`。请求体为空（或 `{}`）。

```json
{ "proposal_id": "7", "vote_count": 2, "threshold": 2, "status": "effective" }
```

- 投票人取自鉴权身份，**请求体不得携带投票人 id**（违反 → `400 author_id_forbidden`）。
- `proposal_id` 不存在 → `404 proposal_not_found`。
- 投票人不在当前名册 → `403 voter_not_governor`。
- 已投过（含提案人投自己的提案）→ `409 already_voted`。
- **投票请求可能带副作用**：若这一票把有效票数推到**该动作的门槛**（`remove` 3 票、`edit` / `revive` 2 票），则**在同一事务内**执行动作（§4.4）。`status` 因此可能是 `pending` / `effective` / `void` 三者之一。
- 返回体固定带 `threshold`，客户端据此渲染「已 N/M 票」，**不得**硬编码按动作的常量。

### 3.3 `GET /v1/proposal`（匿名公开读）

与 `GET /v1/contributors` / `catalog` / `manifest` / `pack` 同级，**无需登录、无需签名头**。

```json
{
  "proposals": [
    {
      "proposal_id": "7",
      "action": "edit",
      "item_id": "article/<aid>",
      "proposer_id": "<32 位 hex>",
      "reason": "标题有错别字",
      "title": "新的标题",
      "body_md": "新的 Markdown 正文",
      "status": "pending",
      "votes": ["<id1>"],
      "vote_count": 1,
      "threshold": 2,
      "created_at": 1790580918,
      "executed_at": 0,
      "voided_at": 0
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `status` | 派生值，见 §4.4 |
| `votes` | **当前有效票**的投票人 id 列表（实时复判后）；已失效的票不出现在这里 |
| `vote_count` | `len(votes)` |
| `threshold` | 该动作的门槛（`remove` 为 3，`edit` / `revive` 为 2）。随提案一并返回，使客户端不必硬编码按动作的常量 |
| `title` / `body_md` | 仅 `action = "edit"` 时非空；其余动作恒为空串 |
| `executed_at` | 生效时间戳；未生效为 `0` |
| `voided_at` | 作废时间戳；未作废为 `0` |

- **按 `proposal_id` 升序返回全部提案**（含已生效与 `void` 的），**不分页、不支持过滤**。理由：提案人必须是治理者（≤10 人），提案总量天然受「人数 × 条目数 × 3 动作」约束，量级可控。
- **返回 `edit` 载荷正文**：投票人必须先看到「自己正在批准什么」才能投票，而本册没有独立的提案详情接口，故列表接口一并返回。这是列表接口不做分页的另一原因（§9 风险 6）。
- **不返回条目清单、不返回签名、不返回任何 IP 或客户端标识。**

### 3.4 不可改（本册最硬的三处）

1. **`author_sig` 的待签字节定义**（#23 §2.1 的五个键与 `canonical_json`）——本册**不新增签名域、不改任何签名域**，因此**不新增契约向量**（`vectors/v1/` 不动）。若将来有人提议为治理动作新增签名域，那是改契约，不属于本册。
2. **`items.state` 的既有取值**（`active` / `removed`），不新增第三个状态。
3. **`revoked_rev` 语义**（#5 §9.1：撤回生效的全局 `content_version`，与 `source_rev` 不做比较）——本册 `remove` 写墓碑时按既有口径取 `store.NextContentVersion()` 作为 `revoked_rev`（与 `internal/importer/md.go` 的退役路径同一写法）。

## 4. 三个动作的落地

### 4.1 `remove`（下架）

- 调用既有 `store.RetireItem(item_id, NextContentVersion())`：写 `tombstones` 行（`revoked_rev` 取大值覆盖）+ 置 `state='removed'`。
- **只置状态不删行**（既有实现口径）：内容行与块文件保留在源节点，因此 `revive` 后仍能重新导出。
- 跨节点传播走既有路径：下次导出时该 `item_id` 出现在签名 manifest 的 `tombstone[]` 中，接收侧按 #5 §9.2 应用（删行 + 删块文件）。
- **`state='removed'` 使该条不计贡献**（#23 §4.2 只计 `state='active'`）——即下架会抽走原作者的贡献。这是既有效果，本册只是新增了一条**能触发它**的授权路径。

### 4.2 `edit`（改写）——本册最需要登记的一处后果

`edit` 生效时**全量覆盖**目标的 `title` 与 `body_md`，并按既有口径重算 `content_hash`（`hex(sha256(body_md 的 UTF-8 字节))`，第 2 册 §2.2）、`source_rev` 取 `content_hash[:16]`、`updated_at` 刷新。`state` 保持 `active`、`dist_class` 保持 `public`。

**归属后果由 `content_hash` 是否变化决定，不由「改了哪个字段」决定**：

| 生效后的 `content_hash` | `items.author_id` / `author_sig` | 归属 | 理由 |
|---|---|---|---|
| **与旧值相同**（正文逐字节未变，只改了标题） | **原样保留** | **保持** | `title` 不在签名域内（第 2 册 §7.1 已登记的缺口），旧签名仍然成立 |
| **与旧值不同**（正文被改动） | **两列都清空** | **清零**（该作者贡献 −1） | `author_sig` 绑定的是 `content_hash`，正文一变旧签名必然失效——这是 #23 §2.1 契约的**数学推论**，不是本册的新政策 |

- **治理者不能代签**：本册不提供任何「以治理者身份为改写后的条目署名」的能力，清空后**没有认领路径**（与第 2 册 §3.1 拒认领一致）。要恢复归属，只能由原作者本人走 `POST /v1/submit` 重签。
- **这条后果必须显式登记**，否则极易被误当成 bug：一次经 `edit` 档 2 票批准的正文改写，会顺手抹掉原作者的这一份贡献。
- `edit` **不产生**任何归属：治理者不因改写而获得贡献，「治理」不是一种贡献载体（#23 §4.3 的三种载体不含治理动作）。

### 4.3 `revive`（复活）

- 生效时：`DELETE FROM tombstones WHERE item_id = ?`，并置 `state='active'`。内容行与块文件原本就还在（§4.1），无需重新导入。
- **必须递增全局 `content_version`**：接收侧判定「已撤回的 `item_id` 重新出现在 `entries[]` 中」时，要求它出现在**更大**的 `content_version` 的 manifest 里，否则按防回卷拒绝入库（#5 §9.2 第 4 条）。导出时用全局计数器自增（`Options.Version = 0` 的既有路径）即可满足；实现只需保证复活之后确实发生过一次新的导出，不需要新通道。
- **复活后接收侧需要重新拿到块**：接收侧在应用墓碑时已删掉块文件（#5 §9.2 第 3 条），复活后的内容要靠既有反熵补齐。这意味着**复活不保证即时可用**——对端离线时，内容要等下一轮反熵（§9 风险 4）。
- 复活同样使该条重新计入贡献（`state` 回到 `active` 且归属列若有值）。

### 4.4 生效事务与前置条件

**两个一次性事实落库（`executed_at` / `voided_at`），其余全是派生值。** 之所以必须落库而不是派生：名册是实时复判的，票数会因治理者进出榜而回退再恢复；若靠「票数达门槛且未执行」来派生，就分不清「票一直够、只是前置不满足」与「票曾回退、恢复后无人再触发判定」这两种情形。

生效触发点：**每一张票落库的那次请求**。记该动作门槛为 **T**（`remove` = 3，`edit` / `revive` = 2），在同一 SQL 事务内按下表判定：

| 步 | 动作 |
|---|---|
| 1 | 读该提案；若 `executed_at != 0` 或 `voided_at != 0` → 已定案，提交事务，不做任何事 |
| 2 | 读该提案全部 `govern_votes`，派生本节点当前名册（`ContributorRoster()`），过滤出**当前仍有效**的票 |
| 3 | 有效票数 < T → 提交事务，不执行任何动作 |
| 4 | 有效票数 ≥ T 且**前置条件不满足** → 写 `voided_at`，提交事务，**不执行动作** |
| 5 | 有效票数 ≥ T 且前置条件满足 → 执行动作（§4.1 / §4.2 / §4.3）+ 写 `executed_at` / `executed_result`，提交事务 |

**前置条件（三个动作共用同一组判定）：**

1. 目标 `items` 行**仍然存在**；
2. 目标当前 `state` 与动作匹配（`remove`/`edit` 需 `active`；`revive` 需 `removed`）；
3. **目标当前 `content_hash` == 提案的 `base_content_hash`**。

第 3 条是本册的**乐观锁**：提案是「针对某一版内容的授权」。若受理之后目标内容被改动（原作者用 `POST /v1/submit` 更新了它、或另一个提案改写了它），则该授权所针对的版本已不存在，**永久作废**（写 `voided_at` 后不再重判）。这避免了「按一份过期的授权，覆盖掉作者刚写的新正文」这类静默破坏。

**`GET /v1/proposal` 的 `status` 派生规则：**

| `status` | 条件 |
|---|---|
| `effective` | `executed_at != 0` |
| `void` | `voided_at != 0` |
| `pending` | 两者皆 `0`（含有效票数不足门槛、名册人数不够门槛而恒不达标、以及票曾达标但因名册波动回退等一切「尚未生效」的情形） |

- `pending` **不承诺**该提案将来一定会生效：若本节点再无新的治理者入场，票数不会再变，也就不会再有请求去触发判定（§9 风险 3）。
- `void` 是**终态**：一旦写入不再重判。多张提案作用于同一目标时，先执行者改变目标状态或 `content_hash`，后者的前置条件随即不满足 → 后者呈 `void`。

## 5. 数据落点与复用

### 5.1 两张新表

```
CREATE TABLE IF NOT EXISTS govern_proposals(
  proposal_id       INTEGER PRIMARY KEY,
  action            TEXT    NOT NULL,
  item_id           TEXT    NOT NULL,
  proposer_id       TEXT    NOT NULL,
  reason            TEXT    NOT NULL DEFAULT '',
  title             TEXT    NOT NULL DEFAULT '',
  body_md           TEXT    NOT NULL DEFAULT '',
  base_content_hash TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  executed_at       INTEGER NOT NULL DEFAULT 0,
  voided_at         INTEGER NOT NULL DEFAULT 0,
  executed_result   TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS govern_votes(
  proposal_id INTEGER NOT NULL,
  voter_id    TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY(proposal_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_govern_proposals_item ON govern_proposals(item_id, action);
```

- 两张表都是 `CREATE TABLE IF NOT EXISTS`，**不需要 `ALTER` 迁移**（`internal/store/schema.go` 的既有 `schemaStatements` 路径直接可用；#23 §3.1 那种「列存在性检查 + 逐条 ALTER」的补列流程**本册用不上**）。
- `proposal_id` 用本地自增整数（`INTEGER PRIMARY KEY`），对外以十进制字符串呈现。提案**不跨节点**，无需全局唯一。
- `base_content_hash` 是受理时目标 `content_hash` 的快照（§3.1、§4.4）。
- `executed_result` 记一句机器可读的结果说明（如 `removed` / `edited` / `edited_author_cleared` / `revived`），供 `GET /v1/proposal` 与人排障用；它是诊断信息，**不构成契约**。
- 表只增不减，本册不做归档与清理（§9 风险 6）。

### 5.2 复用清单（零改动）

| 能力 | 复用点 |
|---|---|
| 鉴权 | `internal/httpapi/authmw.go` 的 `requireAuth`（签名头 + 时间窗 + nonce） |
| 名册派生 | `store.ContributorRoster()`（#23 §4.4） |
| 写限速 | 既有 `ipLimiter`（按身份 + 按 IP 双维度） |
| 下架 | `store.RetireItem()` + `store.NextContentVersion()` |
| 传播 | `internal/packexport` 导出 + 既有反熵；本册**不改导出侧** |
| 落地盘 | 既有 SQLite store；不引入新进程、不引入定时器 |

## 6. 降级与错误处理

所有错误按契约 §3.3 的形状返回 `{"error": "<人读消息>", "code": "<机器码>"}`。任何人读文案都不构成契约，客户端只依赖 `code`。

**本册新增：**

| code | HTTP | 触发 |
|---|---|---|
| `proposal_action_unsupported` | 400 | `action` 不是 `remove` / `edit` / `revive` |
| `proposal_reason_invalid` | 400 | `reason` 给定但去首尾空白后为空、超 200 rune，或含控制字符 |
| `proposal_edit_invalid` | 400 | `action = "edit"` 但 `title` 缺失/不合规（去首尾空白后空、超 200 rune、含控制字符），或 `body_md` 缺失 |
| `proposal_too_large` | 413 | `title` + `body_md` 的 UTF-8 字节之和超过 `maxSubmitBytes`（32768） |
| `item_not_found` | 404 | 目标 `item_id` 在本节点 `items` 中不存在 |
| `item_self_owned` | 403 | 目标 `items.author_id` == 调用者（自己改自己应走 `POST /v1/submit`） |
| `item_state_mismatch` | 400 | 动作与目标当前 `state` 不匹配（`remove`/`edit` 需 `active`；`revive` 需 `removed`） |
| `proposer_not_governor` | 403 | 提案人不在提交时刻的本节点名册内 |
| `proposal_not_found` | 404 | 投票的 `proposal_id` 不存在 |
| `voter_not_governor` | 403 | 投票人不在当前本节点名册内 |
| `already_voted` | 409 | 该身份对本提案已投过票（含提案人投自己的提案） |
| `govern_rate_limited` | 429 | 超过写限速 |

**沿用既有（不重复定义）：** `auth_missing_header`(400)、`identity_id_invalid`(400)、`auth_ts_out_of_window`(401)、`auth_nonce_replay`(401)、`auth_bad_signature`(401)、`identity_unregistered`(403)、`auth_body_too_large`(413)、`auth_body_read_failed`(400)、`author_id_forbidden`(400，请求体携带身份字段)。

**降级铁律：**

1. 任何失败都**不写入、不覆盖**：不存在「半条」提案、也不存在「动作执行了一半」——执行与 `executed_at` 同事务。
2. 生效判定与展示**永不因为名册派生失败而中断**：取名册出错时按「有效票 = 0」降级处理（提案停在 `pending`），并在日志告警；**不**因此拒绝提案或投票请求。
3. **前置条件不满足时静默不执行**，不走错误分支：投票请求照样返回成功（票确实写入了），只是 `status` 呈 `void`。
4. **一处失败不影响其它提案**：每张票只影响它所属的那一个提案。

**限速（文档级常量，不做配置项）：** 按已验签身份 `proposalPerMinutePerID = 6` / `proposalBurstPerID = 3`；`votePerMinutePerID = 20` / `voteBurstPerID = 10`；按客户端 IP `governPerMinutePerIP = 60` / `governBurstPerIP = 20`。复用既有 `ipLimiter`，维度口径与第 2 册投稿写路径一致。校准方式沿用既有：改册子 + 改常量。

**内容大小：** `edit` 载荷上限复用 `maxSubmitBytes = 32768`（第 2 册的文档级常量），不新造第二个上限——治理改写的载荷与投稿正文是同一类东西。

## 7. 与既有系统的边界

| 既有能力 | 本册如何相处 |
|---|---|
| `BASE_REVIEW_KEY` 审核通道（`POST /v1/admin/review/*`，#19） | **不复用、不合并**。它是节点运维方对**评论**的单方动作，且只在配置了该 key 的节点上存在；本册是治理者对**内容条目**的**2–3 票**多方授权。两者模型不同，混用会让「谁有权」再次二义。 |
| `BASE_SIGN_KEY`（节点 issuer 私钥） | 本册**不新增**它的权力。治理动作改的是**本节点要签什么**；签名与传播仍是既有导出路径。节点运维方**不能**绕过审批直接改写/下架他人条目。 |
| 导入器（`import-md` / `import-video` / `tools/migrate`） | 运营注入内容的既有通道，**不属于治理**，本册不改、不拦。它写入的条目归属为空（#23 §3.1），按 §2.2 可被治理。 |
| 第 2 册 `POST /v1/submit` | 本册的**互补面**：`author_id == 提案人` 的条目本册一律拒绝并指向它。作者改自己的内容**永远不需要审批**。 |
| `store.RetireItem` | 本册是它的**新调用方**（此前调用方是导入器与课程体系切换）。实现不改。 |
| `GET /v1/contributors` | 名册是**唯一**的资格来源。本册不新增「治理者列表」概念，也不新增接口。 |

## 8. 测试与验收

### 8.1 契约向量

**不新增向量**（§3.4）：签名域一个字节都没动，`vectors/v1/authorsig.json` 不动。

### 8.2 Go 单测（节点侧）

- **受审对象判定**：`author_id == 提案人` → `item_self_owned`；他人 → 通过；空归属 → 通过。
- **资格**：非治理者提案 → `proposer_not_governor`；名册第 11 名提案 → 被拒；名册第 10 名提案 → 通过。
- **门槛（两档，关键）**：`edit` / `revive` 提案后 `vote_count = 1`、`threshold = 2`、`status = pending`，第 2 名治理者投票 → `effective`；`remove` 提案后 `threshold = 3`，第 2 名投出后**仍是 `pending`**、目标 `state` 不变，第 3 名投出才 `effective`。
- **实时复判**：投票人跌出前 10 后重读提案 → `vote_count` 回退、`status` 退回 `pending`；重新入榜 → 票恢复。
- **冷启动（分档）**：名册 1 人 → 任何动作的提案都恒为 `pending`；名册 2 人 → `edit` / `revive` 可生效而 `remove` 恒为 `pending`；名册 3 人 → `remove` 可生效。
- **状态匹配**：对 `removed` 条目提 `remove`/`edit` → `item_state_mismatch`；对 `active` 条目提 `revive` → 同码。
- **归属后果（关键）**：改标题且正文原样 → `content_hash` 不变、`author_id` / `author_sig` **保留**；改正文 → `content_hash` 变、两列**清空**、该条不再计入名册。
- **乐观锁**：受理后目标 `content_hash` 被改（模拟作者更新）→ 达到该动作门槛的那一票投出后 `status = void`、目标**未被覆盖**。
- **幂等**：同一提案不可能执行两次；重复投同一提案 → `already_voted`。
- **并行提案**：同目标同动作并存两个提案 → 先达标者执行，后者呈 `void`。
- **复活**：`revive` 生效后 `tombstones` 行消失、`state='active'`、该条重新计入名册。

### 8.3 接口与集成

- `GET /v1/proposal` 无签名头亦返回 `200`；`votes` 只含当前有效票。
- `POST /v1/proposal` 请求体携带 `author_id` / `proposer_id` → `400 author_id_forbidden`，且未落库。
- 缺签名头 → `400 auth_missing_header`；同 nonce 重放 → `401 auth_nonce_replay`（沿用既有鉴权契约）。
- 限速：超过 `proposalPerMinutePerID` → `429 govern_rate_limited`。

### 8.4 验收条件（AC）

1. 造 4 个达门槛的作者 → 名册 4 人。治理者 A 对 B 的条目提 `remove` → `201`、`vote_count=1`、`threshold=3`、`status=pending`。
2. 治理者 C 投第 2 票 → **仍 `pending`**、目标 `state='active'`、`tombstones` 无行（分档的门槛校验）。
3. 治理者 D 投第 3 票 → `status = effective`；目标 `state='removed'`、`tombstones` 有行。
4. 上述下架后，A 提 `revive`、C 投第 2 票 → `effective`；`state='active'`、`tombstones` 行消失，该条重新出现在 `GET /v1/contributors` 的计数里（复活的 2 票档未被 `remove` 的 3 票档带偏）。
5. A 提一次**只改标题**的 `edit`、C 投第 2 票 → `effective`；标题变化、`content_hash` **不变**、`author_id` / `author_sig` **不变**、B 的计数**不减**。
6. A 提一次**改正文**的 `edit`、C 投第 2 票 → `effective`；`content_hash` 变、`author_id` 清空、B 的计数 **−1**、该条仍可被继续治理（无归属）。
7. 非治理者（名册第 11 名）提提案 → `403 proposer_not_governor`。
8. 名册只有 1 人的节点：`edit` / `remove` 提案都返回 `201` 但 `status` 恒为 `pending`、条目 `state` 不变；名册只有 2 人时 `edit` 可生效，而 `remove` 仍恒为 `pending`。
9. `remove` 提案受理后、第 3 票投出前，原作者用 `POST /v1/submit` 更新该条 → 第 3 票投出后 `status = void`、**原作者的新正文未被覆盖**。
10. 同一身份对同一提案投两次 → `409 already_voted`；提案人给自己已投的提案再投 → 同码。
11. 无签名头访问 `GET /v1/proposal` → `200`；返回的 `votes` 随名册变动实时增减，且 `threshold` 与 `action` 一致（`remove` 为 3，其余为 2）。
12. 治理动作**不产生**任何归属：A / C / D 的 `GET /v1/contributors` 计数不因治理动作增加。
13. 下架生效后导出一次，接收侧节点按既有墓碑路径删行删块；随后复活、再导出，接收侧按「更大 `content_version` 的重新发布」恢复入库（**两节点待人工**）。

## 9. 风险与留给后续册的开放项

1. **合谋的固有代价**：`edit` / `revive` 只需任意两名治理者同意，`remove` 需任意三名——三种动作都能抽走他人贡献。这是「N 票授权」模型的固有边界，本册不设额外防线，只靠两处公开性兜底：名册与提案都是匿名公开读，且票数实时复判（合谋者的名册地位本身会随内容变化而变动）。**抬高 `remove` 的门槛只提高合谋成本，不改变模型性质**。若将来要引入申诉或更高的门槛，那是**成员治理**册子的事（#23 §1 已明确不做）。
2. **改正文必然剥夺原作者归属**：由签名契约数学决定（§4.2）。本册已显式登记，但本册**无法预防**——`edit` 档的任何 2 票都能触发它。原作者的唯一补救是用 `POST /v1/submit` 重签自己的版本，但那会与治理结果竞争（走 §4.4 的乐观锁）。
3. **实时复判 ⇒ 票数会自发回退**：一张已投的票可能因投票人跌出名册而失效，提案退回 `pending`。这是正确行为，但对客户端展示是个坑——**第 4 册的 UI 必须按每次拉取的实时结果渲染，不得本地缓存票数**。
4. **复活不保证即时可用**：接收侧已删块，需等反熵补齐。对端长期离线时，复活在网络上「不生效」。本册不做主动推送。
5. **无归属条目的治理权是空的**：任何人都能改它，改完仍无归属。这意味着一群治理者可以持续改写同一段公共内容而不承担任何贡献记账代价。本册接受（改写不产生收益），但它是「治理权与产权分离」的一处结构性事实，需在后续册留意。
6. **提案表只增不减，列表接口不分页**：长期运行的节点上 `govern_proposals` 会持续累积（含大量 `effective` / `void` 的历史），`GET /v1/proposal` 的响应会随之变大；又因为要返回 `edit` 正文而无法简单截断。**归档与分页留给后续册**；本册的量级假设是「治理者 ≤10 人 × 条目数 × 3 动作」。
7. **跨节点治理会破坏本册的自洽**：§2.5 的自治模型建立在「提案只存在一个节点」之上。若将来要求「多节点共同批准同一动作」，则必须回答「哪个节点的名册算数」，且**先改总纲**（总纲 §6.5 的墓碑传播模型也要一并复核）。
8. **提案的公开度缺口**：`edit` 提案的正文在**生效前**只对拉取 `GET /v1/proposal` 的人可见（没有任何推送），且 `reason` 是可选的。若要求「治理决定必须广而告之」，需要新的通知机制——本册不做。
9. **治理动作与导出时机解耦**：治理结果只在**下一次导出**后才传播到其他节点。本册不引入「治理后立即推送」，也不改导出侧的触发条件。
10. **小名册节点的下架真空（3 票档的直接代价）**：名册长期停留在 1–2 人的节点**没有任何下架能力**（§2.4），即便某条内容明显有害——它仍能用 `edit` 修正，但无法让内容从分发中消失。解锁条件只有一个：出现第 3 个达门槛作者。这是「名册 < 门槛即挂起、零破例」的必然后果，本册接受；若将来要求小节点也能应急下架，只能靠「运维方指定初始名册」这类破例，而那会动摇 §2.4 的身份纯度，必须**先改总纲**再改本册。

## 10. 依赖与后续

```
治理主线
 第 1 册（#23 册子 + #24 计划）：贡献度量与动态角色 —— 已落地
     │  本册消费：§2.1 签名契约（不改）、§4.4 名册语义（不改）、§5.1 读接口（不改）
     ▼
 第 2 册（#25 册子 + #26 计划）：投稿写入与条目更新授权 —— 已落地
     │  本册消费：§3.1 的拒绝口径（本册在「自己条目」分支上复用它指向 POST /v1/submit）、
     │            §2.2 content_hash 口径、maxSubmitBytes 常量、错误码风格
     ▼
 第 3 册（本册 #27）：审批治理 · 他人条目的改写与下架 —— 已立册
     │  本册交付：三个契约入口 + 两张表 + 11 条错误码 + 生效事务口径
     ▼
 第 4 册（未立册）：创作 UI
        消费本册 §3.3 的公开读（治理页）与 §3.1 / §3.2 的写路径（提案与投票表单）
```

**本册交付的契约出口（下游不得改）：**

- `POST /v1/proposal` 的请求体、`action` 三值枚举，以及「身份取自鉴权、请求体不得携带身份字段」（§3.1）
- `POST /v1/proposal/{proposal_id}/vote` 的语义，以及「投票可能带副作用」这一事实（§3.2）
- `GET /v1/proposal` 的返回结构（含 `threshold` 字段）与 `status` 的三值派生规则（§3.3、§4.4）
- 「提案人必须是名册内治理者、自计 1 票、**门槛按动作取值（`remove` 3 票 / `edit`·`revive` 2 票）**、票实时复判、名册人数不足门槛即挂起」的授权语义（§2.1、§2.3、§2.4）
- 「本节点自治、提案不跨节点」的域边界（§2.5）
- 「生效时的 `content_hash` 乐观锁」与「改正文 ⇒ 归属清零」两条判定（§4.2、§4.4）
- 11 条新错误码（§6）

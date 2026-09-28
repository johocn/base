# base 创作与治理 UI 设计（治理主线 第 4 册）

- 日期：2026-09-28
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）；首册 `specs/2026-09-28-base-contribution-roles-design.md`、第 2 册 `specs/2026-09-28-base-submission-design.md`、第 3 册 `specs/2026-09-28-base-approval-governance-design.md`（本册的三个契约来源）
- 范围：**手机端的创作与治理界面**（投稿编辑器 / 我的条目 / 提案与投票 / 我的贡献）+ **节点公开页只读治理看板** + **tabBar 图标**
- 本册**不覆盖**：视频投稿与块上传；课程与课时编排；评论的改与删；标签的写入与检索；成员治理（拉黑 / 封禁 / 申诉）；审核队列；跨节点提案同步；提案过期与撤回；离线投票；本地库加密与深色模式；`profiles` 表与名册的服务端实现（#23 已落地）

## 0. 改版说明

### 0.1 2026-09-28 初版

**新增（本册首次定义）：**

- 手机端四页信息架构与「我的」页两组入口（§2）
- 本地台账表 `my_submissions`：**一张表兼台账与投稿队列**（§4.1）
- 投稿编排：本地校验 → 身份登记 → 客户端算 `content_hash` → 签名 → 有网直发 / 断网入队 / 联网补发（§5）
- `question_json` 的**客户端生成口径**：结构化题目表单是唯一出口，不提供 JSON 手写框（§5.2）
- 节点 `/governance` 只读看板版面（§7）
- tabBar 图标规范与八个 SVG 源码（§8）
- 一条贯穿全册的判定口径：**治理资格不在客户端预判**，一律由服务端裁决（§2.3）

**明确沿用、不改动：**

- **零新增 HTTP 接口**：写路径仍只走 #23 / #25 / #27 已定义的出口，读路径复用既有匿名接口
- #15 的四 tab 信息架构不变，tabBar 仍四项，只加图标
- `author_sig` 签名域、内容包规范 v1、`schema_version`、配置项一律不动
- 投稿条目的可见性由服务端固定为 `public`，本册不出现可见性选择
- 写限速与鉴权复用既有 `requireAuth` + `ipLimiter`，不新增鉴权形态

**一处口径更正（本册以此为准）：**

- 设计过程中曾误述「同 `item_id` 重投时改标题不生效」。核对实现：`UpsertSubmission` 的冲突分支写 `title = excluded.title`，**新标题会被写入库**。真实边界是「标题不在 `author_sig` 签名域内」，而非「改不了」。§6.1 按实际行为定义 UI。

## 1. 范围与不做什么

**做五件事：**

1. **投稿编辑器**：已登记身份的作者直投独立 `article` / `quiz`；同 `item_id` 重投即更新。
2. **我的条目**：本地台账展示待发 / 已提交 / 失败三类，可重投更新、可删待发与失败项。
3. **提案与投票**：提案列表**每次进入实时拉取**、发起三动作提案、投票。
4. **我的贡献**：昵称设置与名册查看。
5. **节点公开页只读看板**：`/governance` 单列流水，未装 App 也能看。

另加：tabBar 四个 tab 加图标（未选中线性 / 选中填充）。

**明确不做：**

- **不新增任何 HTTP 接口**：本册是纯消费方，不含服务端契约变更。
- **不做视频投稿与块上传**：视频仍走 `import-video`。
- **不做课程/课时编排**：投稿不接受 `course/...` 前缀，一切投稿落「未归类」；把内容组织进课程仍是运营动作（导入器）。
- **不做评论的改与删**：没有对应接口，归 #7 讨论册。
- **不做标签写入与检索**：投稿条目的 `tags_json` 落 `[]`，UI 不出现标签输入与标签筛选。
- **不做离线投票**：票实时复判，投票必须联网。
- **不做草稿暂存**：只有「已提交」与「已入队」两种落地状态；编辑中的文本不落库。
- **不做成员治理、提案过期与撤回、跨节点提案同步、同目标动作去重**（沿用 #27 的不做清单）。
- **不做本地库加密与深色模式**（前者归 #4 spike，后者本期不做）。

## 2. 信息架构与入口

### 2.1 新增页面

| 文件 | 职责 | 关键交互 |
|---|---|---|
| `apps/mobile/src/pages/submit/submit.vue` | 投稿编辑器 | 顶部切「文章 / 题库」；文章=标题 + 正文 Markdown 框；题库=结构化题目表单（题干 / 2..N 选项 / 正确项单选 / 解析，题目可增删）；提交按钮；同一页承担「新建」与「重投更新」两种模式（带 `item_id` 进入即为更新模式） |
| `apps/mobile/src/pages/myitems/myitems.vue` | 我的条目 | 三段：待发（`pending`，可改可删）、已提交（可重投更新、可跳条目页）、失败（显示原因，可删）；进入页面触发一次补发 |
| `apps/mobile/src/pages/governance/governance.vue` | 提案与投票 | 列表（每次 onShow 实时拉、不缓存票数）+ 投票按钮 + 发起表单（由列表或 `item_id` 参数进入） |
| `apps/mobile/src/pages/contribution/contribution.vue` | 我的贡献 | 昵称设置 + `GET /v1/contributors` 名单（在榜则标出自己；不在榜显示「未入前 10」与我的 id 前 8 位） |
| `web/templates/governance.html`（路由与模板集合的落点见 §7.1） | 节点只读看板 | 服务端渲染、直接读库，不调接口 |

### 2.2 入口

「我的」页（现有 `apps/mobile/src/pages/mine/mine.vue`）新增两组、共四行，**不改 tabBar**：

- **创作**：`新建投稿` → `submit`；`我的条目` → `myitems`（后随「N 条待发」）
- **治理**：`提案与投票` → `governance`（后随「名册内 / 未入名册」提示）；`我的贡献` → `contribution`

旁路入口：文章详情页（现有 `apps/mobile/src/pages/article/article.vue`）新增「治理」按钮 → `governance?item_id=…&action=…`，直接落在发起表单。题库详情暂不加（`edit` 提案仅覆盖 `article` 载体，见 §3）。

`pages.json` 只新增四个页面路径与 tabBar 图标配置（§8.4），不新增 tab 项。

### 2.3 资格判定一律交服务端

本地 `items` 表没有 `author_id` 列，页面**判不出「这条是不是我写的」**。因此：

- 文章详情页的「治理」按钮**恒显**，是否合乎资格由服务端回 `item_self_owned` / `item_state_mismatch` / `item_not_found` 后再提示。
- 「提案与投票」入口**不预判是否在名册内**，名册状态只作提示文案；唯一裁决是服务端的 `proposer_not_governor` / `voter_not_governor`。
- 「我的条目」里的条目状态也**不预判**（台账是本地投影），下架与否只在用户动作时由服务端反馈。

这条口径与 #25 / #27「拒绝口径定死在服务端」一致：客户端只负责把话说清楚，不重复实现规则。

## 3. 契约边界（零新增接口）

| 用途 | 接口 | 关键约束（本册必须遵守） |
|---|---|---|
| 身份登记 | `POST /v1/identity/register` | **投稿前必做**：投稿走 `requireAuth`，未登记身份 → `403 identity_unregistered` |
| 投稿 | `POST /v1/submit` | `item_id = <type>/<slug>`，`slug` 匹配 `[a-z0-9][a-z0-9-]{0,63}`；`type` ∈ {`article`,`quiz`} 且须与前缀一致；`title` 去首尾空白后 1..200 rune 且无控制字符；正文 ≤ 32768 字节；`quiz` 的 `question_json` 须能通过 `validQuestionJSON`；限速 6/min·身份 + 30/min·IP；请求体**不得**带 `author_id` |
| 条目占用 | `POST /v1/submit` 副作用 | 同一 `item_id` 被他人占用（含无归属存量条目）→ `403 item_id_taken`；本人重投 → `200` 且 `created:false` |
| 昵称 | `POST /v1/profile` | `name` 去空白后 1..32 rune 且无控制字符；请求体不得携带 `id`；**无写限速**（只有鉴权侧约束） |
| 名册 | `GET /v1/contributors` | 匿名读、前 10、实时派生 |
| 提案 | `POST /v1/proposal` | 发起人须为名册内治理者且自计 1 票；`action` ∈ {`remove`,`edit`,`revive`}；`remove`/`edit` 目标须 `active`、`revive` 目标须 `removed`；`reason` 去空白后 1..200 字符；`edit` **仅 `article`** 且须带 `title` + `body_md`（两者字节之和 ≤ 32768）；限速 → `govern_rate_limited` |
| 投票 | `POST /v1/proposal/{id}/vote` | 达门槛当场生效；重复投票 → `409 already_voted` |
| 提案列表 | `GET /v1/proposal` | 匿名读、**不分页**、**按 `proposal_id` 升序**返回、票与状态实时复判（#27 风险 3：UI 不得本地缓存票数）。响应形如 `{"proposals":[…]}`，每条含 `proposal_id`（十进制整数字符串）/ `action` / `item_id` / `proposer_id` / `reason` / `title`（**仅 `edit` 非空**）/ `body_md`（**仅 `edit` 非空**）/ `status` / `votes`（当前有效票的投票人 id 数组）/ `vote_count` / `threshold` / `created_at` / `executed_at` / `voided_at`；`status` ∈ {`pending`,`effective`,`void`} |

**待签字节**（#23 §2.1 契约出口，本册不改）：`canonical_json({alg:"ed25519", domain:"base/author-v1", item_id, content_hash, author_id})`。`content_hash` 由**客户端**按 §5.1 算好，`author_sig` 为 64 位 hex。

## 4. 数据与本地存储

### 4.1 本地台账 `my_submissions`

**一张表兼两职**：既是「我的条目」台账，也是投稿的离线队列。

| 列 | 类型 | 语义 |
|---|---|---|
| `item_id` | TEXT PRIMARY KEY | `<type>/<slug>`，与节点侧同一 id |
| `type` | TEXT NOT NULL | `article` / `quiz` |
| `title` | TEXT NOT NULL | 投稿标题（可被后续重投改写） |
| `body_md` | TEXT NOT NULL | 文章正文（quiz 行为空串） |
| `question_json` | TEXT NOT NULL | 题库 JSON 字符串（article 行为空串） |
| `state` | TEXT NOT NULL | `pending`（待发）/ `sent`（已提交）/ `failed`（永久失败） |
| `reason` | TEXT | `failed` 时的原因文案（错误码映射后的中文）；可空，与 `comment_out.reason` 同形 |
| `created` | INTEGER NOT NULL | 服务端 `created` 回填：1 为新建、0 为该 `item_id` 的更新 |
| `queued_at` | TEXT NOT NULL | 入队时间（补发排序键） |
| `sent_at` | TEXT | 送达时间（未送达为 `''`） |

建表语句追加进 `core/repo.ts` 的 `SCHEMA_SQL` 数组，且只**追加**——该数组靠 `CREATE TABLE IF NOT EXISTS` 幂等执行，**没有版本号机制**（#20 加 `comment_out` 时同样只追加），因此不需要迁移代码。列约定与 `comment_out` 完全同形：`state TEXT NOT NULL`、`reason TEXT` 可空、时间列 `TEXT NOT NULL`。索引另起一条：`idx_my_submissions_queued ON my_submissions(queued_at)`，与既有 `idx_comment_out_queued` 同形（单列，只服务补发取序）。

**可操作性规则**：

- `pending` → 可打开编辑器修改（复用同一 `item_id`，只改本地行，不发请求）。
- `sent` → 可「重投更新」（§5.4），**不可删**（它是台账本体）。
- `failed` → **不可编辑**：`item_id` 就是身份，`item_id_taken` / `item_state_mismatch` 这类失败改字段也救不回；只能删除后以新 `item_id` 重投。

五条设计取舍：

1. **不存 `author_sig`**：发送时现签，天然避开 300s 时间窗，也避免把签名落盘。
2. **状态词汇表沿用既有本地队列**：`state ∈ {pending, sent, failed}`——`pending` / `failed` 与 `comment_out` 同一词汇（`types.ts` 里已是 `'pending' | 'failed'`），`sent` 是本册新增的终态。
3. **不新增 `draft` 状态，也不新增 `sending` 中间态**：本册不做草稿（§1），`pending` 已覆盖「写了但还没送出去」；不设 `sending`，是因为**同 `item_id` 重投在服务端就是 upsert**（#25），补发重复触发至多浪费一次请求、不会产生重复条目——并发由「补发串行 + 页面内单飞标志」兜住，不靠状态机。
4. **存结构化字段，而不是 `comment_out` 那样的 `wire` 整串请求体**：评论入队后不可编辑，存整串最省；投稿台账要支持「改完再发」与重投更新，存 `title` / `body_md` / `question_json` 才能在发送时重建请求体。
5. **与 #20 的 `comment_out` 并列存在，不合并、不抽通用队列**：两者语义不同——评论队列成功即删行，投稿台账成功要留行（「我的条目」的列表本体就是它）；抽象成通用队列只会把两套不同的生命周期塞进一个壳。

### 4.2 纯逻辑模块划分

统一落 `apps/mobile/src/core/`（纯 TS，不 import `uni`/`plus`，配 vitest），页面只做渲染与跳转：

| 模块 | 职责 |
|---|---|
| `submit.ts` | `newItemID(type)` 生成 slug；`buildArticlePayload` / `buildQuizPayload`；`submitItem()`（登记 → 校验 → 算 hash → 签名 → POST）；`enqueueOrSend()`；`flushSubmissions()` |
| `quizdoc.ts` | 结构化题目 ↔ `question_json` 字符串（键序固定）；本地校验（复用 `core/quiz.ts` 的解析口径） |
| `govern.ts` | `listProposals()` / `createProposal()` / `vote()` —— 薄封装，**无本地状态** |
| `contribution.ts` | `putName()` / `roster()` |
| `repo.ts`（既有）| 追加 `my_submissions` 的读写：`saveSubmission` / `listSubmissions(state)` / `markSubmissionSent` / `markSubmissionFailed` / `removeSubmission`（命名与既有 `enqueueComment` / `markCommentOutFailed` / `removeCommentOut` 同风格） |

## 5. 关键流程

### 5.1 投稿（有网）

```
本地校验（§9）→ 取身份（deviceKek + loadLocalIdentity，无则现建，全程无密码提示）
→ ensureRegistered（POST /v1/identity/register）
→ content_hash = hex(sha256(正文 UTF-8 字节))       // article: body_md；quiz: question_json
→ author_sig = sign(AuthorSignBytes(item_id, content_hash, author_id))
→ POST /v1/submit
→ 台账 upsert：state=sent、created 回填、sent_at 落库
```

`content_hash` **只在客户端算**（与 #25 §2.2 一致：服务端自己也算一遍，客户端传了也会被忽略），因此无需两阶段提交。

### 5.2 `question_json` 的生成口径

结构化表单是**唯一出口**，不提供 JSON 手写框。键名与形状已与实现核对（Go 侧 `Question{q,options,answer,explain}` + `QuestionDoc{schema_version,questions}`，**无 `omitempty`**，空 `explain` 也照样输出）。

生成规则：

- 顶层固定 `{"schema_version":1,"questions":[…]}`，键序 `schema_version` → `questions`。
- 每题键序 `q` → `options` → `answer` → `explain`；`explain` 必出（无解析时为空串）。
- `answer` 为**正确项下标**（整数），与解析口径一致；题组标题**不进 `question_json`**（走请求体的 `title`）。
- 编辑期额外约束：选项文本去首尾空白后非空（解析器容忍空串选项，但编辑器不该产出）。
- 提交前本地校验，然后才序列化为**字符串**随请求发送。

**为什么必须校验**：服务端 `validQuestionJSON` 只查三层——合法 JSON、`schema_version == 1`、`questions` 非空，比手机端答题页松得多；而贡献度量侧还会对 `question_json` 做 `json.Unmarshal` 重建。不合规的题组能入库，但答题页会判「题目格式不支持」，贡献也**静默不计**。

**校验口径**：直接复用 `parseQuestionDoc`（`core/quiz.ts`）做往返自检——`parseQuestionDoc(生成串) !== null` 才算通过，不再另写一套规则。它与服务端的差别正是要害：要求每题 `q` 为非空字符串、`options` ≥ 2 且全为字符串、`answer` 为整数且 `0 ≤ answer < len(options)`，`explain` 可缺省（缺省即 `''`）。

**一处口径说明**：键序固定**不是契约约束**——节点把整串原样存库、从不重新序列化，字节序由客户端自定。固定键序只为让「重投同一份内容」不产生无意义的字节抖动（否则每次重开编辑器再提交都会得到不同的 `content_hash`）。因此测试只验自家 build → parse 往返，**不要**写「与 Go 输出逐字节一致」的断言。

### 5.3 投稿（断网入队与补发）

- 无网或请求网络层失败 → 走到 §5.1 的本地校验为止，写台账 `pending`，页面提示「已保存，联网后自动发送」。
- 补发触发点：`myitems` 页 `onShow`；页面内「重试」按钮。
- 补发顺序：`queued_at ASC` 逐条（串行，不并发），每条重走 §5.1 的登记 → 签名 → POST。
- 结果：`200` → `sent`；网络 / `429` → **保持 `pending`** 待下次；其余 4xx → `failed`（单向，见 §9.3）。
- 并发：页面内一个单飞标志，一次 `onShow` 只跑一轮补发（重复触发至多浪费一次请求，不会产生重复条目，依据见 §4.1 取舍 3）。

### 5.4 重投更新

从「我的条目」点某条 → 进 `submit` 页（更新模式）带入 `item_id` 与正文 → 改动 → 同 §5.1 流程 → 服务端 `created:false` → 台账行更新（`title`/`body_md` 或 `question_json` 一并刷新）。

注意：`item_id` 在更新模式下**不可改**（它就是身份）。改标题的边界见 §6.1。

### 5.5 发起提案

带 `item_id` 进 `governance` 发起表单 → 选动作（`remove` / `edit` / `revive`）→ 填理由 →（`edit` 额外填 `title` + `body_md`）→ `POST /v1/proposal` → 回到列表并重新拉取。

表单不做本地资格预判（§2.3）；三个动作**不做客户端去重**（#27 明确不做同目标动作去重）。

### 5.6 投票

- 列表每次 onShow 拉 `GET /v1/proposal`，**票数、门槛、状态全部来自这一次拉取**，本地不缓存、不增量推算（#27 风险 3）。
- 「已投」判定：该提案 `votes` 数组含我的 `author_id`。已投则不显示投票按钮。
- 投票成功 → 用响应里的 `vote_count` / `threshold` / `status` 就地刷新那一条，并**紧接着重拉一次列表**对齐（可能同时存在他人投票）。
- 排序：接口按 `proposal_id` **升序**（旧 → 新）返回；两端都只做**纯展示反转**（新提案在前），除此之外不排序——**票数、门槛、状态一律不本地派生**。
- 状态徽章三档：`pending`（主色，可投票）、`effective`（已生效）、`void`（已作废，同目标提案在别的提案生效时被作废）。非 `pending` 不显示投票按钮。

### 5.7 昵称与名册

`contribution` 页写昵称（`POST /v1/profile`，name 1..32 rune）后重拉 `GET /v1/contributors`；名册含我的 id 则标出自己，否则显示「未入前 10」与我的 id 前 8 位。名册与昵称**不做跨节点同步**（#23 已定）。

## 6. 三条边界的收口

### 6.1 标题不参与签名

`author_sig` 只覆盖 `item_id` + `content_hash`，**标题不在签名保护范围内**；服务端重投时照写新标题。

UI 定义：重投模式标题输入框**可编辑**，下方一行小字提示「标题不参与作者签名，只有正文（题库为题组内容）受签名保护」。本册不擅自扩签名域（要收口须先改 #23 §2.1，属上游变更）。

### 6.2 投稿不能选课程

UI 不出现课程选择器；`item_id` 由客户端生成 `article/<slug>` 或 `quiz/<slug>`，**不带 `course/` 前缀**。服务端对 `course/...` 回 `400 item_id_invalid`，UI 把它映射成「投稿不能指定课程，请改用运营导入」。投稿落「未归类」，与 #25 §7.3 一致。

### 6.3 重投不复活墓碑

`UpsertSubmission` 的冲突分支刻意不写 `state`，因此**对已下架条目重投正文不会让它复活**，复活只能走 `revive` 提案。UI 在「我的条目」里对这类条目给出提示（「该条目可能已被治理下架，重投不会恢复；如需恢复请发起复活提案」），提示基于服务端反馈或提案列表派生，不本地断言状态（§2.3）。

## 7. 节点公开页只读看板

### 7.1 落点（与既有公开页同形）

- 路由注册在 `internal/httpapi/server.go`，与 `GET /{$}`（目录）、`GET /a/{item_id...}`（文章页）并列：新增 `mux.HandleFunc("GET /governance", s.handleGovernancePage)`。
- 模板新增 `web/templates/governance.html`；`internal/httpapi/web.go` 里按既有写法声明 `governanceTmpl = template.Must(template.New("governance").ParseFS(web.FS, "templates/base.html", "templates/governance.html"))`。**每页一个独立模板集合**（`base.html` 提供骨架、页面文件只定义 content 块）——既有注释已说明合并会让 content 块互相覆盖，不能图省事塞进同一个集合。
- 渲染走既有 `s.renderPage(w, governanceTmpl, data)`：给 `pageData` **追加字段**（例：`Proposals []pageProposal`、`Roster []pageContributor`）与同风格的小 struct，**不改 `renderPage` 签名**。
- `web/web.go` 只有 `//go:embed templates/*.html`，本册不动它。

### 7.2 读库（不新增接口）

| 数据 | 来源 |
|---|---|
| 提案 + 票数 / 门槛 / 状态 | 复用 `s.governRoster()` 得到名册集合，再 `s.st.ListProposalViews(set)`（**门槛与票数一律用它返回的 `threshold` / `vote_count`，看板不自己算**） |
| 条目标题与状态 | `s.st.GetItem(item_id)` → 取 `Title` / `State` / `DistClass` |
| 名册 | `s.st.ContributorRoster()`（内部已按 `RosterTopN` 截前 10）+ `s.st.ProfileNames(nil)`（空 ids = 全部） |

复用 `governRoster()` 而不是自己建集合，是为了继承它的降级口径：派生失败按空名册继续渲染（票数自然为 0），页面提示「名册暂不可用」，与接口侧一致。

### 7.3 两条可见性护栏

1. **标题只在 `DistClass == "public"` 时显示**，否则回退显示 `item_id`。公开页（`handleIndex` / `handleArticlePage`）只暴露 `public` 条目，看板不能成为旁路，把非公开条目的标题泄出去。
2. **`/a/{item_id}` 链接只对 `State == "active"` 且 `public` 的条目挂**：`handleArticlePage` 明确要求 active + public，对 `removed` 条目会返回 404。所以下架条目在流水里渲染为**纯文本标题 + `removed` 徽章**，不给死链。

### 7.4 版面

**单列流水、新提案在前**（`ListProposalViews` 按 `proposal_id` 升序返回，渲染时纯反转），一条提案一行卡片：

- 动作徽章（下架 / 改写 / 复活）
- 条目标题（按 §7.3 决定是否挂链接）
- 条目当前状态徽章（`active` / `removed`）
- 理由
- 票数 / 门槛进度条（含门槛值）
- 投票人昵称；缺昵称回退 `id[:8]`，与 `GET /v1/contributors` 同一口径
- 提案状态与时间（`pending` / `effective` / `void`；`created_at` 为毫秒时间戳，格式化为本地时间字符串）

顶部一行名册与门槛说明：**下架 3 票、改写与复活各 2 票**，票数由名册实时复判。

`edit` 提案额外以折叠块显示拟改标题与正文（匿名读接口本就返回这两个字段；`remove` / `revive` 提案的 `title` / `body_md` 恒为空，不渲染该块）。

空态文案：「本节点暂无提案」；名册为空时另提示「暂无贡献者」。**全量不分页**（与 #27 风险 6 同一量级假设）。

看板只显示标题与治理元数据，不显示条目正文（正文在库内为密文）。

## 8. tabBar 图标规范

### 8.1 规格

| 项 | 值 |
|---|---|
| 源画布 | 27×27（描边宽度 1.5，坐标取 `.5` 使描边居中落在整像素） |
| 导出 | 81×81 PNG（27 × 3 正好整数倍），透明底，单张 ≤ 40KB |
| 未选中 | `#888888` 线性（与 `pages.json` 的 `color` 一致） |
| 选中 | `#2b6cb0` **填充**（与 `selectedColor` 一致），形状与未选中完全一致，只是描边换填充 |
| 形状语义 | 课程 = 摊开的书；圈子 = 双人；评论 = 气泡；我的 = 人形 |
| 一致性 | 四图的描边粗细、端点样式、左右留白（各 4.5）一致 |
| 存放 | `apps/mobile/src/static/tabbar/*.png`，源文件 `apps/mobile/src/static/tabbar/src/*.svg` 一并入库 |
| 依赖 | 不引第三方图标库；深色模式本期不做 |

### 8.2 未选中（线性 / `#888888`）

```svg
<!-- static/tabbar/src/course.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="27" height="27" viewBox="0 0 27 27"
     fill="none" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M13.5 10.2C11.7 8.4 9 7.7 5.5 7.7v11.6c3.5 0 6.2.7 8 2.5"/>
  <path d="M13.5 10.2c1.8-1.8 4.5-2.5 8-2.5v11.6c-3.5 0-6.2.7-8 2.5"/>
</svg>

<!-- static/tabbar/src/circle.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="27" height="27" viewBox="0 0 27 27"
     fill="none" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="10.3" cy="9.8" r="3.5"/>
  <path d="M4.3 20.8c0-3 2.7-5 6-5s6 2 6 5"/>
  <path d="M17.9 7.2a3.5 3.5 0 0 1 0 5.9"/>
</svg>

<!-- static/tabbar/src/comment.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="27" height="27" viewBox="0 0 27 27"
     fill="none" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7.5 6h12A3.5 3.5 0 0 1 23 9.5v5A3.5 3.5 0 0 1 19.5 18H13.5l-5.5 4v-4H7.5A3.5 3.5 0 0 1 4 14.5v-5A3.5 3.5 0 0 1 7.5 6z"/>
</svg>

<!-- static/tabbar/src/mine.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="27" height="27" viewBox="0 0 27 27"
     fill="none" stroke="#888888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="13.5" cy="9.5" r="4"/>
  <path d="M5.5 21.5c0-3.6 3.6-6 8-6s8 2.4 8 6"/>
</svg>
```

### 8.3 选中（填充 / `#2b6cb0`）

同形状，仅把描边换成填充（末端补 `z` 闭合）。

```svg
<!-- static/tabbar/src/course-on.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="27" height="27" viewBox="0 0 27 27" fill="#2b6cb0">
  <path d="M13.5 10.2C11.7 8.4 9 7.7 5.5 7.7v11.6c3.5 0 6.2.7 8 2.5z"/>
  <path d="M13.5 10.2c1.8-1.8 4.5-2.5 8-2.5v11.6c-3.5 0-6.2.7-8 2.5z"/>
</svg>

<!-- static/tabbar/src/circle-on.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="27" height="27" viewBox="0 0 27 27" fill="#2b6cb0">
  <circle cx="10.3" cy="9.8" r="3.5"/>
  <path d="M4.3 20.8c0-3 2.7-5 6-5s6 2 6 5z"/>
  <path d="M17.9 7.2a3.5 3.5 0 0 1 0 5.9z"/>
</svg>

<!-- static/tabbar/src/comment-on.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="27" height="27" viewBox="0 0 27 27" fill="#2b6cb0">
  <path d="M7.5 6h12A3.5 3.5 0 0 1 23 9.5v5A3.5 3.5 0 0 1 19.5 18H13.5l-5.5 4v-4H7.5A3.5 3.5 0 0 1 4 14.5v-5A3.5 3.5 0 0 1 7.5 6z"/>
</svg>

<!-- static/tabbar/src/mine-on.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="27" height="27" viewBox="0 0 27 27" fill="#2b6cb0">
  <circle cx="13.5" cy="9.5" r="4"/>
  <path d="M5.5 21.5c0-3.6 3.6-6 8-6s8 2.4 8 6z"/>
</svg>
```

### 8.4 导出与挂载

- 导出：任一 SVG→PNG 工具按 **3×** 出 81×81（例 `npx svgexport src/course.svg course.png 3x`），透明底。
- 挂载：`pages.json` 的 tabBar 四项各补 `iconPath` / `selectedIconPath`（如 `static/tabbar/course.png` / `static/tabbar/course-on.png`），`color` / `selectedColor` 沿用现值；**tab 项数量与文字不变**。
- 交付物：8 张 PNG + 8 个 SVG 源文件。

## 9. 错误处理

### 9.1 网络与离线

- 投稿：网络层失败 → 入队 `pending`，不报错弹窗，只提示「已保存，联网后自动发送」。
- 提案 / 投票 / 昵称：网络层失败 → 直接提示「需要联网」，不做离线暂存。
- 本地异常（取不到私钥、本地库写失败）→ 明确报错，不静默吞掉。

### 9.2 错误码映射

服务端错误码一律映射为中文提示（界面不直接显示英文码）。下表按服务端 `authErrText` 的实际口径对齐：

| 错误码 | 提示口径 |
|---|---|
| `item_title_invalid` | 标题需 1–200 字且不含控制字符 |
| `item_body_too_large` | 正文超过 32KB |
| `item_question_invalid` | 题组内容不合法（需合法 JSON、schema_version 为 1、questions 非空） |
| `item_id_invalid` | 条目 id 不合法；**`course/` 前缀另加**「投稿不能指定课程，请改用运营导入」 |
| `item_type_unsupported` | 载体只能是文章或题库 |
| `item_type_mismatch` | 载体与 id 前缀不一致 |
| `item_id_taken` | 该条目已被他人创建 |
| `author_id_forbidden` | 请求体不得携带身份字段 |
| `author_sig_invalid` | 作者归属签名验证失败 |
| `identity_unregistered` | 身份未在本节点登记，请稍后重试 |
| `item_rate_limited` / `event_rate_limited` / `govern_rate_limited` | 操作过于频繁，请稍后再试 |
| `profile_name_invalid` | 昵称需 1–32 字且不含控制字符 |
| `proposal_action_unsupported` | 只能选择下架 / 改写 / 复活三个动作 |
| `proposal_reason_invalid` | 理由需 1–200 字且不含控制字符 |
| `proposal_edit_invalid` | 改写提案需填标题与正文，且只支持文章 |
| `proposal_too_large` | 标题与正文合计超过 32KB |
| `item_not_found` | 目标条目不存在 |
| `item_self_owned` | 这是你自己的条目，请直接改用投稿 |
| `item_state_mismatch` | 条目的当前状态不支持该动作 |
| `proposer_not_governor` / `voter_not_governor` | 不在本节点治理者名册内 |
| `proposal_not_found` | 提案不存在 |
| `already_voted` | 你已投过票 |
| `auth_*`（`auth_missing_header` / `auth_ts_out_of_window` / `auth_nonce_replay` / `auth_bad_signature` 等） | 属客户端实现异常，统一提示「签名校验失败，请重试」并记录本地日志 |

### 9.3 台账状态流转规则

- `429` 与网络失败 → **保持 `pending`**，下次补发可重试。
- 其余 4xx → 转 `failed`（单向），展示映射后的原因，提供删除；不自动重试。
- `200` → `sent`（终态）。
- `pending` 可改可删；`failed` 只可删、不可编辑；`sent` 可重投更新但不可删（它是台账本体）。

## 10. 验收

**纯逻辑测试（vitest + Go）**

- `newItemID` 生成的 slug 恒满足 `[a-z0-9][a-z0-9-]{0,63}`
- 载荷构造：`article` / `quiz` 两个 type 的请求体字段正确、`author_id` 不出现
- `quizdoc`：结构化题目 → `question_json` 字符串 → 解析回来的往返一致；非法输入（题数 0 / 选项 < 2 / `answer` 越界）被本地拦下
- 台账状态机：`pending → sent`、`pending → failed`（单向）、`429` 保持 `pending`、`failed` 不可编辑
- 补发编排：多条 `pending` 按 `queued_at ASC` 串行、失败一条不阻塞下一条、单飞标志生效
- 错误码 → 中文提示映射全覆盖
- Go 侧看板渲染：单列流水、门槛进度、条目状态徽章、空态

**端到端 AC**

1. 文章投稿 `200`、公开页可读、计入 `GET /v1/contributors`
2. 题库投稿后，手机端答题页（`pages/quiz/quiz.vue`）能打开该题组并正常作答
3. 同 `item_id` 重投 → `created:false`，公开页正文更新
4. 断网投稿 → 入队并在「我的条目」显示待发 → 联网后补发成功转已提交
5. 拒稿码各回其错并给中文提示：`course/` 前缀、标题超长、正文超 32KiB、题组 JSON 非法
6. 他人占用 `item_id` → `item_id_taken`，台账转 `failed` 且可删
7. 治理页：发起 `remove` 提案自计 1 票、门槛显示 3；列表在他人投票后刷新可见（不缓存票数）
8. 投票达门槛当场生效、条目状态随之变化；重复投票 → `already_voted`
9. 名册仅 1 人时 `remove` 提案恒 `pending`，UI 显示「挂起（名册人数不足）」
10. 昵称写入后 `GET /v1/contributors` 的 `name` 变更；在榜时标出自己
11. 对已下架条目重投正文 → 条目仍为下架状态、公开页仍不可读
12. 节点 `/governance` 未装 App 即可读，票数与门槛与接口一致
13. 四个 tab 图标两态真机显示正常（未选中线性 / 选中填充）

## 11. 风险与文档回写

### 11.1 风险

1. **台账是本地投影**：换机 / 重装后「我的条目」为空；他人 `edit` 提案改过的标题本地不会自动更新（除非重新拉提案列表对照）。
2. **提案列表缺标题**：`GET /v1/proposal` 里 `remove` / `revive` 提案没有 `title`（只有 `edit` 提案带）。手机端本地查不到该 `item_id` 时显示 `item_id` 原文；节点看板因服务端渲染可直接读库取标题，不受影响。
3. **补发撞占用**：断网期间 `item_id` 被他人占用 → 补发转 `failed`，不自动重试。
4. **门槛冷启动**：名册人数不足门槛时提案恒 `pending`，UI 必须显示「挂起」而非失败，否则用户会以为提案被拒。
5. **列表只增不减**：`GET /v1/proposal` 不分页、提案表只增不减（#27 风险 6），列表会随时间变长；本册不加过滤与分页，接受该量级。
6. **标题无签名背书**：§6.1 的边界来自上游签名域，本册只做说明与提示，未收口。

### 11.2 文档回写

- `docs/README.md` §3 新增本册一行（第 4 册），§4 依赖顺序把「创作 UI（第 4 册，未立册）」改为已立册。
- 总纲、#23、#25、#27 的契约**零改动**（本册不新增接口、不改签名域、不改内容包规范）。
- 本册不改 `tools/migrate`、不 bump `schema_version`、不引入配置项。
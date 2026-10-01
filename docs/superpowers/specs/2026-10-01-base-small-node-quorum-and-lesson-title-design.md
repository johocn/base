# base 小节点票选豁免与创作入口设计（A 主线 第 12 册 · 缺陷批次）

- 日期：2026-10-01
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`；直接上游 = `#58`（节点级目录与票选准入：`directory_add` + 小节点豁免 + 三态展示）、`#29`（创作 UI：投稿页与「我的」页入口）、`#63`+`#64`（运行路径落盘根与存量台账自愈，已发布 `0.20.2`/`27`）
- 范围：`0.20.2`/`27` 真机回归 4 条 —— ① 课时提交失败（红字**无码**）、② 小节点（<10 人）提交分类 / 讲师词条不能免票选、③ 课程 tab 无「发表文章」入口、④ 课程详情里课时显示 id 而非标题
- 本册**不覆盖**：节点 `POST /v1/submit` 的校验顺序与错误码；`#58` 已定的词条三态语义与 `directory_terms` 表结构；名册派生口径（`RosterTopN` / 质量门槛 / 水位复判）；内容包规范 v1；tabBar 结构；iOS

## 0. 改版说明

### 0.1 2026-10-01 初版

**新增（本册首次定义）：**

- **小节点 `directory_add` 免票选在事件路径生效**（§2）：`SettleGovernProposal` 在 `GovernThresholdForRoster(...) == 1` 这一档（该档只可能由 `directory_add` 命中）把门槛降为 **0** ⇒ 提交即 approved —— 与签名路径 `CreateDirectoryProposal(..., auto=true)` 语义对齐，写法与同函数内既有的「免票选删除」旁路同体例。**门槛常量、名册派生、水位复判口径一字不改**。
- **台账入口的课时标题按 id 补取**（§3）：课程详情的 `from=ledger` 分支不再硬编码回落 itemId，与普通分支共用同一段派生（标题 + 副标题）。
- **课程页「发表文章」入口**（§4）：课程 tab 顶部 bar 新增一键跳既有投稿页 `/pages/submit/submit`。零新页面、零新接口。
- **无码失败的原文透出**（§5）：节点返回体里没有 `code` 字段时，把响应体前 120 字符并入文案，使「提交失败（HTTP 400）」这唯一一种无线索失败在下次复现时自带证据。

**明确沿用、不改动：** `#58 §3.2` 的门槛分档（`GovernThreshold` / `DirectoryAddQuorum=2` / `DirectorySmallNodeRosterMax=10`）与 `rosterReady=false` 的 fail-closed 口径；`#27 §2.3` 的票权实时复判与快照水位；`#29` 的投稿页双 tab、`my_submissions` 台账三态；`#56`+`#61` 的容器本地乐观落库与失败行出路矩阵；`POST /v1/submit` / `POST /v1/proposal` / `POST /v1/event` 全部节点契约；`directory_terms` / `items` / `segments` / `govern_proposals` / `govern_votes` 表结构。

## 1. 范围与不做什么

| 做 | 不做 |
|---|---|
| §2：`SettleGovernProposal` 在小节点豁免档位（门槛恰为 1）把门槛降为 0 | 不改 `GovernThreshold*` 常量与函数签名；不放宽 `rosterReady=false`；不改 `filterRosterAtWatermarkSet` 的通用语义；不动 HTTP 投票端点（`addVoteTx`） |
| §2：**先核对**客户端提交词条后是否刷新本地目录缓存，未刷新则一并补 | 不新开目录接口；不改 `GET /v1/directory` 契约与本地缓存格式 |
| §3：台账入口的课时标题与副标题走与普通入口同一段派生 | 不改台账 `segments_json` 结构；不给台账行加子项标题字段 |
| §4：课程页顶部加「发表文章」按钮，跳既有投稿页 | 不改 tabBar；不新建页面；不改投稿页内部 |
| §5：仅在 `code === ''` 时把响应体前 120 字符并入文案 | **不预设课时 400 根因、不改节点校验、不改签名口径**；不动 `#63` 已落地的 `code` 透出格式 |
| §6：全门禁（vitest / `typecheck` / `build:h5` / `build:app` / `go test ./...`） | 不顺手清理册外既有类型错（判据 = 不新增） |

**批次硬约束（沿用 `#45 §4`）：** 不改内容包规范 v1、不 bump `schema_version`、不新增 `source` / `type` 枚举值、不加配置项、**零新 HTTP 接口**。

## 2. ② 小节点 `directory_add` 不能免票选

### 2.1 症状与根因（已定位）

用户口径（原话）：「当前人数不超 10 人，课程分类，讲师创建者不能直接票选成功吗，规则是超 10 人才需要票选」。**用户口径与 `#58 §3.2` 一致**，问题出在事件路径没走到豁免。

代码级证据链：

1. 门槛已按小节点降档：`GovernThresholdForRoster` 在 `action == directory_add && rosterReady && rosterLen < DirectorySmallNodeRosterMax` 时返回 **1**（`internal/store/govern.go:52-59`）。
2. 手机端词条提案走的是**事件路径**：`core/govern.ts` 的 `createProposal` 把 `action=proposal, verb=directory_add` 投到 `POST /v1/event`（见 `core/govern.test.ts:152-177` 的断言），不是签名路径 `POST /v1/proposal`。
3. 事件路径投影：`ProjectGovernProposal` 落提案行 + **提案人自投第 1 票**（`internal/store/govern_projection.go:63-75`），随后 `handleGovernEvent` 调 `SettleGovernProposal`（`internal/httpapi/govern_event.go:210-213`）。
4. `SettleGovernProposal` 门槛取自 `GovernThresholdForRoster`（**已是 1**，`internal/store/govern_projection.go:170`），但有效票要过名册过滤：`effective := filterRosterAtWatermarkSet(voters, roster, restored)`（同文件 `:168`，集合判定在 `internal/store/govern.go:168-177`：`if roster[id] || restored[id]`）。
5. 名册只由**达标内容**的作者派生：文章 ≥200 非空白字符 / 视频 ≥60 秒 / 题库 ≥3 题（`internal/store/contributor.go:9-15, 34-47`）——**课程与课时不计贡献**。

⇒ 小节点上，刚发布课程/课时的创建者大概率**不在名册内**，他自投的那 1 票被第 4 步滤掉：有效票 0 < 门槛 1 ⇒ 提案**永远 pending**，UI 一直显示「待票选」。只有当提案人恰好是「已达标内容作者」时才走得通。

同时，签名路径 `POST /v1/proposal` 有 `auto := rosterOK && len(roster) < DirectorySmallNodeRosterMax` 的短路（`internal/httpapi/govern.go:192-198`），**提交即 approved**——两条路径语义不一致，这是本条的实质。

### 2.2 处置

**在生效判定处对齐语义**，落点 `internal/store/govern_projection.go` 的 `SettleGovernProposal`：

- 判据：`GovernThresholdForRoster(p.Action, len(roster), rosterReady) == 1`。该档只可能由 `directory_add` 命中（`internal/store/govern.go:53-58`：`action == directory_add && rosterReady && rosterLen < DirectorySmallNodeRosterMax`），因此判据本身即等价于「小节点豁免档」。
- 动作：该档下把 `threshold` 置 **0** ⇒ `len(effective) < threshold` 恒假 ⇒ 直接走前置判定与 `governApplyTx`，**提交即 approved**。语义等于「提案人自己那一票在小节点即足够」，与 `#58 §3.2` 一致。
- **写法照既有旁路**：同函数内 `remove` 已有同一体例（`govern_projection.go:171-178`：命中则 `threshold = 0` 并覆写 `executed_result`）。本册照抄该写法加一支，不新造机制、不新造诊断值（`governApplyTx` 对 `directory_add` 已回 `directory_approved`，见 `govern.go:598`）。
- 越界为零：`rosterLen >= 10`（门槛 2）或 `rosterReady == false`（fail-closed，门槛 2）时该分支不进入，行为**逐字不变**。
- 不改 `filterRosterAtWatermarkSet` 的通用语义（它服务 `remove` / `edit` / `revive` 与本动作的常规档）。
- **只改 settle 点**：另一处同门槛判定是 `addVoteTx`（`govern.go:492-502`，服务 `POST /v1/proposal/{id}/vote`），本册不动 —— 手机端词条提案走事件路径（§2.1 第 2 步），该函数对已定案提案在步 1 早退（`govern.go:505-508`），无行为差异。

**附带核对（先查后改）：** 客户端提交词条成功后是否重新 `loadDirectory` 刷新本地缓存。若没有，则节点已 approved 而 UI 仍显示「待票选」，需在同一处补一次刷新。**未核实前不写代码。**

### 2.3 兼容与影响

- 老客户端（≤ `0.20.2`）不受影响：门槛与状态派生都在节点侧，读接口返回的 `status` 自动变 `effective`。
- 多节点传播：`SettleGovernProposal` 在接收侧同样被调用（`peersync` 反熵路径），口径统一 ⇒ 各节点独立得出同一结论，不引入新的收敛分歧。
- 幂等：已定案（`executed_at`/`voided_at` 非 0）早退，重复调用无副作用。

## 3. ④ 台账入口的课时标题

### 3.1 症状与根因（已定位）

症状：从「我创建的」进课程详情，课时区显示为 `第 1 讲 · course/<cid>/lesson/<lid>`（id 而非标题）；序号「第 N 讲」正常。

根因：`apps/mobile/src/pages/course/detail.vue` 的两条渲染分支口径不一致 ——

- 普通入口（`:158-184`）：`rows = childrenRowsOf(segs)` → 每个子项 `repo.getItem(lid)` → `title: lrow?.title || lid`，并 `repo.listSegments(lid)` 算副标题（类型计数 / 附件 / 时长，空则「空课时」）。
- **台账入口**（`from=ledger`，`:122-128`）：`title: c.itemId` **硬编码回落 id**、`sub: '本地未同步（点开按 id 直接查）'`，`no: i + 1`。

台账行集本身不含子项标题（`containerFormFromLedger` 只还原 `children` 的 id），但**本地 `items` 表里有标题**（`#56` 的本地乐观落库 / `#63` 的存量自愈都会写）——台账分支没去查而已。用户看到的不是「课时没发表成功」，是这条分支没取标题。

### 3.2 处置

在 `detail.vue` 内抽出**一个 async 派生助手**，两条分支共用：

- 入参：子项 id 列表（普通分支来自 `childrenRowsOf(segs)`，台账分支来自 `containerFormFromLedger(row).children`）+ 可选的「课程行集」（用于算序号；台账分支没有，传 `null`）。
- 每个子项：`repo.getItem(lid)` 命中且 `title` 非空 ⇒ 用标题；否则回落 `lid`。`repo.listSegments(lid)` 算副标题，与普通分支同口径（`childCounts` / `attrsOf`）；条目缺失时保留既有文案「本地未同步（点开按 id 直接查）」。
- 序号：有课程行集时 `lessonNo(segs, lid) || i + 1`，台账分支 `i + 1`。
- `tags: tagsOf(links, lid)` 台账分支保持空数组（台账入口不加载 tag_links，与现状一致）。

改动仅落在该页；不改台账结构、不动归档口径、零新接口。

## 4. ③ 课程页「发表文章」入口

### 4.1 定性

**新需求，不是回归。** 证据：tabBar 历来只有 课程 / 圈子 / 评论 / 我的（`apps/mobile/src/pages.json:104-113`），从未有投稿 tab；课程页顶部 bar 历来只有「新建课程」+「同步」（`apps/mobile/src/pages/course/course.vue:3-7`）；投稿入口一直在「我的」页（`apps/mobile/src/pages/mine/mine.vue:21`，无条件显示）。用户在课程 tab 找，找不到是预期行为。

### 4.2 处置

在 `course.vue` 顶部 bar 的「新建课程」旁加一个按钮「发表文章」，`@click` 跳 `uni.navigateTo({ url: '/pages/submit/submit' })`：

- 复用既有投稿页（其内部已是「文章 / 题库」双 tab，见 `pages/submit/submit.vue:5-8`），**零新页面**。
- 不改 tabBar、不改 `mine.vue` 既有入口（两处入口并存，不是替换）。
- 按钮 `size="mini"`，与同排按钮样式一致。

## 5. ① 无码 400 的取证

### 5.1 症状与定性

症状：课时保存后红字报「提交失败」，**不含任何错误码**。

定性（已定位到文案规则，未定位到根因）：

- 客户端文案规则为「中文原因（英文码）」，仅当响应体**没有 `code` 字段**时退回到 `提交失败（HTTP ${status}）`（`apps/mobile/src/core/submit.ts:222-231`；`errorCodeOf` 取 `body.code`，见 `apps/mobile/src/core/errors.ts:45-52`）。
- 节点侧 400 且**不带码**的只有一处：`decodeJSON` 失败回 `{"error":"bad_json"}`（`internal/httpapi/identity.go:41-46`）；其余 4xx 全部经 `writeAuthErr` 带 `code`（`internal/httpapi/authmw.go:83-89`）。
- ⇒ 该失败是「请求未被节点解析」或「中间层（nginx）直接回的 400」，**不是业务校验拒绝**。真因需一次现场原文。

### 5.2 处置（本册只做取证，不猜着改）

`mapSubmitFailure`（`apps/mobile/src/core/submit.ts:221-231`，`raw` 已是响应体字符串）在 `code === ''` 时，把响应体前 120 字符接在兜底文案后：

- 取原文口径：先 `raw.trim()`，再把所有连续空白（含换行）折叠为单个空格，然后截前 120 字符；结果为空串则不加（文案与现状一致）。
- 现有文案与带码分支**逐字不变**；只有「本来就没线索」的那一种失败多出原文。
- 一次改动的收益：屏上红字、台账 `reason`、`edit-surface.log`（`#63 §4.2.2` 已落的 `submit` 阶段）**三处同时带原文**，下次复现即自带证据。
- 已知代价：中间层返回的 HTML 也会被截一段显示（见 §7 风险 2）。
- **本册不预设根因、不改节点校验**；拿到原文后另立册子或并入下一批次。

## 6. 验证口径（门禁）

| 项 | 命令 | 判据 |
|---|---|---|
| mobile 单测 | `npx vitest run`（cwd `apps/mobile`） | 全绿，且新增用例覆盖 §2 / §3 / §5 |
| mobile 类型 | `npm run typecheck` | **不新增**错误（基线：`governance.vue(58,7)` TS2741 与 `submit.vue(156,5)` TS2322 两条册外既有错） |
| H5 构建 | `npm run build:h5` | 通过 |
| App 构建 | `npm run build:app` | 通过 |
| 节点 | `go test ./...` | 全包 ok |
| 节点改动面 | `git diff --stat -- internal/` | 仅 `internal/store/govern_projection.go`（+ 其测试文件） |

新增用例（最低要求）：

1. `internal/store`：**空名册 + `directory_add` ⇒ 投影后 `SettleGovernProposal` 即 `effective`**，且 `directory_terms` 写入 `approved`。
2. `internal/store`：名册 = 10 时 `directory_add` 仍需 2 票（既有用例保持绿，作为「豁免不越界」的护栏）。
3. `apps/mobile`：`detail.vue` 的派生助手——本地有课时条目 ⇒ 出标题；无条目 ⇒ 回落 id 且副标题为「本地未同步」；序号连续。
4. `apps/mobile`：`mapSubmitFailure` —— 响应体无 `code` 时文案包含原文片段；响应体有 `code` 时文案**与现状逐字一致**。

## 7. 风险与已登记的代价

1. **豁免只在小节点档生效**：`rosterReady == false`（名册派生失败）仍 fail-closed 走 2 票 —— `#58 §9` 风险 1 的既有取舍不变，本册不放宽。若真机出现「名册派生失败导致小节点也不免票」，属另一条问题，另立册。
2. **§5 会让中间层 HTML 出现在用户可见文案里**：截断 120 字符后仍可能是一段无意义标记。这是为换取「下次复现自带证据」的显式取舍；真因定位后应把该分支收敛掉（下一册）。
3. **§3 的副标题在台账入口变为实查**：台账入口每打开一次课程详情会多 N 次 `getItem` + `listSegments`（N = 课时数）。课时数量级为个位数，且本地 SQLite 读，代价可接受；不为此引入缓存。

## 8. 验收（AC）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 节点名册 < 10，用**没有任何达标内容**的身份提交「分类」词条 | 提交后词条状态为**已通过**，UI 无「待票选」角标 |
| 2 | 同上，提交「讲师」词条 | 同 AC 1 |
| 3 | 节点名册 = 10，提交同类词条 | 仍为「待票选」，需第 2 票生效（豁免不越界） |
| 4 | 从「我创建的」进课程详情 | 课时区显示**课时标题**与序号；本地无该课时条目时回落 id 且标注「本地未同步」 |
| 5 | 课程 tab 顶部 | 可见「发表文章」按钮，点击进入投稿页（文章 / 题库双 tab） |
| 6 | 复现课时提交失败 | 红字、台账 `reason`、`edit-surface.log` 三处均带响应体原文片段，可据此定因 |

## 9. 发布口径

- 本册含**节点侧改动**（§2），故发布含节点二进制交叉编译与两个 systemd 单元的重新部署。
- 手机端版本 = **`0.20.3`/`28`**；四步发布：HBuilderX `cli pack` 云打包 → 上传 `/opt/appdl/base-0.20.3.apk` → 落地页 `GET /dl/` 改指 → `based release` 签发落 `/opt/base-cache/data/release.json`。
- 线上核对：`GET /v1/release` 版本、`HEAD /dl/base-0.20.3.apk`、`GET /dl/` 只出现新版本、证书 SHA1 与前序版本一致、两单元 `active`。

# 节点级目录与票选准入实施计划（册子 #58 → 计划 #59）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地册子 `#58` 全部契约——① 新表 `directory_terms`（`(kind,term_key)` 主键，只存节点侧，不进内容包）；② 名称即键的规范化 `term_key`（§2.2，双端同构）；③ 复用 `govern.v1` 提案通道新增动作 `directory_add`（任何已登记身份可提，票权限名册内）；④ 门槛分档（名册 < 10 提交即 approved，≥ 10 需 2 票，新增 `DirectoryAddQuorum=2`，不改 `remove=3`/`edit·revive=2`）；⑤ 同键归并（同 `(kind,term_key)` 不重复建提案）；⑥ 新公开读 `GET /v1/directory`（匿名、`version` 短路、接入治理面 IP 限速）；⑦ 存量 `attr.category`/`category/<slug>`/`attr.instructor`/标签名称段**幂等 seed 为 approved**（在端点开放前完成）；⑧ 门户「原名称 + 待票选角标」；⑨ 手机端 `core/directory.ts` 三态展示；⑩ 版本 `0.18.0→0.19.0` 与跨节点发布。覆盖册子 §8 的 AC 1–10。

**Architecture:** 目录是**节点侧独立数据面**：不新增 `items` 行、不进 `segments`、不进内容包、不 bump `schema_version`。`directory_add` 是既有治理动作的**第四个枚举值**，复用 `CreateProposal` / `AddVote` / `ProjectGovernProposal` / `SettleGovernProposal` 全套管线与 `govern.v1` 事件（**零新增签名域常量**）。载荷穿透事件管线采用**扩键集**方案（决策 1）：`governProposalKeys` 增三键 `directory_kind`/`directory_term_key`/`directory_display_name`，投影时**复用既有列**落库（`item_id=dir/<kind>/<hash16>`、`title=display_name`、`body_md=term_key`、`base_content_hash=载荷哈希`），故 `govern_proposals` 表结构、`GovernProposalEvent` 结构、`ProjectGovernProposal` 的 INSERT/UPDATE **一行不改**。目录变更独立推 `directory_version`（沿用 `content_version` 的 `meta` 读写与 `nextXxxExec` 模式）。

**Tech Stack:** Go 1.x（`internal/store`、`internal/httpapi`、`internal/peersync`、`internal/protocol`，纯 Go SQLite `modernc.org/sqlite`，`SetMaxOpenConns(1)`）／ Go 单测（`httptest.NewRecorder()` + `internal/httpapi/testsupport_test.go` 的进程内传输）／ TypeScript + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `core/fakes.ts`（`MemoryRepo`/`FakeHttp`）／ `html/template`（门户，禁放松转义）。

**上游 spec:** `docs/superpowers/specs/2026-10-01-base-directory-governance-design.md`（册子 `#58`）；直接上游 `#33`（`govern.v1` 事件化，`internal/store/govern_projection.go` 与 `internal/peersync/eventsync.go`）、`#27`（提案动作与门槛分档）、`#23`（实时派生名册）、`#36`（分类容器）、`#37`（标签三元组）、`#40`（`seq<0` 槽位）、`#49`（`attr.category` 双来源，本册收敛为单来源）。上一计划 `docs/superpowers/plans/2026-10-01-base-creator-visibility-plan.md`（`#57`）。

---

## 开工前已核实的现状（执行时直接用，不要重新调研）

| 事实 | 位置 |
| --- | --- |
| `GovernActionRemove/Edit/Revive` 常量与 `governRemoveThreshold=3` / `governDefaultThreshold=2` | `internal/store/govern.go:15-22` |
| `GovernThreshold(action)` | `internal/store/govern.go:32-37` |
| `GovernRequiredState(action)` | `internal/store/govern.go:40-45` |
| `CreateProposal`（单事务写提案行 + 提案人第 1 票，**不做生效判定**） | `internal/store/govern.go:241-273` |
| `AddVote` / `addVoteTx`（写票置最前抢写锁 → 读提案 → 计票 → 前置条件 → 应用 → 记 `executed_at`） | `internal/store/govern.go:364-445` |
| `governPreconditionTx`（查 `items` 的 state + content_hash 乐观锁） | `internal/store/govern.go:449-462` |
| `governApplyTx`（`switch` remove/revive/edit，`default` 报「不支持的治理动作」） | `internal/store/govern.go:465-490` |
| `GovernEventActionProposal/Vote` 常量 | `internal/store/govern_projection.go:11-14` |
| `GovernProposalEvent` 结构 | `internal/store/govern_projection.go:19-32` |
| `ProjectGovernProposal`（`(created_at,event_id)` 首个为准；本地行 `source_event_id=NULL` 永不覆盖；重放幂等） | `internal/store/govern_projection.go:50-96` |
| `SettleGovernProposal(proposalID, roster)`（事务外派生名册；事务内第一件事重读提案行） | `internal/store/govern_projection.go:149-207` |
| `validProposalAction`（三值枚举） | `internal/httpapi/govern.go:33-39` |
| `hasControlChars` / `validProposalReason`（trim 后 1..200 rune、无控制字符）/ `maxProposalReasonRunes=200` | `internal/httpapi/govern.go:29-60` |
| `governRoster`（派生失败 **fail-open**，按空名册降级） | `internal/httpapi/govern.go:75-86` |
| `proposalReq` / `handleProposalPost`（顺序：decode → 拒 proposer/author → 动作白名单 → reason → edit 载荷存在性 → 两限速 → `GetItem` → 自持 403 → state 匹配 → edit 分载体 → roster 资格 → `CreateProposal` → 201） | `internal/httpapi/govern.go:96-209` |
| `handleVotePost`（投票人须名册内，`voter_not_governor`） | `internal/httpapi/govern.go:219-276` |
| `handleProposalList` | `internal/httpapi/govern.go:304-336` |
| `governProposalKeys`（**严格键集**：action, proposal_id, target_item_id, verb, content_hash, content_version, revoked_rev, reason, title, body_md） / `governVoteKeys` / `onlyKeys` / `anyString` | `internal/httpapi/govern_event.go:16-47` |
| `parseGovernBody`（proposal 分支：`validTargetID` + `validProposalAction` + `isHexNonEmptyEven(content_hash)` + `jsonInt`） | `internal/httpapi/govern_event.go:55-122` |
| `handleGovernEvent`（验签 → 投影 → 事件行先落 → `SettleGovernProposal` → 返回 `{event_id,received_at,conflict}`） | `internal/httpapi/govern_event.go:127-185` |
| `applySyncedGovernEvent`（peersync 接收侧镜像，同一投影 + settle） | `internal/peersync/eventsync.go:349-402` |
| `deriveGovernRoster`（返回 nil 表失败；调用点 `:119`） | `internal/peersync/eventsync.go:404-415` |
| `publicMux`：`GET /v1/proposal`:126、`GET /v1/contributors`:140、门户 `GET /governance`:148 | `internal/httpapi/server.go:100-152` |
| `New()` 限速器构造（`governLimiterByIP: newIPLimiter(60,20)`） | `internal/httpapi/server.go:52-63` |
| `writeJSON`（`Cache-Control: no-store`、`SetEscapeHTML(false)`）/ `writeError` | `internal/httpapi/public.go:10-23` |
| `handleCatalog` 的 **version 未变短路**先例 | `internal/httpapi/public.go:78-84` |
| `schemaStatements`（全 `CREATE TABLE/INDEX IF NOT EXISTS`；新表直接入列先例见 `progress`/`checkin_days` 注释） | `internal/store/schema.go:12-254`（`progress`/`checkin_days` 在 `:227-254`） |
| 后加列迁移表 `governColumnMigrations` / `migrate(db)` / `tableColumns` | `internal/store/schema.go:284-290` / `:293-354` / `:363-385` |
| `metaContentVersion = "content_version"` / `sqlExec` 接口 | `internal/store/store.go:20` / `:35-39` |
| `MetaString` / `SetMeta` / `BumpContentVersion`（`meta` 读写与自增范式） | `internal/store/store.go:549-587` |
| `nextContentVersionExec(e sqlExec)`（tx 可复用的自增范式） | `internal/store/segments.go:133-147` |
| `Open`（建 schema 循环 `:152-157` → `migrate(db)` `:158` → 返回） | `internal/store/store.go:120-163` |
| 名册常量 `ArticleMinRunes=200`/`VideoMinSeconds=60`/`QuizMinQuestions=3`/`RosterTopN=10`；`deriveRoster`；`ContributorRoster` | `internal/store/contributor.go:10-16`；`:64-86`；`:90-164` |
| 属性键 `AttrKeyCategory="attr.category"` / `AttrKeyInstructor="attr.instructor"` | `internal/protocol/attrs.go:12-16` |
| `validTargetID`（ASCII、1..256 字节，**拒一切 ≥0x80 字节**） | `internal/httpapi/event.go:245-256` |
| `isHexNonEmptyEven` | `internal/httpapi/identity.go:58-64` |
| `jsonInt` | `internal/httpapi/group.go:304-315` |
| `validItemTitle`（trim 后 1..200 rune、无控制字符）/ `itemTypeTag="tag"` | `internal/httpapi/submit.go:125-137` / `:28` |
| 门户模板：看板行标题 `{{.Title}}`、动作徽章；文章页标签 chips | `web/templates/governance.html:13-14`；`web/templates/article.html:5-6` |
| 门户渲染器 `handleGovernancePage` / `proposalPageRow` | `internal/httpapi/web.go:279-312` / `:315-350` |
| 手机端事件体构造 `createProposal`（body 严格键集）/ `postGovernEvent` / `snapshotWatermark` | `apps/mobile/src/core/govern.ts:181-212` / `:130-154` / `:161-166` |
| `LocalRepo.getConfig/setConfig`；`SqlRepo` 实现 | `apps/mobile/src/core/repo.ts:20-21`；`:222-232` |
| 测试假适配器 `MemoryRepo` / `FakeHttp` / `fakeAdapters` | `apps/mobile/src/core/fakes.ts:43` / `:325` / `:489` |
| `course.vue`：`load()`；分类分组 `:163-173`；`myCreated` 喂入 `:200-203`；`doSync` `:231-251`；模板分组头 `:26`、标签 chips `:32-34` | `apps/mobile/src/pages/course/course.vue` |
| `course/detail.vue` 讲师行：台账 `:95`、普通 `:127` | `apps/mobile/src/pages/course/detail.vue` |
| `lesson/detail.vue` 讲师行 `:102` / `:138`；标签 chips `:13-16`；`tagLabel` `:184-186` | `apps/mobile/src/pages/lesson/detail.vue` |
| `article/article.vue` 标签 chips `:12-15`；`tagLabel` `:290-292` | `apps/mobile/src/pages/article/article.vue` |
| `course/edit.vue` 分类输入 `:31-46`、`normalizeCategorySlug`（**只收 ASCII slug**）`:273-277`、保存拼 `f.category` `:412-418` | `apps/mobile/src/pages/course/edit.vue` |
| `course-edit.ts` `ContainerForm.category`（注释「分类 slug」） | `apps/mobile/src/core/course-edit.ts:68-69` |
| `tag/apply.vue`（补标签页：三段名/章/节 → `submitTag`，要求 `canGovern`） | `apps/mobile/src/pages/tag/apply.vue:32-86` |
| `manifest.json`：`versionName "0.17.0"` `:5` / `versionCode "22"` `:6`（本计划前置为 `#57` 已落 `0.18.0`/`23`，见 Task 9 说明） | `apps/mobile/src/manifest.json:5-6` |
| 测试共享 helper：store 侧 `openTemp(t)`；httpapi 侧 `newTestServer(t)`、`testRoster(t,st)`；进程内传输 `inprocTransport` | `internal/store/store_test.go:9`；`internal/httpapi/httpapi_test.go:64`、`internal/httpapi/govern_event_test.go:160`、`internal/httpapi/testsupport_test.go:40-57` |
| 名册造数的既有范式（造作者 + 质量门槛内条目） | `internal/store/contributor_test.go:12-140` |

**环境与工作区：** Windows PowerShell 5.1（**不支持 `&&` 与 heredoc**；多条命令用 `;` 分隔）。Go 门禁需前缀 `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH;`。**本机 Go 无法完成同进程回环 TCP**（`testsupport_test.go:10-16` 已把 `http.DefaultTransport` 换成进程内分发），故一切需要 HTTP 的测试走 `httptest.NewRecorder()` / 进程内 harness，**不得**改用 `httptest.NewServer`。工作区可能有未提交的无关改动与未跟踪二进制——**不要动、不要 `git add`**，每次只 `git add` 本任务的确切文件列表；提交用单行 `git commit -m "..."`。

**执行禁令（册子 §7 边界）：** ① 不做词条改名 / 合并 / 删除 / 退役；② 不做内容自身审批闸门（沿用 `#51`）；③ 不做分类多级树与多归属、不做按标签检索与热度；④ 不做 ②类加密内容关联；⑤ 目录不进内容包、不新增 `items` 行、不改内容包规范 v1、**不 bump `schema_version`**；⑥ 不做节点间合并冲突仲裁（沿用 `(created_at,event_id)` 收敛）；⑦ 不做投票截止与撤回；⑧ 不做 iOS。**不改** `#27` 既有三动作门槛（`remove=3`/`edit`·`revive=2`）与既有校验行为。

---

## 本计划的工程决策（核心价值；册子已定死的部分不得翻案）

| # | 决策 | 理由 | 落点行号 |
| --- | --- | --- | --- |
| 1 | **载荷穿透事件管线选 (a) 扩键集**：`governProposalKeys` 增 `directory_kind`/`directory_term_key`/`directory_display_name` 三键；**投影复用既有列**（`item_id=dir/<kind>/<sha256hex(kind\0term_key)[:16]>`、`title=display_name`、`body_md=term_key`、`base_content_hash=sha256hex(载荷)`）。 | (b) 方案（把键编进 `target_item_id`）**被 `validTargetID` 否决**：它拒一切 ≥0x80 字节（`event.go:245-256`），中文 `term_key` 直接非法；改 hex 编码后 64 rune 中文可到 384 字节 > 256 上限，仍非法。(a) 的三键由 `parseGovernBody` 校验后**映射进既有字段**，故 `GovernProposalEvent` 结构、`ProjectGovernProposal` INSERT/UPDATE、`govern_proposals` 表结构**均零改动**，镜像面最小。 | `govern_event.go:16-19`、`:55-122`、`:142-149`；`eventsync.go:354-381`；`govern.go:257-260`、`:63-67` |
| 2 | **提案资格按动作分档**：`directory_add` 任何已登记身份可提（`requireAuth` 已保证签名身份）；`remove/edit/revive` 仍要求名册内。投票路径（`handleVotePost`）与事件路径同口径：**票权一律限名册内**。 | 册子 §3.1：否则新贡献者永远无法提案；但票权不放宽。**不得顺手改既有三动作行为**。 | `handleProposalPost` `govern.go:187-191`（改为按 action 分支）；`handleVotePost` `:256-260`（不动） |
| 3 | **`directory_add` 无目标 item**：`handleProposalPost` 的 `GetItem` / 自持 403 / `GovernRequiredState` **整段旁路**（`if action==directory_add { ... } else { ... }`）；`governPreconditionTx` 对 `directory_add` **直接返回 `true`**（无目标可锁）；`executed_result = "directory_approved"` 常量 `directoryExecutedResult`。 | 目标不是内容条目，`items` 表无对应行；若沿用旧前置条件会因 `sql.ErrNoRows` 恒判 `false` → 提案被 void。 | `govern.go:139-156`、`:449-462`、`:485-489` |
| 4 | **门槛分档（roster 感知）**：新增 `DirectoryAddQuorum=2`、`DirectorySmallNodeRosterMax=10`；新增纯函数 `GovernThresholdForRoster(action, rosterLen, rosterReady)`——`directory_add` 且 **`rosterReady && rosterLen<10`** ⇒ 返回 **1（豁免）**，否则返回 `GovernThreshold(action)`。`GovernThreshold` 对 `directory_add` 返回 `DirectoryAddQuorum`（供无名册语境的展示）。**名册派生失败（`rosterReady=false`）不豁免**（fail-closed，避免名册抖动时批量误批公开词条）。 | 册子 §3.2「名册 < 10 提交即 approved」；豁免不可逆，不能在派生失败时触发。 | `govern.go:15-22`、`:32-37`；`addVoteTx :403-411`；`SettleGovernProposal :168-171` |
| 5 | **同键归并两层短路**：`directory_terms` 有 `approved` 行 ⇒ 直接返回成功不建提案；有 `pending` 提案（`govern_proposals.item_id=dir/<kind>/<hash16>` 且 `executed_at=0 AND voided_at=0`）⇒ 返回**既有 `proposal_id`**（响应 `merged:true`，HTTP 200）。新提案走 201。 | 册子 §3.3；`item_id` 由 `(kind,term_key)` 确定性派生，故无需额外索引即可查询。 | 新 store 查询 `directory.go`；handler `govern.go:118-134` |
| 6 | **目录版本号**：新增 `metaDirectoryVersion="directory_version"`，沿用 `meta` 读写与 `nextXxxExec` 范式；任何目录变更（新增 / 通过 / seed）在同一事务内 `bumpDirectoryVersionExec(tx)`。`GET /v1/directory?version=n` 当 `n==当前值` ⇒ `{"version":n,"unchanged":true}`。 | 与 `content_version`（`store.go:20/564-587`、`segments.go:133-147`）同构，零新概念。 | `store.go:19-21`、`:549-561`；`directory.go` |
| 7 | **存量 seed 迁移**：放在 `store.Open` 的 `migrate(db)` **之后**（`store.go:158` 之后），函数 `seedDirectoryFromExisting(db)`；幂等靠 `meta` 标志位 `directory_seeded="1"`。数据源：`segments WHERE seq<0 AND kind='attr.category'` / `kind='attr.instructor'`（`AttrKeyCategory`/`AttrKeyInstructor`，`protocol/attrs.go:12-16`）、`items WHERE source='category'`（slug 段）、`items WHERE item_id LIKE 'tag/%'`（第二段 = 标签名称段）。**失败不阻断 `Open`，只记日志**（目录端点开放前必须成功，故 seed 失败会在首个 `GET /v1/directory` 暴露）。 | 册子 §2.3 / §9 风险 1：漏 seed 会让所有存量分类一夜变「待票选」。新表无列演进问题，直接进 `schemaStatements`（先例 `schema.go:227-232`）。 | `store.go:120-163`；`schema.go:12-254` |
| 8 | **`GET /v1/directory` 公开读 + 复用 `governLimiterByIP`**：不新增限速器（治理面已有一条按 IP 的 60/min，语义同为「公开治理读」，复用即册子 §9 风险 5 的「接入既有公开读限速」）；响应形态照 `handleProposalList`（`writeJSON` 自带 `Cache-Control: no-store`）。pending 项带 `votes`/`threshold`。 | 零新增配置项；`server.go:52-63` 的实例化不改。 | `server.go:100-152`、`:52-63`；`public.go:10-19`；`govern.go:304-336` |
| 9 | **门户角标保持 `html/template` 转义**：`pageProposal` 增 `PendingTerm string` / `TermPending bool`；`pageArticle` 的标签展示改为「名 + 可选角标」；模板只增一个 `<span class="pending-badge">待票选</span>`，**不得引入 `template.HTML`**。目录读失败按「全部 approved」降级（不因目录不可用而把存量标签标成待票选）。 | 册子 §9 风险 2：pending 名是用户自由文本，进全局展示面必须转义。 | `web.go:26-90`、`:115-152`、`:279-350`；`web/templates/governance.html:13-14`、`article.html:5-6` |
| 10 | **手机端 `core/directory.ts`**：`pullDirectory(opts, force)/loadDirectory(repo)/termState(kind,key)/displayOf(kind,key)`；缓存落 `config`：`directory_version`（数字字符串）+ `directory_terms_json`（`{approved,pending}` 的 JSON）。**缓存缺失一律按 `pending`**（除非字段为空 → `empty`）。拉取时机 = 内容同步同轮（`syncOnce` 后）+ 进课程页（`onShow`），`version` 未变则不发数据。提交入口：课程编辑页分类输入改为**词条键（可中文）**，新增/复用 `pages/tag/apply.vue` 风格的「提交词条」入口，走 `directory_add` 提案。 | 册子 §4.2 / §5；「宁可显示待票选也不误显示已通过」。 | 新 `apps/mobile/src/core/directory.ts`；`sync.ts`；`course/edit.vue:273-277`、`:412-418`；`course-edit.ts:68-69` |
| 11 | **版本与发布**：本计划在 `#57`（`0.18.0`/`23`）之后执行，落 `apps/mobile/src/manifest.json` `versionName 0.18.0→0.19.0`、`versionCode 23→24`；**节点侧有改动 ⇒ 必须交叉编译部署 `/opt/base/based`（两单元 `base`/`base-cache` 重启探活）+ 四步发布**（云打包 APK → 上传 `/opt/appdl/base-0.19.0.apk` → 落地页整页重写 → `based release` 签发落 `/opt/base-cache/data/release.json`）。 | 节点二进制变了（新表 + 新端点 + 事件键集），不部署则手机端拉不到目录。 | `manifest.json:5-6`；Task 9 |

---

## 文件结构

**新增**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `internal/store/directory.go` | 创建 | 词条规范化 `NormalizeTermKey`/`CleanDisplayName`、`DirectoryTerm` 类型、`GetDirectoryTerm`/`UpsertDirectoryTerm`/`ListDirectory`/`DirectoryVersion`、`bumpDirectoryVersionExec`、`seedDirectoryFromExisting`、`DirectoryProposalItemID`/`DirectoryPayloadHash`（导出，供 httpapi 同构复用） |
| `internal/store/directory_test.go` | 创建 | §2.2 规范化表驱动 + 三态读写 + `directory_version` 自增 + 同键归并查询 + seed 幂等（AC 9 的 store 侧） |
| `internal/store/directory_govern_test.go` | 创建 | `directory_add` 门槛分档（AC 4）、生效分支写目录（AC 3 store 侧）、同键归并（AC 5）、precondition 旁路 |
| `internal/httpapi/directory.go` | 创建 | `handleDirectoryGet`（`GET /v1/directory`，AC 8） |
| `internal/httpapi/directory_test.go` | 创建 | 端点匿名可读 + `version` 短路 + pending 带票数（AC 8）+ 共享 harness |
| `internal/httpapi/directory_proposal_test.go` | 创建 | `POST /v1/proposal` 的 `directory_add`（中文词条、资格放宽、同键归并、小节点即时应答）+ 事件路径镜像（AC 1/2/4/5） |
| `apps/mobile/src/core/directory.ts` | 创建 | `pullDirectory`/`loadDirectory`/`termState`/`displayOf` + 词条键规范化镜像 |
| `apps/mobile/src/core/directory.test.ts` | 创建 | 三态判定（AC 6/7）+ 缓存缺失按 pending + 规范化双端同构 |

**修改**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `internal/store/schema.go` | 修改 | `schemaStatements` 追加 `directory_terms` DDL（新表，不入迁移表） |
| `internal/store/store.go` | 修改 | `metaDirectoryVersion` 常量；`Open` 在 `migrate(db)` 后调 `seedDirectoryFromExisting` |
| `internal/store/govern.go` | 修改 | `GovernActionDirectoryAdd` + `DirectoryAddQuorum` + `directoryExecutedResult`；`GovernThreshold`/`GovernThresholdForRoster`；`addVoteTx` 用 roster 感知门槛；`governPreconditionTx`/`governApplyTx` 加 `directory_add` 分支；新增 `CreateDirectoryProposal` |
| `internal/store/govern_projection.go` | 修改 | `SettleGovernProposal` 增 `rosterReady bool` 入参 + roster 感知门槛 |
| `internal/httpapi/govern.go` | 修改 | `validProposalAction` 加值；`proposalReq` 增 `directory`；`handleProposalPost` 按动作分支（资格分档、旁路、同键归并、小节点即时应答） |
| `internal/httpapi/govern_event.go` | 修改 | `governProposalKeys` 加三键；`parseGovernBody` 校验并映射；`handleGovernEvent` 映射三键到既有字段；`SettleGovernProposal` 调用补 `rosterReady` |
| `internal/httpapi/server.go` | 修改 | `publicMux` 注册 `GET /v1/directory` |
| `internal/httpapi/web.go` | 修改 | `pageData`/`pageProposal`/`pageArticle` 增待票选派生字段；文章页与看板读目录 |
| `web/templates/governance.html` | 修改 | 提案行加「待票选」角标 |
| `web/templates/article.html` | 修改 | 标签 chips 加「待票选」角标 |
| `internal/peersync/eventsync.go` | 修改 | `applySyncedGovernEvent` 增三键解析与映射；`deriveGovernRoster` 返回 `(map, bool)`；settle 调用补 `rosterReady` |
| `internal/httpapi/govern_event_test.go` | 修改 | 镜像 settle 调用补 `rosterReady` |
| `apps/mobile/src/core/govern.ts` | 修改 | `CreateProposalInput` 支持 `directory`；事件体构造增三键 |
| `apps/mobile/src/core/sync.ts` | 修改 | 内容同步成功后同轮 `pullDirectory`（轻量，未变不发数据） |
| `apps/mobile/src/pages/course/course.vue` | 修改 | `onShow` 拉目录；分组头/「我创建的」提示行三态展示 |
| `apps/mobile/src/pages/course/detail.vue`、`lesson/detail.vue`、`article/article.vue` | 修改 | 讲师行 / 标签 chips 三态展示 |
| `apps/mobile/src/pages/course/edit.vue`、`core/course-edit.ts` | 修改 | 分类输入由 slug 改词条键（可中文）；保存产出词条键 |
| `apps/mobile/src/manifest.json` | 修改 | 版本 `0.19.0`/`24`（Task 9） |

**不改动（硬边界）：** `internal/store` 的 `items`/`segments`/`articles`/`quizzes`/`media_meta`/`packs`/`tombstones`/`events`/`tag_links` 表结构与语义；内容包规范 v1；`schema_version`；`#27` 三动作的既有门槛与校验；`internal/protocol` 的属性键与槽位机制；`GET /v1/catalog|contributors|proposal|comment` 既有响应形态。

---

### Task 1: store 目录数据层（`directory_terms` 表 + 规范化 + 仓储 + 版本键）

**Files:** Modify `internal/store/schema.go`；Modify `internal/store/store.go`；Create `internal/store/directory.go`；Create `internal/store/directory_test.go`

- [ ] **Step 1: 写失败的测试** —— 新建 `internal/store/directory_test.go`（复用 `openTemp(t)`，见 `store_test.go:9`）：

  ```go
  func TestNormalizeTermKey(t *testing.T) {
  	cases := []struct{ in, want string; ok bool }{
  		{"  数学  ", "数学", true},
  		{"Ｍath", "math", true},        // 全角→半角 + ASCII 小写折叠
  		{"A  B\tC", "a b c", true},     // 空白折叠
  		{"", "", false},                // 空 ⇒ 非法
  		{strings.Repeat("字", 65), "", false}, // >64 rune ⇒ 非法
  		{"\x01数学", "数学", true},      // 剥离控制字符
  	}
  	for _, c := range cases {
  		got, ok := NormalizeTermKey(c.in)
  		if ok != c.ok || got != c.want { t.Errorf("NormalizeTermKey(%q)=(%q,%v)", c.in, got, ok) }
  	}
  }
  ```

  再加两个用例：`TestDirectoryTermRoundTrip`（`UpsertDirectoryTerm` 后 `GetDirectoryTerm` 状态 / 展示名正确、`ListDirectory` 分 approved/pending）、`TestDirectoryVersionMonotonic`（`bumpDirectoryVersionExec` 递增；缺省 0）。

- [ ] **Step 2: 跑测试确认失败** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/store/ -run 'Directory|NormalizeTermKey'`。判据：编译失败（`NormalizeTermKey` 未定义）。

- [ ] **Step 3: 写实现**

  **（a）`schema.go`** —— 在 `schemaStatements`（`:12-254`）末尾（`checkin_days` 之后、`}` 之前）追加**新表**（无存量列演进问题，照 `:227-232` 先例直接入列）：

  ```go
  // directory_terms：节点级词条目录（册子 #58 §2.1）。**节点侧独立数据面**——
  // 不新增 items 行、不进 segments、不进内容包。主键 (kind, term_key)。
  `CREATE TABLE IF NOT EXISTS directory_terms(
      kind            TEXT NOT NULL,
      term_key        TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      state           TEXT NOT NULL,
      first_author_id TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      PRIMARY KEY(kind, term_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_directory_terms_state ON directory_terms(kind, state)`,
  ```

  **（b）`store.go`** —— 常量块（`:19-21`）追加 `metaDirectoryVersion = "directory_version"`。

  **（c）`directory.go`** —— 新建。核心（片段，非全文）：

  ```go
  // NormalizeTermKey 按册子 #58 §2.2 规范化词条键（双端同构）。ok=false 表示结果非法。
  func NormalizeTermKey(raw string) (string, bool) {
  	s := foldFullWidthASCII(strings.TrimSpace(raw))
  	s = collapseSpaces(s)
  	s = foldASCIILower(s)
  	s = stripControl(s)
  	n := utf8.RuneCountInString(s)
  	if n < 1 || n > 64 { return "", false }
  	return s, true
  }
  // DirectoryProposalItemID / DirectoryPayloadHash 决定 (kind,term_key) → 提案 item_id 与 content_hash（均 ASCII）。
  // **导出**：httpapi 的写路径与事件校验要按同一公式计算，双端必须逐字节同构。
  func DirectoryPayloadHash(kind, termKey string) string {
  	return protocol.SHA256Hex([]byte("dir\x00" + kind + "\x00" + termKey))
  }
  func DirectoryProposalItemID(kind, termKey string) string {
  	return "dir/" + kind + "/" + DirectoryPayloadHash(kind, termKey)[:16]
  }
  ```

  仓储方法：`GetDirectoryTerm(kind, termKey) (DirectoryTerm, bool, error)`、`UpsertDirectoryTerm(state, display, author string, tx/ex) error`、`ListDirectory() (approved, pending []DirectoryTerm, err error)`（pending 由调用方补 votes/threshold）、`DirectoryVersion() int64`、`bumpDirectoryVersionExec(e sqlExec) (int64, error)`（照 `nextContentVersionExec` 体例）、`FindPendingDirectoryProposal(itemID) (int64, bool, error)`（查 `govern_proposals` 未定案的目录提案，供同键归并）、`DirectoryView(roster map[string]bool, rosterReady bool) (DirectoryViewResult, error)`（`GET /v1/directory` 的组装：approved + pending，pending 项补 `votes`/`threshold`；名册在**事务外**派生传入）。常量 `DirectoryStateApproved="approved"` / `DirectoryStatePending="pending"`、`DirectoryKindCategory/Instructor/Tag`。`CleanDisplayName`：`stripControl(collapseSpaces(strings.TrimSpace(raw)))`（**故意不做全角折叠与大小写折叠**，册子 §2.2 括注「保留全角」）。

- [ ] **Step 4: 跑测试确认通过** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/store/ -run 'Directory|NormalizeTermKey'`；再 `go build ./...`。判据：全绿、构建通过。

- [ ] **Step 5: 提交** —— `git add internal/store/schema.go internal/store/store.go internal/store/directory.go internal/store/directory_test.go` 然后 `git commit -m "feat(store): 新增 directory_terms 表与 term_key 规范化（#58 §2.1/§2.2）"`。

---

### Task 2: store 治理接入 `directory_add`（阈值分档 + 生效旁路 + 同键归并 + `rosterReady`）

**Files:** Modify `internal/store/govern.go`；Modify `internal/store/govern_projection.go`；Create `internal/store/directory_govern_test.go`

> **共享测试 helper 先于本 Task 定义**：本 Task 需要「造一名册长度为 n 的节点」。先读 `internal/store/contributor_test.go:12-140` 的既有造数范式（造作者 + 达标条目），把 helper `seedRoster(t, st, n int)` 写进本 Task 的 `directory_govern_test.go` 顶部，供本 Task 与后续 store 测试复用。

- [ ] **Step 1: 写失败的测试** —— 覆盖 AC 4 / AC 5：
  - **门槛分档**：`GovernThresholdForRoster(GovernActionDirectoryAdd, 5, true) == 1`、`(…, 12, true) == 2`、`(…, 0, false) == 2`（派生失败不豁免）；既有动作不受影响（`(remove,…)==3`）。
  - **小节点即时应答**：`CreateDirectoryProposal(p, true)` 返回 `status=effective`，`directory_terms` 有 `approved` 行、`executed_at!=0`、`directory_version` +1。
  - **同键归并**：同一 `(kind,term_key)` 已 approved ⇒ `GetDirectoryTerm` 命中；已 pending ⇒ `FindPendingDirectoryProposal(itemID)` 命中。
  - **precondition 旁路**：`governPreconditionTx` 对 `directory_add` 返回 `true`（不因 `items` 无行而 false）。

- [ ] **Step 2: 跑测试确认失败** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/store/ -run Directory`。判据：`GovernActionDirectoryAdd` / `GovernThresholdForRoster` / `CreateDirectoryProposal` 未定义。

- [ ] **Step 3: 写实现**

  **（a）`govern.go` 常量（`:15-22`）** 追加：

  ```go
  const (
  	GovernActionDirectoryAdd = "directory_add"
  	// DirectoryAddQuorum 是与 #27 同档的 2 票；DirectorySmallNodeRosterMax 以下的名册豁免为 1（册子 §3.2）。
  	DirectoryAddQuorum        = 2
  	DirectorySmallNodeRosterMax = 10
  	directoryExecutedResult   = "directory_approved"
  )
  ```

  **（b）`GovernThreshold` / 新增 `GovernThresholdForRoster`（`:32-37` 处）**：

  ```go
  func GovernThreshold(action string) int {
  	if action == GovernActionRemove { return governRemoveThreshold }
  	return governDefaultThreshold
  }
  // GovernThresholdForRoster 在名册语境下给出门槛：directory_add 且「名册就绪且 <10」⇒ 1（小节点豁免）。
  // 名册派生失败（rosterReady=false）**不豁免**（fail-closed，册子 §9 风险 1）。
  func GovernThresholdForRoster(action string, rosterLen int, rosterReady bool) int {
  	if action == GovernActionDirectoryAdd && rosterReady && rosterLen < DirectorySmallNodeRosterMax { return 1 }
  	return GovernThreshold(action)
  }
  ```

  **（c）`addVoteTx`（`:403-411`）** 用新函数：`Threshold: GovernThresholdForRoster(p.Action, len(roster), true)`（HTTP 投票路径名册由 handler 派生，`rosterOK=false` 时按空名册参与，此处沿用 `SettleGovernProposal` 的 `rosterReady` 语义，见 (e)）。**注意 `AddVote` 签名不带 `rosterReady`**：本计划约定 HTTP 投票路径 `rosterReady` 恒按 `true`（`handleVotePost` 已 fail-open 放行，门槛计算不因此豁免大节点）。

  **（d）新增 `CreateDirectoryProposal`（放在 `CreateProposal` 之后）**：

  ```go
  // CreateDirectoryProposal 单事务写目录提案 + 提案人第 1 票；autoApprove=true（小节点豁免）时
  // **同事务**批准词条、推 directory_version、记 executed_at（册子 §3.2）。返回 (id, status)。
  func (s *Store) CreateDirectoryProposal(p Proposal, autoApprove bool) (int64, string, error) { /* 事务体 */ }
  ```

  事务体：`contentVersionTx`/`maxRevokedRevTx` 固化水位 → `INSERT govern_proposals` → `INSERT govern_votes`（提案人第 1 票）→ 若 `autoApprove`：`approveDirectoryTermExec(tx, kind, termKey, p.Title, p.ProposerID)` + `bumpDirectoryVersionExec(tx)` + `UPDATE govern_proposals SET executed_at,executed_result=?`（`directoryExecutedResult`）→ commit。

  **（e）`governPreconditionTx`（`:449-462`）与 `governApplyTx`（`:465-490`）** 加分支：

  ```go
  func governPreconditionTx(tx *sql.Tx, p Proposal) (bool, error) {
  	if p.Action == GovernActionDirectoryAdd { return true, nil } // 无目标 item 可锁（决策 3）
  	/* 既有逻辑不变 */
  }
  // governApplyTx 的 switch 追加：
  case GovernActionDirectoryAdd:
  	kind, termKey := directoryKindOfItemID(p.ItemID), p.BodyMD // item_id=dir/<kind>/<hash>；term_key 落 body_md
  	if err := approveDirectoryTermExec(tx, kind, termKey, p.Title, p.ProposerID); err != nil { return "", err }
  	if _, err := bumpDirectoryVersionExec(tx); err != nil { return "", err }
  	return directoryExecutedResult, nil
  ```

  **（f）`govern_projection.go` `SettleGovernProposal`（`:149-207`）** 签名改 `SettleGovernProposal(proposalID int64, roster map[string]bool, rosterReady bool) error`；门槛判定（`:168-171`）改 `if len(effective) < GovernThresholdForRoster(p.Action, len(roster), rosterReady) { return nil }`。**事务内不改**：只调 `approveDirectoryTermExec`（exec 版本）。

- [ ] **Step 4: 跑测试确认通过** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/store/ ; go build ./...`。判据：**现有包内测试会因 `SettleGovernProposal` 签名变化而编译失败**——同步改本包内所有调用点（搜索 `SettleGovernProposal(`）补第三个实参 `true`。全绿后 `go build ./...` 通过（httpapi/peersync 的调用点在 Task 4 改，本步先允许 `internal/store` 独立通过；若 `go build ./...` 因调用点报错，转到 Task 4 Step 3 一并修，不在此放宽）。

- [ ] **Step 5: 提交** —— `git add internal/store/govern.go internal/store/govern_projection.go internal/store/directory_govern_test.go` 然后 `git commit -m "feat(store): 治理接入 directory_add 动作与门槛分档（#58 §3.1/§3.2）"`。

---

### Task 3: `GET /v1/directory` 公开读端点

**Files:** Create `internal/httpapi/directory.go`；Create `internal/httpapi/directory_test.go`；Modify `internal/httpapi/server.go`

> **共享 harness 先于本 Task 定义**：本 Task 需要「起一个可匿名读的节点」。复用既有 `newTestServer(t)`（`httpapi_test.go:64`）与进程内传输；把 `directoryHarness(t)` 写进 `directory_test.go` 顶部（内部包 `newTestServer` + 断言 `GET /v1/directory` 可用），供 Task 4/5 复用。

- [ ] **Step 1: 写失败的测试** —— AC 8：匿名 `GET /v1/directory` 返回 200、体含 `version`/`approved`/`pending`（空为 `[]` 非 `null`）；`GET /v1/directory?version=<当前值>` 返回 `{"version":n,"unchanged":true}`。用 `seedDirectoryTerm` helper 造 pending 行断言 `pending[0]` 带 `votes`/`threshold`。

- [ ] **Step 2: 跑测试确认失败** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/httpapi/ -run Directory`。判据：404 / 未定义 handler。

- [ ] **Step 3: 写实现**

  **（a）`server.go` `publicMux`（`:100-152`）** 在 `GET /v1/contributors`（`:140`）之后加：

  ```go
  // 目录公开读（册子 #58 §4.1）：与 contributors / proposal 同类匿名接口，复用治理面 IP 限速（决策 8）。
  mux.HandleFunc("GET /v1/directory", s.handleDirectoryGet)
  ```

  **（b）`directory.go`**：

  ```go
  // handleDirectoryGet 匿名下发目录（approved + pending），version 未变时短路（册子 §4.1 / AC 8）。
  func (s *Server) handleDirectoryGet(w http.ResponseWriter, r *http.Request) {
  	if !s.governLimiterByIP.allow(clientIP(r)) { // 复用既有 IP 限速（零新增限速器）
  		s.writeAuthErr(w, http.StatusTooManyRequests, "govern_rate_limited"); return
  	}
  	view, err := s.st.DirectoryView() // approved+pending 已带 votes/threshold
  	if err != nil { s.writeError(w, http.StatusInternalServerError, err.Error()); return }
  	if v := r.URL.Query().Get("version"); v != "" {
  		if n, e := strconv.ParseInt(v, 10, 64); e == nil && n == view.Version {
  			s.writeJSON(w, http.StatusOK, map[string]any{"version": view.Version, "unchanged": true}); return
  		}
  	}
  	s.writeJSON(w, http.StatusOK, view)
  }
  ```

  `DirectoryView()` 在 store（Task 1 的 `ListDirectory` + 提案票数）：pending 项的 `votes` = 该词条对应 pending 提案的**名册内有效票数**（复用 `proposalVotersExec` + `filterRosterAtWatermarkSet`，名册由 `s.governRoster()` 传入）；`threshold = GovernThresholdForRoster(directory_add, len(roster), rosterOK)`。**派生一次名册，事务外调用**（`SetMaxOpenConns(1)`，勿在事务内调 `s.ListXxx`）。响应结构体照 `catalogResponse` 体例（`json` tag 蛇形），空切片初始化为 `[]`。

- [ ] **Step 4: 跑测试确认通过** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/httpapi/ -run Directory; go vet ./internal/httpapi/`。判据：全绿。

- [ ] **Step 5: 提交** —— `git add internal/httpapi/directory.go internal/httpapi/directory_test.go internal/httpapi/server.go` 然后 `git commit -m "feat(httpapi): 新增 GET /v1/directory 公开读（#58 §4.1）"`。

---

### Task 4: 写路径 `POST /v1/proposal` 支持 `directory_add` + 事件管线扩键 + peersync 镜像

**Files:** Modify `internal/httpapi/govern.go`；Modify `internal/httpapi/govern_event.go`；Modify `internal/peersync/eventsync.go`；Modify `internal/httpapi/govern_event_test.go`；Create `internal/httpapi/directory_proposal_test.go`

- [ ] **Step 1: 写失败的测试** —— 新建 `directory_proposal_test.go`（复用 `directoryHarness`、`testRoster(t,st)`、进程内传输）。覆盖 AC 1/2/4/5：
  - 中文词条 `{kind:"category", display_name:"数学"}` ⇒ 201，`GET /v1/directory` 可见；`term_key` 与规范化结果不一致 ⇒ 400。
  - 资格放宽：非名册身份可提 `directory_add`（对比：非名册提 `remove` 仍 403 `proposer_not_governor`）。
  - 小节点（名册 <10）：提交即 `status=effective`，目录 approved。
  - 同键归并：连提两次同名 ⇒ 第二次 200 `merged:true` 且同一 `proposal_id`，不产生第二条提案。
  - 事件路径：直接构造 `govern.v1` proposal 事件（body 带三键）经 `POST /v1/event`，断言投影 + settle + 目录；`parseGovernBody` 对**未知键 / 缺键**分别拒。
  - peersync 镜像：用 `govern_event_test.go` 同款手法（`ProjectGovernProposal` + `SettleGovernProposal(pid, roster, true)`）验证双端收敛。

- [ ] **Step 2: 跑测试确认失败** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/httpapi/ -run DirectoryProposal`。判据：动作被 `proposal_action_unsupported` 拒。

- [ ] **Step 3: 写实现**

  **（a）`govern.go` `validProposalAction`（`:33-39`）** 增 `store.GovernActionDirectoryAdd`；`proposalReq`（`:96-103`）增：

  ```go
  type proposalDirectoryReq struct {
  	Kind        string `json:"kind"`
  	TermKey     string `json:"term_key"`
  	DisplayName string `json:"display_name"`
  }
  // proposalReq 增字段：Directory *proposalDirectoryReq `json:"directory"`
  ```

  **（b）`handleProposalPost`（`:107-209`）** 在 reason 校验（`:123-127`）之后、限速（`:135-138`）之前插入动作分支；`edit` 存在性判定（`:131-134`）保持不变。`directory_add` 分支：

  ```go
  if req.Action == store.GovernActionDirectoryAdd {
  	if req.Edit != nil || req.Directory == nil { s.writeAuthErr(w, http.StatusBadRequest, "proposal_directory_invalid"); return }
  	if !validDirectoryKind(req.Directory.Kind) { /* 400 proposal_directory_invalid */ return }
  	termKey, ok := store.NormalizeTermKey(req.Directory.DisplayName)
  	display := store.CleanDisplayName(req.Directory.DisplayName)
  	if !ok || display == "" || req.Directory.TermKey != termKey { /* 400 proposal_directory_invalid */ return }
  	itemID := store.DirectoryProposalItemID(req.Directory.Kind, termKey)
  	/* 同键归并（决策 5）：approved ⇒ 200 merged；pending ⇒ 200 既有 id；否则继续 */
  }
  ```

  非 `directory_add` 分支保持既有 `GetItem`/自持/state/edit/roster 资格（`:139-196`）一字不动——**资格分档即「该段只在 else 分支执行」**。`directory_add` 的创建走 `store.CreateDirectoryProposal(p, rosterOK && len(roster) < store.DirectorySmallNodeRosterMax)`，`p.ItemID = itemID`、`p.Title = display`、`p.BodyMD = termKey`、`p.BaseContentHash = store.DirectoryPayloadHash(kind, termKey)`；响应 201/200 携带 `{proposal_id, action, item_id, vote_count, threshold, status}`（`threshold` 用 `GovernThresholdForRoster`）。

  **（c）`govern_event.go`** —— `governProposalKeys`（`:16-19`）加 `"directory_kind": {}, "directory_term_key": {}, "directory_display_name": {}`。`parseGovernBody` proposal 分支（`:65-100`）：`if anyString(m["verb"]) == store.GovernActionDirectoryAdd` 时**额外**校验三键存在且 `validDirectoryKind(kind)`、`term_key == NormalizeTermKey(display_name)`、`display_name` 1..64 rune 无控制字符、`target_item_id == DirectoryProposalItemID(kind, term_key)`、并**禁止同时带 `title`/`body_md`**（防歧义）；否则按既有校验。`handleGovernEvent`（`:139-149`）映射：

  ```go
  verb := anyString(rawBody["verb"])
  title, body := anyString(rawBody["title"]), anyString(rawBody["body_md"])
  if verb == store.GovernActionDirectoryAdd {
  	title = anyString(rawBody["directory_display_name"])
  	body = anyString(rawBody["directory_term_key"])
  }
  /* 传 title/body 进 GovernProposalEvent 的 Title/BodyMD（结构体零新增字段，决策 1） */
  ```

  settle 调用（`:174`）补 `rosterOK`：`s.st.SettleGovernProposal(pid, roster, rosterOK)`。

  **（d）`eventsync.go` 接收侧镜像（`:354-381`、`:398`）** —— `m` 结构体加 `DirectoryKind/DirectoryTermKey/DirectoryDisplayName string`；按 `m.Verb == "directory_add"` 做同样的 title/body 映射；`deriveGovernRoster`（`:404-415`）改返回 `(map[string]bool, bool)`，`pullEvents` 调用点（`:119` 附近）取 `rosterOK` 并透传给 `SettleGovernProposal`。**镜像校验与 httpapi 保持一致**（否则双端对同一事件信心不同）。

  **（e）`govern_event_test.go`** —— 镜像 settle（`:152`）补 `true`。

- [ ] **Step 4: 跑测试确认通过** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go build ./...; go vet ./...; go test ./internal/httpapi/ ./internal/peersync/ ./internal/store/`。判据：全绿。

- [ ] **Step 5: 提交** —— `git add internal/httpapi/govern.go internal/httpapi/govern_event.go internal/peersync/eventsync.go internal/httpapi/govern_event_test.go internal/httpapi/directory_proposal_test.go` 然后 `git commit -m "feat(govern): POST /v1/proposal 支持 directory_add 与事件管线扩键（#58 §3.1/§3.3）"`。

---

### Task 5: 门户角标（文章页 + `/governance` 看板）

**Files:** Modify `internal/httpapi/web.go`；Modify `web/templates/governance.html`；Modify `web/templates/article.html`；Create `internal/httpapi/web_directory_test.go`

- [ ] **Step 1: 写失败的测试** —— 建 `web_directory_test.go`：起 harness（复用 `directoryHarness`），造一个 pending 词条与一篇带该标签段/分类的文章，断言门户 HTML **含**「待票选」且**已转义**（构造含 `<b>` 的 display_name，断言响应体无未转义 `<b>`）。AC 2 / AC 3。

- [ ] **Step 2: 跑测试确认失败** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/httpapi/ -run Directory.*Portal`。判据：页面无「待票选」。

- [ ] **Step 3: 写实现**

  **（a）`web.go`** —— `pageProposal`（`:41-59`）增 `TermPending bool`、`TermName string`；`pageArticle`（`:80-90`）的 `Tags []string` 改为 `TagViews []pageTag`（`{Name string; Pending bool}`）。`handleGovernancePage`（`:279-312`）与 `handleArticlePage`（`:115-152`）读 `s.st.ListDirectory()`（**读失败按「全部 approved」降级**，不误标待票选：`terms, err := ...; if err != nil { terms = nil }`），把词条名映射为 `Pending = state!=approved`。`proposalPageRow`（`:315-350`）：`if v.Action==store.GovernActionDirectoryAdd { row.TermName = v.Title; row.TermPending = true }`（action 显示名「新增词条」见 `governActionLabel` `:219-230` 追加 case）。

  **（b）`web/templates/governance.html`（`:13-14`）** 在标题后加：`{{if .TermPending}}<span class="pending-badge">待票选</span>{{end}}`。

  **（c）`web/templates/article.html`（`:6`）** 标签循环改为 `{{range .TagViews}}{{.Name}}{{if .Pending}}<span class="pending-badge">待票选</span>{{end}}{{end}}`。**不得**引入 `template.HTML`；`base.html` 补 `.pending-badge` 样式。

- [ ] **Step 4: 跑测试确认通过** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/httpapi/ -run Directory.*Portal; go vet ./internal/httpapi/`。判据：全绿；转义断言通过。

- [ ] **Step 5: 提交** —— `git add internal/httpapi/web.go web/templates/governance.html web/templates/article.html internal/httpapi/web_directory_test.go` 然后 `git commit -m "feat(portal): 门户显示待票选角标并保持模板转义（#58 §5.2/§5.3）"`。

---

### Task 6: 存量 seed 迁移（`store.Open` bootstrap，幂等）

**Files:** Modify `internal/store/directory.go`；Modify `internal/store/store.go`；Create `internal/store/directory_seed_test.go`

- [ ] **Step 1: 写失败的测试** —— AC 9：造存量数据（`UpsertSegmentItem` 写 `attr.category="数学"`、`attr.instructor="李老师"` 的容器行；`UpsertArticle`/`UpsertSegmentItem` 造 `category/math` 条目；造 `tag/数学/第一章/第一节` 条目），**先关闭再 `Open` 同一目录**触发 seed，断言 `ListDirectory()` 四类全为 `approved`；再 `Open` 一次断言 `directory_seeded` 生效、无重复、`directory_version` 不再无谓递增。

- [ ] **Step 2: 跑测试确认失败** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/store/ -run DirectorySeed`。判据：`seedDirectoryFromExisting` 未定义或 seed 后仍 pending。

- [ ] **Step 3: 写实现** —— `directory.go` 新增 `func seedDirectoryFromExisting(db *sql.DB) error`：`if MetaString("directory_seeded","") != "" { return nil }` → 单事务内：

  ```go
  // 1) 属性取值的词条：segments.seq<0 的 attr.category / attr.instructor
  //    SELECT DISTINCT kind,text FROM segments WHERE seq<0 AND kind IN ('attr.category','attr.instructor')
  // 2) 分类容器 slug：items WHERE source='category' 的 item_id 去 'category/' 前缀
  // 3) 标签名称段：items WHERE item_id LIKE 'tag/%' 的第二段
  //    ⇒ 每个 (kind, NormalizeTermKey(名称)) upsert 为 approved（display_name 用原文清洗），
  //      并 bumpDirectoryVersionExec(tx) 一次
  // 4) SetMeta("directory_seeded","1")
  ```

  取名称的既有读取函数：`ListItems`（store）、`ListSegments`（`segments.go:90-105`）；分类容器 `source='category'`（`course-tree.ts:35-37` 同口径）。`store.Open`（`:158` 之后）加：

  ```go
  if err := seedDirectoryFromExisting(db); err != nil {
  	log.Printf("store: 目录 seed 迁移失败（目录端点开放前必须修好，#58 §9 风险 1）: %v", err) // 不阻断 Open
  }
  ```

  > `store.go` 目前未 import `log`；seed 失败改为 `fmt.Fprintf(os.Stderr, ...)` 或按包内既有日志惯例，二选一（勿新增依赖）。

- [ ] **Step 4: 跑测试确认通过** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/store/ -run DirectorySeed; go build ./...`。判据：全绿、构建通过。

- [ ] **Step 5: 提交** —— `git add internal/store/directory.go internal/store/store.go internal/store/directory_seed_test.go` 然后 `git commit -m "feat(store): 存量词条幂等 seed 为 approved（#58 §2.3/AC9）"`。

---

### Task 7: 手机端 `core/directory.ts`（三态 + 缓存 + 规范化镜像）

**Files:** Create `apps/mobile/src/core/directory.ts`；Create `apps/mobile/src/core/directory.test.ts`

> **共享测试 helper 先于本 Task 定义**：本 Task 需要 `MemoryRepo` + `FakeHttp` 造目录响应。复用 `fakes.ts` 的 `MemoryRepo`/`FakeHttp`/`fakeAdapters`（`fakes.ts:43/325/489`），如需 `seedDirectoryCache(repo, version, termsJson)` helper，写在本测试文件顶部。

- [ ] **Step 1: 写失败的测试** —— AC 6 / AC 7：`termState` 三态（空字段→`empty`、非空且不在 approved 集→`pending`、命→`approved`）；缓存缺失→`pending`（不崩）；`pullDirectory` 在 `version` 未变时不覆盖缓存、返回 `unchanged`；`normalizeTermKey`（`directory.ts` 内）与 Go 侧同构（全角→半角、空白折叠、ASCII 小写、控制字符剥离、1..64）。

- [ ] **Step 2: 跑测试确认失败** —— `cd apps/mobile; npx vitest run src/core/directory.test.ts`。判据：找不到模块。

- [ ] **Step 3: 写实现** —— `directory.ts`（`DirectoryOptions = { adapters; repo; nodeBaseUrl }`，`Adapters` 与 `sync.ts` 同源）：

  ```ts
  export type TermKind = 'category' | 'instructor' | 'tag';
  export type TermState = 'empty' | 'pending' | 'approved';
  const CACHE_VERSION_KEY = 'directory_version';
  const CACHE_TERMS_KEY = 'directory_terms_json';
  export function normalizeTermKey(raw: string): string | null { /* §2.2 六步，结果 1..64 rune 否则 null */ }
  export async function pullDirectory(o: DirectoryOptions): Promise<{ version: number; unchanged: boolean }> { /* GET /v1/directory?version=本地 */ }
  export async function loadDirectory(repo: LocalRepo): Promise<DirectorySnapshot> { /* 读缓存；缺失 ⇒ {version:0, approved:new Set(), pending:new Map()} */ }
  export function termState(s: DirectorySnapshot, kind: TermKind, key: string): TermState { /* 字段空 ⇒ empty；命中 approved ⇒ approved；否则 pending */ }
  export function displayOf(s: DirectorySnapshot, kind: TermKind, key: string): string { /* approved/pending 都取 display_name，缺则回退 key */ }
  ```

  `pullDirectory`：未变短路用 `unchanged:true`；变更则写 `setConfig(CACHE_VERSION_KEY, String(version))` + `setConfig(CACHE_TERMS_KEY, JSON.stringify({approved,pending}))`。**离线/缓存缺失一律 `pending`**（除非入参为空 → `empty`）。pending 项带 `votes`/`threshold`（供「我创建的」提示行）。

- [ ] **Step 4: 跑测试确认通过** —— `cd apps/mobile; npx vitest run src/core/directory.test.ts; npx tsc --noEmit`。判据：全绿、`tsc` 干净。

- [ ] **Step 5: 提交** —— `git add apps/mobile/src/core/directory.ts apps/mobile/src/core/directory.test.ts` 然后 `git commit -m "feat(mobile): 新增 core/directory.ts 三态与本地缓存（#58 §4.2/§5.1）"`。

---

### Task 8: 手机端三态展示与提交入口落点

**Files:** Modify `apps/mobile/src/core/govern.ts`；Modify `apps/mobile/src/core/sync.ts`；Modify `apps/mobile/src/pages/course/course.vue`、`detail.vue`、`lesson/detail.vue`、`article/article.vue`、`course/edit.vue`；Modify `apps/mobile/src/core/course-edit.ts`

> 页面层无 SFC 单测装置（仓内惯例），以 `tsc` + `build:h5` + `.value` 硬检查收口；三态判定逻辑的 vitest 覆盖在 Task 7 的 `termState`。

- [ ] **Step 1: `govern.ts` 支持 `directory_add`** —— `GovernAction` 增 `'directory_add'`（`:26`）；`CreateProposalInput`（`:168-174`）增 `directory?: { kind: string; termKey: string; displayName: string }`；`createProposal`（`:192-207`）事件体在 `action==='directory_add'` 时**只**带三键、`target_item_id = 'dir/'+kind+'/'+hash16(termKey)`（与节点同构），不带 `title`/`body_md`；并跳过 `getItem` 的 contentHash 前置（`:183-187`）。

- [ ] **Step 2: `sync.ts` 同轮拉目录** —— `syncOnce`（`sync.ts:150` 附近）成功后调 `pullDirectory`（轻量；`unchanged` 即不发数据）。**不新增网络请求到别处**。

- [ ] **Step 3: 三态落点** —— 各页 `onShow`/`onLoad` 先 `loadDirectory(repo)`（进课程页的轻量拉取）：
  - 课程页分组头（`course.vue:26`）：`{{ displayOf(category) }}` + `termState!=='approved'` 时灰角标「待票选」。
  - 课程/课时详情讲师行（`course/detail.vue:95`/`:127`、`lesson/detail.vue:102`/`:138`）：同上。
  - 标签 chips（`course.vue:32-34`、`course/detail.vue:12-14`、`lesson/detail.vue:14`、`article/article.vue:13`）：`tagLabel` 改为走 `displayOf('tag', ...)`，pending 加灰角标；**单条目待票选词最多 3 个，超出「+n」**（册子 §5.3）。
  - 「我创建的」提示行（`course.vue` 模板 `:14-18`）：`pending` 分类显示「分类待票选 · 已有 n/N 票」（`votes`/`threshold` 来自 `directory.ts` pending 项），**只加提示行，不改主展示**。
  - `empty` 态（字段未填）仍显示「无分类 / 无讲师 / 无标签」；**已填未通过不显示「无」**（册子 §5.1 / AC 6）。

- [ ] **Step 4: 提交入口** —— 课程编辑页分类输入（`course/edit.vue:31-46`、`normalizeCategorySlug:273-277`、保存 `:412-418`）由「slug」改为**词条键（可中文）**：`normalizeCategorySlug` 换为 `normalizeTermKey`（`directory.ts`，非法归空）；保存产出 `ContainerForm.category`（`course-edit.ts:68-69` 注释同步改口）。新贡献者提交未登记词条时，复用 **`pages/tag/apply.vue` 体例**新增 `pages/directory/apply.vue`（名称输入 + `canGovern` 不再作为门槛提示 → 改为「任何已登记身份可提交」），提交走 `createProposal({action:'directory_add', directory:{...}})`；提交成功提示「已提交 · 待票选」。

- [ ] **Step 5: 构建与硬检查** —— `cd apps/mobile; npx tsc --noEmit; npm run build:h5`。判据：`tsc` 干净、`build:h5` 输出 `DONE Build complete.`；再跑 `Get-ChildItem apps/mobile/src/pages -Recurse -Filter *.vue | Select-String -Pattern '="[^"]*\.value|\{\{[^}]*\.value'`，判据：无输出。（`<template>` 内**绝不写 `.value`**。）

- [ ] **Step 6: 提交** —— `git add apps/mobile/src/core/govern.ts apps/mobile/src/core/sync.ts apps/mobile/src/core/course-edit.ts apps/mobile/src/pages/course/course.vue apps/mobile/src/pages/course/detail.vue apps/mobile/src/pages/lesson/detail.vue apps/mobile/src/pages/article/article.vue apps/mobile/src/pages/course/edit.vue apps/mobile/src/pages/directory/apply.vue` 然后 `git commit -m "feat(mobile): 目录三态展示与词条提交入口（#58 §5.2/AC1/AC2/AC6）"`。

---

### Task 9: 门禁、版本号与发布

**Files:** Modify `apps/mobile/src/manifest.json`；Modify `docs/superpowers/plans/2026-10-01-base-directory-governance-plan.md`（执行实况回填）

- [ ] **Step 1: 门禁（Go 三件套）** —— `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go build ./...`；`go vet ./...`；`go test ./...`。判据：全绿。

- [ ] **Step 2: 手机端三连** —— `cd apps/mobile; npx vitest run`（基线下限「只增不减」，本册至少新增 `directory.test.ts` 与若干用例）；`npx tsc --noEmit`；`npm run build:h5`。判据：全绿。

- [ ] **Step 3: 发布前模板 `.value` 硬检查** —— `Get-ChildItem apps/mobile/src/pages -Recurse -Filter *.vue | Select-String -Pattern '="[^"]*\.value|\{\{[^}]*\.value'`。判据：无输出；另 `npm run build:app` 产物 `\.value\.value` 计数应为 0（框架自带文件除外）。

- [ ] **Step 4: 版本号** —— `apps/mobile/src/manifest.json`：`versionName` `"0.18.0"` → `"0.19.0"`（`:5`），`versionCode` `"23"` → `"24"`（`:6`）。（`0.18.0`/`23` 由 `#57` 落；若执行时此处仍为 `0.17.0`/`22`，说明 `#57` 未合入，**先停并报告**。）

- [ ] **Step 5: 交叉编译部署（节点侧有改动 ⇒ 必做）** —— 在仓库根交叉编译 Linux 二进制（`GOOS=linux GOARCH=amd64`）产出 `based`，替换 `/opt/base/based`；`systemctl restart base base-cache`（两单元）；`systemctl is-active base base-cache` 与 `curl -sS http://127.0.0.1:.../healthz` 探活；确认 `GET /v1/directory?version=0` 返回 200 且存量词条为 `approved`（seed 生效）。

- [ ] **Step 6: 四步发布** —— ① HBuilderX 云打包 APK；② 上传到 `/opt/appdl/base-0.19.0.apk`；③ 落地页**整页重写**改指 `base-0.19.0.apk`；④ 服务器 `based release` 签发落 `/opt/base-cache/data/release.json`。

- [ ] **Step 7: 线上核对** —— `GET /v1/release` 的 `version`/`url` 指向 `0.19.0`；`HEAD /dl/base-0.19.0.apk` 返回 200 与预期 `Content-Length`；`GET /v1/directory` 匿名可读且 `version` 短路生效。

- [ ] **Step 8: 文档收口** —— 在本文末「执行实况」节回填：实际改动文件清单、`git diff --stat`、门禁跑分（文件数 / 用例数）、`GET /v1/directory` 抽查、seed 抽查、四步发布与线上核对结果、真机验收状态。

---

## 计划代码照抄会挂的地方（执行前必读）

1. **`validTargetID` 拒中文（`event.go:245-256`）** → 不要把 `term_key` 放进 `target_item_id`；用 `dir/<kind>/<sha256hex[:16]>`（纯 ASCII、≤256 字节）。改 hex 编码同样不可行（64 rune 中文 → 384 字节 > 256）。
2. **严格键集（`govern_event.go:16-19/66-67`）** → `directory_add` 事件必须走扩键后的键集，**多一个未知键即整条事件被拒**；同时**禁止**在 `directory_add` 里混带 `title`/`body_md`（防歧义，本计划约定出现即拒）。
3. **`content_hash` 必须是「非空偶数长 hex」（`isHexNonEmptyEven`，`govern_event.go:78`）** → `directory_add` 的 `content_hash` 用 `DirectoryPayloadHash(kind,term_key)`（64 hex），不可留空。
4. **`govern_proposals.item_id NOT NULL` / `base_content_hash NOT NULL`（`schema.go:185-202`）** → 两者都必须给值；本计划用派生 `item_id` 与载荷哈希填充。
5. **`SetMaxOpenConns(1)`** → 事务内**不得**调 `s.ListXxx` / `ContributorRoster` / `deriveRoster`（拿不到连接会死锁）；名册与目录清单一律在事务外派生，事务内只调 `...Exec` 版本（`govern_projection.go:145-148` 是范本）。
6. **`governApplyTx` 的 `switch` 必须加 `directory_add` 分支** → 否则命中 `default` 报「不支持的治理动作」（`govern.go:487-489`）。
7. **`SettleGovernProposal` 签名变更有三处调用点**（`httpapi/govern_event.go:174`、`peersync/eventsync.go:398`、`httpapi/govern_event_test.go:152`），漏改即编译失败；peersync 侧还需把 `deriveGovernRoster` 改成返回 `rosterReady`。
8. **门槛「豁免」不能靠空名册** → `rosterReady=false`（派生失败）时必须按 `DirectoryAddQuorum=2` 处理；否则名册抖动会把中文词条批量误批为公开可见。
9. **门户模板禁放松转义** → pending 的 `display_name` 是用户自由文本；只加 `<span>` 文本节点，**不得**改 `template.HTML`。
10. **`maxProposalReasonRunes=200`（`govern.go:29`）** → `directory_add` 的 reason 沿用同一校验；`display_name` 上限 64 rune 需**单独**校验（不要误用 title 的 200）。
11. **本机回环 TCP 被封** → 需要 HTTP 的 Go 测试一律用进程内 harness / `httptest.NewRecorder()`（`testsupport_test.go:10-16`），**不得**用 `httptest.NewServer`。
12. **共享 helper 顺序** → `seedRoster`（store，Task 2）、`directoryHarness`（httpapi，Task 3）必须在最早引用它的 Task 之前定义，否则后续 Task 编译失败。

---

## 真机验收（登记不阻塞）

- 端 A 提交中文分类词条 → 端 B 投票 → **两端角标变更一致**（册子 §8 真机项）。
- 离线冷启动课程页：缓存存在 ⇒ 三态正确；缓存缺失 ⇒ 一律「待票选」（不崩、不误显示「已通过」）。
- 升级后**存量分类 / 讲师 / 标签不出现「待票选」**（seed 生效抽查）。
- 对应册子 AC：AC 1（中文分类保存与展示）、AC 2（未 approved 双端角标）、AC 3（通过后角标消失且全端同口径）、AC 6（「无」只留给未填）、AC 7（离线三态）、AC 9（存量不误标）。

## 执行实况（执行后回填）

**状态：Task 1–9 全部执行完毕，`0.19.0`/`24` 已发布上线（2026-10-01）。** 基线 `9349f30`（#57 回填），交付 HEAD `7dadd05`。

### 1. 提交序列（Task 1 → 9）

| # | commit | 说明 |
| --- | --- | --- |
| Task 1 | `5b148c4` | `feat(store): 新增 directory_terms 表与 term_key 规范化（#58 §2.1/§2.2）` |
| Task 2 | `86d3e0f` | `feat(store): 治理接入 directory_add 动作与门槛分档（#58 §3.1/§3.2）` |
| Task 3 | `eddf46e` | `feat(httpapi): 新增 GET /v1/directory 公开读（#58 §4.1）` |
| Task 4 | `a062e56` | `feat(govern): POST /v1/proposal 支持 directory_add 与事件管线扩键（#58 §3.1/§3.3）` |
| Task 4 补 | `4a8b443` | `fix(httpapi): proposal_action_unsupported 文案补 directory_add（#58）` |
| Task 5 | `6c3b213` | `feat(web): 门户词条「待票选」角标（#58 §5）` |
| 清理 | `508e343` | `refactor(web): 去掉 proposalPageRow 未使用的 approved 参数（#58）` |
| Task 6 | `c906612` | `feat(store): 存量词条幂等 seed 为 approved（#58 §2.3/AC9）` |
| Task 7 | `16e13ba` | `feat(mobile): 新增 core/directory.ts 三态与本地缓存（#58 §4.2/§5.1）` |
| Task 8 | `396ad60` | `feat(mobile): 目录三态展示与词条提交入口（#58 §5.2/AC1/AC2/AC6）` |
| Task 9 | `7dadd05` | `chore(mobile): 版本落 0.19.0 / 24（#58 §7）` |

Task 之间由主控 `git show <commit>` 复核实际 diff 后放行；**全程未 `git add -A`**，工作区遗留（` M .gitignore`、未跟踪 `based-linux-amd64`）未触碰、未提交。

### 2. 改动文件清单与 `git diff --stat`（`9349f30..7dadd05`）

```
 apps/mobile/src/core/course-edit.ts         |   2 +-
 apps/mobile/src/core/directory.test.ts      | 137 +++++++++    (新)
 apps/mobile/src/core/directory.ts           | 229 +++++++++++++  (新)
 apps/mobile/src/core/govern.test.ts         |  40 ++-
 apps/mobile/src/core/govern.ts              |  46 ++-
 apps/mobile/src/core/sync.ts                |  17 +-
 apps/mobile/src/manifest.json               |   4 +-
 apps/mobile/src/pages.json                  |   4 +
 apps/mobile/src/pages/article/article.vue   |  45 ++-
 apps/mobile/src/pages/course/course.vue     |  46 ++-
 apps/mobile/src/pages/course/detail.vue     |  68 ++++-
 apps/mobile/src/pages/course/edit.vue       |  25 +-
 apps/mobile/src/pages/directory/apply.vue   |  77 +++++     (新)
 apps/mobile/src/pages/lesson/detail.vue     |  64 +++-
 internal/httpapi/authmw.go                  |   3 +-
 internal/httpapi/directory.go               |  85 +++++     (新)
 internal/httpapi/directory_proposal_test.go | 158 +++++++++  (新)
 internal/httpapi/directory_test.go          | 136 +++++++++  (新)
 internal/httpapi/govern.go                  |  85 +++++-
 internal/httpapi/govern_event.go            |  45 ++-
 internal/httpapi/govern_event_test.go       |  11 +-
 internal/httpapi/server.go                  |   3 +
 internal/httpapi/web.go                     |  43 ++-
 internal/httpapi/web_directory_test.go      | 104 +++++++    (新)
 internal/peersync/eventsync.go              |  60 ++--
 internal/peersync/eventsync_test.go         |   5 +-
 internal/store/directory.go                 | 447 ++++++++++++++++++ (新)
 internal/store/directory_govern_test.go     | 239 +++++++++++  (新)
 internal/store/directory_seed_test.go       | 125 +++++++++  (新)
 internal/store/directory_test.go            | 184 +++++++++  (新)
 internal/store/govern.go                    | 104 +++++-
 internal/store/govern_projection.go         |   5 +-
 internal/store/schema.go                    |  15 +
 internal/store/store.go                     |   7 +
 web/templates/article.html                  |   2 +-
 web/templates/governance.html               |   3 +-
 36 files changed, 2578 insertions(+), 95 deletions(-)
```

零新表以外的表结构变更：仅 `directory_terms`（新表）+ `meta` 两键（`directory_version` / `directory_seeded`）；**未 bump `schema_version`、未加配置项、未新增 `source`·`type` 枚举值**。

### 3. 门禁跑分

- **Go**：`go build ./...` / `go vet ./...` / `go test ./... -count=1` **全绿**（9 个有测试的包：`cmd/based`、`internal/{httpapi,importer,markdown,packexport,peersync,protocol,store}`、`tools/migrate`）。
- **手机端**：`npx vitest run` → **34 文件 / 402 用例全绿**（基线 33 / 393，本册 +1 文件 / +9 用例）；`npx tsc --noEmit` 干净；`npm run build:h5` → `DONE Build complete.`。
- **发布前硬检查**：`Get-ChildItem apps/mobile/src/pages -Recurse -Filter *.vue | Select-String -Pattern '="[^"]*\.value|\{\{[^}]*\.value'` → **无输出**。

### 4. `GET /v1/directory` 抽查

`curl -s http://127.0.0.1/v1/directory?version=0` → `200`

```json
{"version":1,"approved":[{"kind":"instructor","term_key":"轮空","display_name":"轮空"}],"pending":[]}
```

`?version=1` → `200` `{"unchanged":true,"version":1}`（**未变短路生效**）；不带 `version` → 与 `version=0` 同体（匿名可读，无鉴权）。

### 5. seed 生效抽查

| 节点 | items | `attr.*` 段 | `directory_terms` | `directory_seeded` | `directory_version` |
| --- | --- | --- | --- | --- | --- |
| 源节点 `/opt/base/data/base.db` | 3 | 0 | 0 | 无（未置位） | 无 |
| cache 节点 `/opt/base-cache/data/base.db` | 6 | 1 | 1 | `'1'` | `'1'` |

cache 节点词条 `('instructor','轮空','轮空','approved')`。源节点无存量 ⇒ 不 bump 版本、不落短路键（与 Task 6 收窄口径一致，`directory_seeded` 仅在确有存量词条时写入）。

### 6. 交叉编译与两单元重启探活

`GOOS=linux GOARCH=amd64 go build -o based-linux-amd64 ./cmd/based`（**21908933 字节**）→ scp 至 `/opt/base/based.new` → `cp -a /opt/base/based /opt/base/based.bak-pre-0.19.0 && mv /opt/base/based.new /opt/base/based && chmod 0755` → `systemctl restart base && systemctl restart base-cache` → 两单元均 `active`。

只读探活：`/v1/release` → 200、`/v1/proposal` → 200、`/v1/comment` → 200、`POST /v1/blob` → 400（在线无回归）、`/v1/blobzzz` → 404（反向对照）。

### 7. 四步发布与线上核对

① HBuilderX `cli pack` 云打包成功（14:24:17 提交 → 14:25:49 成功）。
② APK 落地 `apps/mobile/dist/release/apk/base-0.19.0.apk` = **27446473 字节 / sha256 `cf34a14d270f97eaf83368d74ed57a1d5aa8647fe3fb20a2ed3f4e9c2e4d39ed`**，包内 `version.name=0.19.0 / version.code=24`，证书 SHA1 `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 0.6.0–0.18.0 一致 ⇒ 可覆盖安装）；上传 `/opt/appdl/base-0.19.0.apk`，**远端 sha256 逐字一致**。
③ `/opt/appdl/index.html` 整页重写改指：`base-0.19.0.apk` 命中 1、`版本 0.19.0` 命中 1、`0.18` 残留 0（旧页备份 `index.html.bak-0.18.0`）。
④ `based release -version-name 0.19.0 -min-version-name 0.8.0 -apk-url http://118.190.217.242/dl/base-0.19.0.apk -apk-file /opt/appdl/base-0.19.0.apk -notes '...' -out /opt/base-cache/data/release.json` 成功（`apk_size=27446473`、`apk_sha256=cf34a14d…`、`public_key 48c33db9…`）；`/opt/base/data/release.json` 不存在（无游离副本）。

**线上核对（公网 :80）**：

| 检查 | 结果 |
| --- | --- |
| `GET /v1/release` | `version_name=0.19.0`、`min_version_name=0.8.0`、`apk_size=27446473`、`apk_sha256=cf34a14d…`（与本地逐字一致）、`apk_url=…/dl/base-0.19.0.apk`、`issuer=base-node-1`、`signature` 已签发 |
| `HEAD /dl/base-0.19.0.apk` | `200` / `Content-Type: application/octet-stream` / `Content-Length: 27446473` |
| `GET /v1/directory?version=0` | `200` + approved 数组（匿名可读） |
| `GET /v1/directory?version=1` | `200` `{"unchanged":true,"version":1}` |
| 远端 APK 校验 | `sha256sum /opt/appdl/base-0.19.0.apk` 与本地一致；`stat -c %s` = 27446473 |
| `systemctl is-active base base-cache` | `active` / `active` |

### 8. 真机验收状态

按计划末尾「真机验收（登记不阻塞）」4 条，**待人工**：端 A 提交中文分类词条 → 端 B 投票 → 两端角标一致；离线冷启动三态；升级后存量词条不出现「待票选」；AC 1/2/3/6/7/9 对应真机项。

### 9. 执行期更正（4 条）

1. **Task 6 收窄 `directory_seeded` 写入时机**：计划原文为无条件落键，实改为**仅当确有存量词条（`len(seen)>0`）时**才写。理由：`seedDirectoryFromExisting` 每次 `Open` 都跑，若无条件落键，首次空库 `Open` 即置位，之后补入的存量数据永不被 seed，AC 9 测试无法通过（源节点实测即此形态）。已在 `internal/store/directory.go` 注释写明。
2. **Task 7 收窄 `DirectorySnapshot.approved` 类型**：计划示意代码用 `Set<string>`，实改为 `Map<string,string>`——`displayOf` 契约要求 approved 侧也返回 `display_name`，`Set` 存不下。
3. **Task 8 补 `pages.json` 路由注册**（计划漏登，必需）：新增 `{"path":"pages/directory/apply","style":{"navigationBarTitleText":"补词条"}}`，否则新页不可达。
4. **Task 8 落点收窄两处**：① `course.vue` **不加标签 chips**——经核实该页确无标签展示（计划把 `:32-34` 误标为标签落点，实为图章）；② 标签 chip 保持「名称 · 章 · 节」三元组形态（#37 契约），仅把**名称段**换成 `displayOf('tag', …)`。另核实 §5.3 原文为「**单条目待票选词最多显示 3 个**，超出折叠为「+n」」——**只数待票选**，approved 不受限。

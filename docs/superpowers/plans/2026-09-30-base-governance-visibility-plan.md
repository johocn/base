# 创作可见性（课程页「我创建的」区）实施计划（A 主线 第 7 册）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 App 实测 **F7** 的可见性部分——课程页新增**「我创建的」区**，数据源 = 本地台账 `my_submissions`（**含 `pending` / `failed`**），点开用**台账行集就地渲染**（不碰本地包表 `items` / `segments`、不碰节点）；同时满足并入 F7 的 **F2 / F8**（新建课程 / 课时 / 内容保存后**立刻**可见并带状态提示）。**本册不建任何审批 / 授权闸门**（已核实「未授权」状态在本系统不存在，见册子 §2）。

**Architecture:** **只动 `apps/mobile`，零节点改动、零新 HTTP 接口、零新表、零列变更。** 新增纯函数模块 `core/my-created.ts`（台账行 → 「我创建的」视图模型：状态文案 + 去重）与「台账行集 → 详情渲染」的桥（复用 `core/container-view.ts` 与 `core/course-edit.ts` 的既有读取口径，只把数据源换成 `segments_json`）；`pages/course/course.vue` 新增一个独立区段；四个详情页（`course/detail` / `lesson/detail` / `article/article` / `quiz/quiz`）增加 `from=ledger` 分支从台账取数。**数据一律来自 `LocalRepo`，不发网络请求。**

**Tech Stack:** TypeScript + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `core/fakes.ts`（Node 下假适配器）／ Vue SFC（`<template>` 禁 `.value` 写法）。

**上游 spec:** `docs/superpowers/specs/2026-09-30-base-governance-visibility-design.md`（`#51`）；批次编排 `docs/superpowers/plans/2026-09-30-base-batch-f3-f9-plan.md`（`#45`）；台账契约 `docs/superpowers/specs/2026-09-28-base-creation-ui-design.md`（`#29 §4.1`）；课程页结构 `docs/superpowers/specs/2026-09-30-base-course-lesson-edit-design.md`（`#40 §5.1` / §0.4）；分类入口边界 `docs/superpowers/specs/2026-09-30-base-course-category-attr-design.md`（`#49`）。

---

## 开工前已核实的现状（执行时直接用，不要重新调研）

| 事实 | 位置 |
| --- | --- |
| `LocalRepo` 台账六方法：`saveSubmission` / `listSubmissions(state?)` / `getSubmission` / `markSubmissionSent` / `markSubmissionFailed` / `removeSubmission`（`listSubmissions` 不带 `state` 即取全部，`ORDER BY queued_at ASC`） | `apps/mobile/src/core/repo.ts:86-96,523-529` |
| `my_submissions` DDL：列 `item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at` + `idx_my_submissions_queued` | `apps/mobile/src/core/repo.ts:126-131` |
| `SqlRepo` 六方法实现（`saveSubmission` upsert / `listSubmissions` / `getSubmission` / 三条 UPDATE·DELETE） | `apps/mobile/src/core/repo.ts:511-553` |
| `toMySubmissionRow`：`type` 归一化到 `article\|quiz\|tag\|course\|lesson`（其余回落 `article`）；`state` 归一化 `sent\|failed\|pending` | `apps/mobile/src/core/repo.ts:648-667` |
| `MySubmissionRow`：`type ∈ article\|quiz\|tag\|course\|lesson`、`bodyMd`、`questionJson`、`linksJson`、`segmentsJson`（容器行集 JSON `[{seq,kind,text}]` 按 seq 升序）、`state ∈ pending\|sent\|failed`、`reason` | `apps/mobile/src/core/types.ts:109-127` |
| `ItemRow { itemId,title,type,rev,state,... }`（`state`: `active\|removed`）；`SegmentRow { itemId,seq,kind,text,contentHash }` | `apps/mobile/src/core/types.ts:1-11,52-58` |
| 投稿三态判定：送达 `sent` / 断网·429·5xx `pending` / 其余 4xx `failed`（`enqueueOrSend`）；`writeLedger` upsert 保留既有 `created` | `apps/mobile/src/core/submit.ts:310-330,275-293` |
| `SubmitDraft`（`type` / `itemId` / `title` / `bodyMd` / `questionJson` / `segments?`）；容器行集从 `segments_json` 重建的既有解码函数在 `submit.ts` 内（`decodeLedgerSegments`，模块私有） | `apps/mobile/src/core/submit.ts:25-37,409-419` |
| `ContainerForm`（`itemId`/`type`/`title`/`digest`/`cover`/`instructor`/`difficulty`/`durationSec`/`attachments`/`bodyMd`/`children`）；`buildContainerSegments`；`loadContainerForm(repo,itemId,type)`（读 `items` + `segments`，`attrsOf`/`digestOf`/`childrenRowsOf` 回填） | `apps/mobile/src/core/course-edit.ts:48-66,99-114,117-132` |
| 容器读取纯函数：`attrsOf(segs)`（`seq<0` 属性行，降序）/ `digestOf(segs)`（`seq=0`）/ `childrenRowsOf(segs)`（`seq>=1` 升序）——**只吃 `SegmentRow[]`，与数据来源无关** | `apps/mobile/src/core/container-view.ts:47-79,88-93` |
| 「我的条目」页三区（待发 / 已提交 / 失败）模板、`onShow` 刷新（含 `flushSubmissions`）、打开 `open(row)` 的既有跳转口径 | `apps/mobile/src/pages/myitems/myitems.vue:7-47,66-80,86-93` |
| 课程页：模板四段（标题栏 / 搜索 / 分类分组 / 未归类 / 独立内容）L1-50、`load()`（`repo.listItems()` → active 过滤 → `splitCourses`/`splitCategories`/`coursesOfCategory`）L81-117、导航（`openCourse`/`openStandalone`/`openArticle`）L123-129,157-167 | `apps/mobile/src/pages/course/course.vue` |
| 详情页落点：`course/detail.vue`（`onLoad` 取 `repo.getItem`+`listSegments`，L77-142）、`lesson/detail.vue`（`onLoad`，L74-138）、`article/article.vue`、`quiz/quiz.vue` | `apps/mobile/src/pages/course/detail.vue:77-142`、`apps/mobile/src/pages/lesson/detail.vue:74-138` |
| **无「未授权」态（容器）**：`UpsertSegmentSubmission` 的 `VALUES` 写死 `'public','active'`，`ON CONFLICT` 刻意不写 `state`/`dist_class` | `internal/store/submission.go:141-147`（同形 `article`/`quiz` 分支 `64-70`） |
| **无「未授权」态（分支）**：`handleSubmitPost` 类型分支只做形态校验，无授权 / 票数判定 | `internal/httpapi/submit.go:198-235,317-347` |
| 名册上限 `RosterTopN = 10`；名册由 `deriveRoster` 实时派生（与「创建授权」无关） | `internal/store/contributor.go:14-16,62-86` |
| 手机端门禁：`npx vitest run`（基线 **23 文件 / 230 用例**）、`npx tsc --noEmit`、`npm run build:h5` | `apps/mobile/package.json` |
| 发布前硬检查：`apps/mobile/src/pages/*/*.vue` 不得出现 `.value` 模板写法 | `docs/README.md:100`（更正 14 ①） |

**环境与工作区：** Windows PowerShell 5.1（无 `pwsh`，不支持 `&&` 与 heredoc，提交消息写临时文件 + `git commit -F`）；工作区有未提交的 `.gitignore` 改动与未跟踪的 `based-linux-amd64`——**不要动、不要 add**，每次只 `git add` 本任务文件。

**执行禁令（册子 `#51 §1` / §3.5）：** 不建任何审批 / 授权闸门；不新增或修改任何 HTTP 接口；不改 `items` / `segments` / `blobs` 与 `core/sync.ts`；不改 `my_submissions` 表结构与 `LocalRepo` 六方法；不做投票 / 授权 UI；不做条目删除与下架；不改内容包规范 v1、不 bump `schema_version`、不加配置项；不做 iOS。**零节点改动 ⇒ 本册不交叉编译 / 不部署节点二进制。**

---

## 文件结构

**新增**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/core/my-created.ts` | 创建 | `MyCreatedRow` 视图模型 + `statusLabelOf(state)` + `buildMyCreatedView(rows, packItemIds)`（状态文案 + 去重：`sent` 且包表已有 → 不列出；`pending`/`failed` 一律列出；`tag` 排除）+ `ledgerSegmentsOf(row)`（`segments_json` → `SegmentRow[]`）+ `containerFormFromLedger(row)`（复用 `attrsOf`/`digestOf`/`childrenRowsOf`，产出与 `loadContainerForm` 同构的 `ContainerForm`，**不读包表**） |
| `apps/mobile/src/core/my-created.test.ts` | 创建 | 状态文案 / 去重四象限 / `tag` 排除 / 空台账 / `segments_json` 解析（含空串与坏 JSON）/ 桥产出与 `loadContainerForm` 字段一致 |

**修改**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/pages/course/course.vue` | 修改 | 新增「我创建的」区段（顶部）+ `load()` 取 `repo.listSubmissions()` + 逐行 `repo.getItem` 判包表归属 + 点击跳转带 `from=ledger`（`course`/`lesson`/`article`/`quiz`） |
| `apps/mobile/src/pages/course/detail.vue` | 修改 | `onLoad` 增 `from=ledger` 分支：从 `repo.getSubmission` 取行 → `containerFormFromLedger` 渲染；缺行优雅退化 |
| `apps/mobile/src/pages/lesson/detail.vue` | 修改 | 同上（lesson） |
| `apps/mobile/src/pages/article/article.vue` | 修改 | `onLoad` 增 `from=ledger` 分支：正文取台账行 `body_md` |
| `apps/mobile/src/pages/quiz/quiz.vue` | 修改 | `onLoad` 增 `from=ledger` 分支：题组取台账行 `question_json` |
| `apps/mobile/src/manifest.json` | 修改 | 版本 `0.15.0`/`20` → `0.16.0`/`21`（Task 5） |

**不改动（硬边界）**：`core/repo.ts`、`core/submit.ts`、`core/sync.ts`、`core/course-edit.ts`、`core/container-view.ts`、`core/types.ts`、`internal/**`、`vectors/**`、`docs/**`（除本册/计划回填）。

---

### Task 1: 「我创建的」视图模型 `core/my-created.ts`

**Files:** Create `apps/mobile/src/core/my-created.ts`；Create `apps/mobile/src/core/my-created.test.ts`

- [ ] **Step 1: 写失败的测试** —— 先读 `apps/mobile/src/core/types.ts:109-127` 确认 `MySubmissionRow` 确切字段，据此写用例：① `statusLabelOf('pending')==='待补发'`、`'failed'==='失败'`、`'sent'==='已同步'`；② `buildMyCreatedView` 的去重四象限——`sent` 且 `packItemIds` **含**该 id ⇒ **不列出**；`sent` 且**不含** ⇒ 列出且 `statusLabel==='已同步'`；`pending` 与 `failed` **无论** `packItemIds` 是否含都列出（`failed` 行保留 `reason`）；③ `type==='tag'` 的行**被排除**；④ 空台账返回 `[]`；⑤ 输出顺序与输入一致（`queued_at ASC` 由 `listSubmissions` 保证，本函数不重排）。
- [ ] **Step 2: 跑测试确认失败** —— `cd apps/mobile; npx vitest run src/core/my-created.test.ts`。判据：报「找不到模块 `./my-created`」。
- [ ] **Step 3: 写实现** —— 只依赖 type-only import（`MySubmissionRow`），**不 import `'uni'`**。定义：

  ```ts
  export type MyCreatedType = 'article' | 'quiz' | 'course' | 'lesson';
  export interface MyCreatedRow {
    itemId: string; type: MyCreatedType; title: string;
    state: 'pending' | 'sent' | 'failed'; reason: string; statusLabel: string;
  }
  export function statusLabelOf(s: MySubmissionRow['state']): string; // 待补发 | 失败 | 已同步
  export function buildMyCreatedView(rows: MySubmissionRow[], packItemIds: Set<string>): MyCreatedRow[];
  ```

  `buildMyCreatedView`：`rows.filter(r => r.type !== 'tag')` → 对每行：`sent` 且 `packItemIds.has(r.itemId)` ⇒ 跳过；否则产出 `MyCreatedRow`（`reason` 取 `r.reason ?? ''`，`statusLabel = statusLabelOf(r.state)`）。

- [ ] **Step 4: 跑测试确认通过** —— `cd apps/mobile; npx vitest run src/core/my-created.test.ts; npx tsc --noEmit`。判据：本文件全绿、`tsc` 干净。

---

### Task 2: 台账行集 → 详情渲染的桥

**Files:** Modify `apps/mobile/src/core/my-created.ts`；Modify `apps/mobile/src/core/my-created.test.ts`

- [ ] **Step 1: 写失败的测试** —— ① `ledgerSegmentsOf(row)`：`segments_json` 为 `'[{"seq":-1,"kind":"attr.cover","text":"b1"}]'` ⇒ 返回一条 `SegmentRow`（补 `itemId` / `contentHash:''`）；**空串**与**坏 JSON** 一律返回 `[]`（不抛）；② `containerFormFromLedger(courseRow)`：给定含 `attr.instructor` / `digest` / 两条子项行的 `segments_json`，产出的 `ContainerForm` 的 `instructor` / `digest` / `children` 与 `loadContainerForm`（读同样行集时）**逐字段一致**（用 `core/fakes.ts` 的假 `LocalRepo` 造同源数据，或直接对照 `attrsOf`/`digestOf`/`childrenRowsOf` 的期望）；③ `course` 行的 `bodyMd` 恒 `''`（课程不吃正文），`lesson` 行取 `attr.body_md`。
- [ ] **Step 2: 跑测试确认失败** —— `cd apps/mobile; npx vitest run src/core/my-created.test.ts`。判据：`ledgerSegmentsOf` / `containerFormFromLedger` 不存在。
- [ ] **Step 3: 写实现** —— 复用 `core/container-view.ts` 的 `attrsOf` / `digestOf` / `childrenRowsOf` 与 `core/course-edit.ts` 的 `ContainerForm` / `emptyContainerForm`（type-only import 或函数 import，**不修改**这两个模块）。`ledgerSegmentsOf(row)` = 「空串 / `JSON.parse` 失败 ⇒ `[]`；否则 `map` 为 `SegmentRow`（`itemId:row.itemId`, `seq:Number(...)`, `kind:String(...)`, `text:String(...)`, `contentHash:''`）」。`containerFormFromLedger(row)` = `emptyContainerForm(row.type as ContainerType, row.itemId)` → 用 `attrsOf(segs)` / `digestOf(segs)` / `childrenRowsOf(segs)` 回填 —— **与 `loadContainerForm` 的字段映射逐行同构，只把数据源由 `repo` 换成 `segments_json`**。
  - 注意 `row.type` 进入本函数时已由 `MyCreatedType` 收窄为 `course|lesson`，故可直接作 `ContainerType`；`contentHash:''` 只用于复用读取器，不参与任何哈希（本册不写包表、不入队）。

- [ ] **Step 4: 跑测试确认通过** —— `cd apps/mobile; npx vitest run src/core/my-created.test.ts; npx tsc --noEmit`。判据：全绿 + `tsc` 干净。

> 若 `container-view.ts` 的读取函数签名与预期有出入，**按其真实签名对齐**（读文件确认），**不要改** `container-view.ts` 与 `course-edit.ts`。

---

### Task 3: 课程页「我创建的」区 + 状态标记 + 点开跳转与渲染

**Files:** Modify `apps/mobile/src/pages/course/course.vue`；Modify `apps/mobile/src/pages/course/detail.vue`；Modify `apps/mobile/src/pages/lesson/detail.vue`；Modify `apps/mobile/src/pages/article/article.vue`；Modify `apps/mobile/src/pages/quiz/quiz.vue`

- [ ] **Step 1: 课程页新增区段** —— 在 `course.vue` 模板顶部（标题栏 / 搜索框之下、分类分组之上）新增 `「我创建的」` 区：
  - `load()`（`course.vue:81-117`）内追加：`const subs = await repo.listSubmissions();`、`const packIds = new Set((await repo.listItems()).map(i => i.itemId));` → `myCreated.value = buildMyCreatedView(subs, packIds);`（`repo.listItems()` 已在 `load()` 里取过，复用同一份 `all`，避免重复查询）。
  - 模板：`v-for` 遍历 `myCreated`，每行显示 `type` 中文标签（课程 / 课时 / 文章 / 题库）· `title` · 状态徽标（`statusLabel`；`failed` 行附 `reason` 红字，样式照 `myitems.vue:113`）。**`<template>` 内禁止 `.value` 写法**（发布前硬检查）。
- [ ] **Step 2: 跳转带 `from=ledger`** —— 新增 `openMyCreated(row: MyCreatedRow)`：按 `row.type` 跳既有路由并附 `&from=ledger`：`course` → `course/detail?courseId=`、`lesson` → `lesson/detail?courseId=&lessonId=`、`article` → `article/article?itemId=`、`quiz` → `quiz/quiz?itemId=`（路由形态照 `course.vue:157-167` / `myitems.vue:86-93`）。行 `@click` 绑 `openMyCreated`。
- [ ] **Step 3: 详情页 `from=ledger` 分支** —— 四页 `onLoad` 各增一条分支：
  - `course/detail.vue` / `lesson/detail.vue`：`query.from === 'ledger'` 时改走 `const row = await repo.getSubmission(itemId)`；`row` 存在则 `const form = containerFormFromLedger(row)`，用 `form` 的字段（`title`/`digest`/`instructor`/`difficulty`/`durationSec`/`attachments`/`bodyMd`/`children`）填充既有模板变量，**跳过** `repo.getItem` / `repo.listSegments` 路径；`children` 行的标题用 `form.children` 里的 `itemId`（台账行集不含子项标题 → 标题回落 `itemId`，与 `course/detail.vue:121` 的既有「本地未同步」回落同口径）。
  - `article/article.vue`：`from=ledger` 时正文取 `row.bodyMd`、标题取 `row.title`，**不读** `repo.getArticle`。
  - `quiz/quiz.vue`：`from=ledger` 时题组取 `row.questionJson`，**不读** `repo.getQuiz`。
  - **缺行退化**：`row === null` ⇒ 沿用各页既有错误 / 空态提示，**不抛白屏**（册子 §3.3 / §8 边界 5）。
- [ ] **Step 4: 构建与硬检查** —— `cd apps/mobile; npx tsc --noEmit; npm run build:h5`。判据：`tsc` 干净、`build:h5` 通过；再跑发布前硬检查 `grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue`（无输出）。

> 详情页改造只加**一条分支**，不重构既有同步路径；`from=ledger` 缺省时不改变任何既有行为（老入口零影响）。

---

### Task 4: 空态与「已同步」去重展示

**Files:** Modify `apps/mobile/src/pages/course/course.vue`

- [ ] **Step 1: 空态** —— `myCreated.length === 0` 时该区显示一行灰字「还没有我创建的内容」（样式照 `course.vue:181` 的 `.hint`）；区标题带计数 `我创建的（N）`。
- [ ] **Step 2: 「已同步」标记行的展示** —— `buildMyCreatedView`（Task 1）已把「`sent` 且包表没有」的行标 `已同步` 列出；本步只需确认课程页**不重复展示**这些行：`sent` 且 `packIds` 含的行已在 Task 1 被过滤掉，故「课程 / 未归类 / 独立内容」诸区与「我创建的」区**不会同 id 重复**（册子 §3.4 / AC 4）。**不新增**额外折叠逻辑（去重全在 `my-created.ts` 内，页面只消费结果）。
- [ ] **Step 3: 状态样式** —— `pending` 徽标用待发色（`#b7791f`）、`failed` 用错误色（`#c53030`）、`sent` 用中性灰（`#888888`），照 `myitems.vue:108-117` 的既有色值。
- [ ] **Step 4: 回归** —— `cd apps/mobile; npx vitest run; npx tsc --noEmit; npm run build:h5`。判据：全部既有用例仍绿（**不少于 23 文件 / 230 用例**）+ 新增用例全绿、`tsc` 干净、构建通过。

---

### Task 5: 门禁与收口

**Files:** Modify `apps/mobile/src/manifest.json`；Modify `docs/superpowers/plans/2026-09-30-base-governance-visibility-plan.md`（执行实况）

- [ ] **Step 1: Go 三连（确认零节点改动没破坏任何东西）** —— 仓库根 `go build ./...` / `go vet ./...` / `go test ./...`。判据：全绿。**本册不改 `internal/**`**，此步只为佐证（`git diff --stat` 应显示 `internal/` 零改动）。
- [ ] **Step 2: 手机端三连** —— `cd apps/mobile` → `npx vitest run`（基线下限 **23 文件 / 230 用例**，只增不减）/ `npx tsc --noEmit` / `npm run build:h5`。判据：全绿。
- [ ] **Step 3: 一键复跑** —— `scripts/acceptance-d.ps1`（D 组 TC-D01–TC-D07 全 PASS）。判据：全 PASS。
- [ ] **Step 4: 发布前硬检查 + 版本** —— ① 模板 `.value` 扫描无输出（`grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue`）；② `npm run build:app` 产物 `\.value\.value` 计数为 0；③ `apps/mobile/src/manifest.json` 版本改为 `0.16.0` / `21`。**本册零节点改动 ⇒ 不交叉编译 / 不部署 `/opt/base/based`**；发布四步（云打包 → 上传 `/opt/appdl/base-0.16.0.apk` → 落地页整页重写改指 → `based release` 签发落 `/opt/base-cache/data/release.json`）随批次 `#45` 统一执行。
- [ ] **Step 5: 文档收口** —— 在本文末「执行实况」节回填：实际改动文件清单、`git diff --stat`（`internal/` 零改动的佐证）、门禁跑分（文件数 / 用例数）、发布前硬检查结果、真机验收状态。

---

## 执行实况（待执行后回填）

> 本节在实施完成后按 `#41` / `#46` 计划的体例回填：① 落地任务清单与偏差；② 门禁实测数字（mobile 文件数 / 用例数、Go 三连）；③ 发布前硬检查输出；④ 发布四步与线上验签（随批次执行）；⑤ 真机验收（AC 8）结论。**执行前保持占位。**

| 项 | 内容 |
| --- | --- |
| 落地任务 | 待填 |
| 偏差 / 更正 | 待填 |
| 门禁跑分 | 待填（`internal/` 零改动佐证） |
| 发布前硬检查 | 待填 |
| 发布与验签 | 待填（随批次 `0.16.0`/`21`） |
| 真机验收 | 待填（AC 8） |
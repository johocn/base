# F3–F9 批次执行编排（App 实测问题清单收口）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 App 实测暴露的 9 条问题（F1–F9）里剩余的 F3–F7、F9 归成**一个批次**：先出齐册子与实施计划（本批次文档全部落库并登记 `docs/README.md`），再按 F3 → F4 → F5 → F6 → F7 → F9 的固定顺序统一执行，最后**单次发布**（`0.16.0` / `21`）。

**Architecture:** 本批次不改内容包规范 v1、不 bump `schema_version`、不新增 `source` / `type` 枚举值、不加配置项。F6 / F9 若引入新的 `attr.*` kind，一律走 `#40` 已立的槽位机制（`seq<0` 属性行），Go / TS 两份镜像 + `vectors/v1/attrs.json` 同步；F5 走 `#44` 已定的双端 Markdown 管线；F3 / F4 / F7 只动手机端与既有接口的调用面。

**Tech Stack:** Go 1.2x（`internal/protocol`、`internal/store`、`internal/httpapi`、`internal/markdown`）／ TypeScript + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `vectors/v1/*.json` 双端契约向量。

**上游 spec:** 各 F 条自有册子（见 §2 映射表）；`#40`（槽位机制）、`#44`（正文渲染口径）、总纲为共同上游。

---

## 1. 开工前已核实的现状（执行时不要重新调研，直接用）

| 事实 | 位置 |
| --- | --- |
| 槽位机制：`AttrKindPrefix` / 6 个 `AttrKey*` 常量 / `AttrKindSet` / `IsAttrKind` / `AttrLine`·`AttrSlot` / `AssignAttrSeqs`（按 kind 字典序自 -1 递减，`attr.attachment` 多行占连续递减区间）/ `AttrSeqsCanonical`（顺序无关） | `internal/protocol/attrs.go:6-111` |
| 槽位机制的 TS 镜像（逐字节同构，含 `DIFFICULTY_CHOICES`、`segmentsContentHash`） | `apps/mobile/src/core/attrs.ts:12-120` |
| 契约向量 `vectors/v1/attrs.json`（`version` + `cases[{lines,slots}]`）；Go 读法 `filepath.Join("..","..","vectors","v1",name)`、TS 读法 `new URL('../../../../vectors/v1/x.json', import.meta.url)`（层深 4） | `internal/protocol/attrs_vector_test.go:9-45`、`apps/mobile/src/core/attrs.test.ts:24-40` |
| 投稿校验三区间铁律 + `AttrSeqsCanonical` 判据 | `internal/httpapi/submit.go:84-122` |
| `handleSubmitPost` 类型分支：`article` / `quiz` / `tag` / `course` / `lesson` | `internal/httpapi/submit.go:185-235` |
| 容器落库：`SegmentSubmission` / `UpsertSegmentSubmission`（先删同 `item_id` 旧行再按 seq 写入 = 整体替换） | `internal/store/submission.go:98-160` |
| 容器写入恒 `dist_class='public'` / `state='active'`——**不存在「未授权」状态**（F7 无闸门可建的根本原因） | `internal/store/submission.go:97-158` |
| 分类：导入器解析 front-matter `category` / `category_title` / `category_digest` → `validateCategories` → `rebuildCategories` 产 `category/<slug>` 行（`seq=0` 简介 + `seq>=1` 列 `course/<cid>`，`kind` 只允许 `course`） | `internal/importer/md.go:170-223`、`internal/importer/course.go:55-82,197-277` |
| 手机端分类读取：`splitCategories`（`source=category`）+ `coursesOfCategory`（读 `seq>=1` 清单、悬空引用静默跳过） | `apps/mobile/src/core/course-tree.ts:33-51` |
| 容器编辑表单：`ContainerForm`（`itemId`/`type`/`title`/`digest`/`cover`/`instructor`/`difficulty`/`durationSec`/`attachments`/`bodyMd`/`children`）、`emptyContainerForm`、`startNewCourse`、`startNewLesson`、`buildContainerSegments`、`loadContainerForm`、`saveContainer` | `apps/mobile/src/core/course-edit.ts:48-147` |
| 容器读取视图：`ContainerAttrs` / `emptyAttrs` / `attrsOf`（未知 kind 与坏行静默忽略）/ `digestOf` / `childrenRowsOf` / `childCounts` / `firstLine` / `lessonDigest` | `apps/mobile/src/core/container-view.ts:24-119` |
| 课程页模板四段（标题栏 / 搜索 / 分类分组 / 未归类 / 独立内容）、`load()` 的 `repo.listItems()` → active 过滤 → `splitCourses` / `splitCategories` / `coursesOfCategory`、导航（`/pages/course/edit`、`/pages/course/detail?courseId=`） | `apps/mobile/src/pages/course/course.vue:1-50,81-117,157-167` |
| 台账（投稿队列兼「我的条目」列表本体）：`LocalRepo` 六方法 `saveSubmission` / `listSubmissions` / `getSubmission` / `markSubmissionSent` / `markSubmissionFailed` / `removeSubmission`；DDL 列 `item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at` | `apps/mobile/src/core/repo.ts:17-97,126-131,511-553,648-667` |
| 投稿编排 `writeLedger` / `enqueueOrSend`（送达 `sent` / 断网·429·5xx `pending` / 其余 4xx `failed`）、`flushSubmissions`（只取 `pending`，`queued_at ASC`） | `apps/mobile/src/core/submit.ts:25-37,271-330,340-395` |
| 「我的条目」页三区 + `onShow` 刷新 + 打开/编辑 | `apps/mobile/src/pages/myitems/myitems.vue:7-47,65-93` |
| 名册人数上限 `RosterTopN = 10`，名册由 `deriveRoster` 实时派生 | `internal/store/contributor.go:14-16,62-86` |
| 文件选择：`UniGlobal.chooseFile` 声明为**可选**（注释称 App 3.4.0+ 提供）、`pickLocalFile()` 调 `uni.chooseFile`（取消 → `null`；非取消错误 → 抛 `Error('选择文件失败…')`；成功 → `{name, bytes}`） | `apps/mobile/src/platform/uni.ts:88-96,446-483` |
| 文件选择调用点：`uploadOne` / `pickCover` / `addAttachment`（错误只写页面 `error.value`，**无本地落盘日志**） | `apps/mobile/src/pages/course/edit.vue:127-158`、`apps/mobile/src/pages/lesson/edit.vue:148-178` |
| 封面 UI 与附件 UI（提示「单文件 ≤ 8 MiB」） | `apps/mobile/src/pages/course/edit.vue:18-20,48-54` |
| 上传：`BlobError` + `uploadBlob()` | `apps/mobile/src/core/blob.ts:24-90` |
| 自检：`fs.bigfile` / `fs.meta` 探测置 `fsOk`，**无**文件选择 / 相册探测项 | `apps/mobile/src/core/selfcheck.ts:165-210` |
| 课时正文为裸 `<textarea v-model="form.bodyMd">`；`addCarrier()` 只 push `ChildRow`（`itemId` 可空）——**无搜索、无点选** | `apps/mobile/src/pages/lesson/edit.vue:12-16,184-188` |
| 正文渲染三端落点（F5）：门户 `pageData.Article{Paragraphs []string}` / `handleArticlePage` / `splitParagraphs`；模板 `{{range .Paragraphs}}<p>{{.}}</p>{{end}}`；治理看板 `<pre>{{.Edit.BodyMD}}</pre>` 保持源文本；手机端 `pages/article/article.vue` 模板与 `onLoad` 的 `split('\n\n')` | `internal/httpapi/web.go:76-84,108-138,172-182`、`web/templates/article.html:2-9`、`web/templates/governance.html:23-29`、`apps/mobile/src/pages/article/article.vue:27-32,82-99` |
| 手机端版本现值 `0.15.0` / `20`（本批次基线） | `apps/mobile/src/manifest.json:5-6` |
| 门禁：仓库根 `go build ./...` / `go vet ./...` / `go test ./...`；`cd apps/mobile` → `npx vitest run`（基线 **23 文件 / 230 用例**）、`npx tsc --noEmit`、`npm run build:h5`；一键 `scripts/acceptance-d.ps1` | `apps/mobile/package.json`、`scripts/acceptance-d.ps1` |
| 发布前硬检查：`apps/mobile/src/pages/*/*.vue` 不得出现 `.value` 模板写法（`grep -nE '="[^"]*\.value|\{\{[^}]*\.value'` 必须无输出），并保留 `build:app` 产物 `\.value\.value` 计数为 0 的硬检查 | `docs/README.md:100`（更正 14 ①） |
| 部署：`root@118.190.217.242`（SSH 别名 `me`）；`/opt/base/based` 被 `base.service` 与 `base-cache.service` 共用，替换必须 `mv` + `chmod 0755`（`cp` 会 `Text file busy`）；探活走 HTTPS 443（纯 HTTP 打 8081/8083 会回 400） | 各册「版本与发布」节 |
| 发布四步（凡手机端有用户可见改动即强制）：云打包 APK → 上传 `/opt/appdl/base-<ver>.apk` → 落地页整页重写改指 → `based release` 签发落 `/opt/base-cache/data/release.json` | `docs/README.md:106`（发布缺口补做） |

**环境注意（Windows PowerShell 5.1，无 `pwsh`）：** 不支持 `&&`（用 `;`）与 heredoc（commit 消息写临时文件 + `git commit -F`）；新增 `.ps1` 必须带 UTF-8 BOM，且编辑工具保存会剥掉 BOM，每次改动后须回补。

**工作区注意：** 有未提交的 `.gitignore` 改动与未跟踪的 `based-linux-amd64`，**不要动、不要 add**。每次提交只 `git add` 本任务涉及的具体文件。

---

## 2. 批次总览（F1–F9 映射）

| # | 问题（用户原话口径） | 归属 | 册子 | 计划 | 版本 |
| --- | --- | --- | --- | --- | --- |
| F1 | 新建课程同时填「标题 / 简介 / 讲师 / 难度 / 时长」保存报 **HTTP 400** | **已完成**（`01b33a6`：`AttrSeqsCanonical` 判据改为顺序无关，`validateSubmitSegments` 的 ≥2 属性行路径补回归） | — | — | 已随 `0.15.0` 上线 |
| F2 | 新建内容在课程页 / 文章页看不到 | **并入 F7**（可见性问题同源，不另立条目） | 见 F7 | 见 F7 | `0.16.0` |
| F3 | App 里图片 / 附件**加不上** | 本批次 | `#46` | `#47` | `0.16.0` |
| F4 | 添加载体要支持**搜索 + 点选** | 本批次 | `#46`（与 F3 同一册） | `#47` | `0.16.0` |
| F5 | 课时正文没有富文本，只有 Markdown 保存；能否更丰富 / 加快捷键 | 本批次 | `#44`（已定稿） | `#48` | `0.16.0` |
| F6 | 课程分类**没有入口** | 本批次 | `#49` | `#50` | `0.16.0` |
| F7 | 「<10 人创建人授权通过、≥10 人投票」的治理口径 + 我创建的内容看不到 | 本批次 | `#51` | `#52` | `0.16.0` |
| F8 | 同 F2 类（新建内容可见性） | **并入 F7** | 见 F7 | 见 F7 | `0.16.0` |
| F9 | 条目图章（活动 / 悬赏 / 辩论 / 置顶 …）+ 标题高亮 | 本批次 | `#53` | `#54` | `0.16.0` |

**F1 无需再动。** 该条是本批次的前置缺陷（`01b33a6` 已修），本批次**不得回退或重写** `AttrSeqsCanonical` 的判据强度：seq 取值、`attr.attachment` 的连续递减区间、同 kind 内 text 升序仍须逐字节吻合。

**F2 / F8 的处置口径**：两条都是「新建之后在浏览面看不到」，与 F7 的可见性改造同源，故不另立册子与计划，统一在 F7 收口。F7 的落点必须同时满足这两条的验收（新建的课程 / 课时 / 内容在课程页「我创建的」区**立刻可见**，并带 `pending` / `failed` 状态提示）。

---

## 3. 执行顺序与依赖

**写文档顺序（本批次当前阶段）**：`#45`（本文）→ `#46` → `#47` → `#48` → `#49` → `#50` → `#51` → `#52` → `#53` → `#54`。每份写完即 commit + push。

**执行顺序（文档全部定稿后）**：

```
F3 ──> F4 ──> F5 ──> F6 ──> F7 ──> F9 ──> 单次发布 0.16.0/21
 │      │      │      │      │      │
 │      │      │      │      │      └─ 最后做：无下游依赖
 │      │      │      │      └─ 依赖 F6（分类可见性）
 │      │      │      └─ 独立（新增 attr.category，双端 + 向量）
 │      │      └─ 独立（#44 已定稿，只缺计划）
 │      └─ 依赖 F3（同一对编辑页，F4 在 F3 修好选文件后再改载体选择）
 └─ 先做：定位「加不上」的根因，是 F4 与 F5 的工具链前提
```

依赖理由：

1. **F3 先做**：它既是用户最痛的一条，也是 F4 / F5 的前提——编辑页若连「打开文件选择器」都不通，后面加多少按钮都白搭。F3 的产物是「可读的错误 + 本地日志 + 运行时能力探测」，这三个是后续排查的真机取证手段。
2. **F4 紧随 F3**：同一对编辑页文件（`course/edit.vue` / `lesson/edit.vue`），改点重叠，分两次提交但连续做可避免冲突。
3. **F5 独立**：`#44` 册子已定稿、上游回填已完成（`6f2584a`），只缺计划；实施面（`internal/markdown/` + `core/markdown.ts` + `vectors/v1/markdown.json` + 三端落点）与 F3/F4/F6/F7/F9 零交集。
4. **F6 在 F5 之后**：分类是**属性槽位**新增（`attr.category`），与 F5 的门户渲染同样要动 `web.go` 的 `pageData`——先渲染后分类可让 F6 的分类分组落在已改好的展示面上，少改一次。
5. **F7 在 F6 之后**：F7 的课程页新增「我创建的」区必须与 F6 的分类分组**同处一个页面结构**（`course.vue` 的 `load()` 与模板），先分类后可见性，避免同一文件反复重构。
6. **F9 最后**：图章与标题高亮是纯展示增量（新增 `attr.badge` / `attr.title_color` 两个槽位），它依赖「条目已经能在正确的页面结构里被渲染」——即 F5（渲染）与 F6/F7（页面结构）都就位后再挂，返工面最小。

**做计划时的硬规则：** 若某份计划与既有册子冲突（尤其 `#40 §2.1` 槽位表、`#36` 分类契约、`#37` tag 语义、`#44` 渲染口径），**先改上游册子再写计划**，不得只改计划。

---

## 4. 文件结构（先定边界，再拆任务）

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `specs/2026-09-30-base-edit-surface-fix-design.md` | 创建 | `#46`：F3（App 图片 / 附件加不上：诊断 + 预置双分支）+ F4（载体候选源 = 本机已下载条目 + 关键词搜索 + kind 过滤 + 点选回填） |
| `plans/2026-09-30-base-edit-surface-fix-plan.md` | 创建 | `#47`：F3 + F4 的实施任务 |
| `plans/2026-09-30-base-markdown-render-plan.md` | 创建 | `#48`：F5 的实施任务（册子 `#44` 已定稿） |
| `specs/2026-09-30-base-course-category-attr-design.md` | 创建 | `#49`：F6（分类降为课程自身属性槽位 `attr.category` + 双来源优先级） |
| `plans/2026-09-30-base-course-category-attr-plan.md` | 创建 | `#50`：F6 的实施任务 |
| `specs/2026-09-30-base-governance-visibility-design.md` | 创建 | `#51`：F7（不建闸门；课程页「我创建的」区 + 名册上限口径登记） |
| `plans/2026-09-30-base-governance-visibility-plan.md` | 创建 | `#52`：F7 的实施任务 |
| `specs/2026-09-30-base-badge-title-color-design.md` | 创建 | `#53`：F9（`attr.badge` 手动图章 + `attr.title_color` 标题高亮） |
| `plans/2026-09-30-base-badge-title-color-plan.md` | 创建 | `#54`：F9 的实施任务 |
| `docs/README.md` | 修改 | §3 清单表（`#45`–`#54` 十行）、§4 依赖顺序、§5 当前阶段 |

**代码落点（执行阶段才动，本阶段只登记在计划里）**

| 文件 | 动作 | 归属 |
| --- | --- | --- |
| `apps/mobile/src/platform/uni.ts` | 修改 | F3（`pickLocalFile` 双分支 + 可读错误）、F4（候选源查询入口，若需） |
| `apps/mobile/src/core/selfcheck.ts` | 修改 | F3（新增文件选择 / 相册能力探测项） |
| `apps/mobile/src/pages/course/edit.vue`、`apps/mobile/src/pages/lesson/edit.vue` | 修改 | F3（错误可见 + 本地日志）、F4（载体搜索与点选）、F5（正文工具栏 + 实时预览） |
| `apps/mobile/src/core/course-edit.ts`、`container-view.ts`、`repo.ts` | 修改 | F4（候选源）、F6（`attr.category` 读写）、F7（台账行集本地渲染）、F9（`attr.badge` / `attr.title_color` 读写） |
| `apps/mobile/src/core/attrs.ts`、`internal/protocol/attrs.go`、`vectors/v1/attrs.json` | 修改 | F6 / F9（新增 `attr.*` kind，**双端 + 向量三处同步**） |
| `internal/markdown/`、`apps/mobile/src/core/markdown.ts`、`vectors/v1/markdown.json` | 创建 | F5 |
| `internal/httpapi/web.go`、`web/templates/*.html` | 修改 | F5（`renderBody` 直出 + 7 个色类）、F6（分类分组可选） |
| `apps/mobile/src/pages/course/course.vue`、`pages/article/article.vue`、`pages/lesson/detail.vue` | 修改 | F5（阅读面渲染）、F6（分类入口）、F7（「我创建的」区）、F9（图章与标题色） |

---

## 5. 单次发布口径（批次收口）

- **版本**：`0.16.0` / `21`（基线 `0.15.0` / `20`）。整批**只发一次**——批内各 F 条不单独发布，避免同一批改动反复签 APK。
- **发布四步（强制）**：云打包 APK → 上传 `/opt/appdl/base-0.16.0.apk` → 落地页整页重写改指 → `based release` 签发落 `/opt/base-cache/data/release.json`。
- **节点二进制**：F5 / F6 / F9 任一若动了节点侧（`internal/httpapi/web.go`、`internal/markdown/`、`internal/protocol/attrs.go`），则**必须**交叉编译并部署：`GOOS=linux GOARCH=amd64 go build -o based-linux-amd64 ./cmd/based` → `scp` → `mv` 覆盖 `/opt/base/based` + `chmod 0755`（保留回滚件 `based.bak-<旧版本>`）→ 重启 `base` 与 `base-cache` → 探活走 **HTTPS 443**。
- **发布前硬检查**：模板 `.value` 扫描无输出；`build:app` 产物 `\.value\.value` 计数为 0；`apps/mobile/src/manifest.json` 版本号已改为 `0.16.0` / `21`。

## 6. 门禁（每份计划收尾与批次收口各跑一遍）

| 门禁 | 命令 / 判据 |
| --- | --- |
| Go 三连 | 仓库根 `go build ./...` / `go vet ./...` / `go test ./...` 全绿 |
| 手机端三连 | `cd apps/mobile` → `npx vitest run`（**不少于 23 文件 / 230 用例**，批内新增用例只增不减）/ `npx tsc --noEmit` 干净 / `npm run build:h5` 通过 |
| 一键复跑 | `scripts/acceptance-d.ps1`（D 组 TC-D01–TC-D07 全 PASS） |
| 向量 | 新增 `attr.*` kind 或 Markdown 用例后，Go test 与 vitest **共读同一份 `vectors/v1/*.json`** 且全绿 |
| 发布前硬检查 | 见 §5 末条 |
| 批内回归 | 已完成册子的既有 AC **不得回退**：`#40` / `#41` 的课程与课时编辑全链、`#44` 的三端渲染一致性 |

## 7. 验收（批次级）

- **AC 1**：`docs/README.md` 四处同步——§3 清单表新增 `#45`–`#54` 十行（含「明确不做什么 / 依赖 / 状态」）、§4 依赖顺序「A 主线续册」段接上本批次、§5 当前阶段新增立册条目与「下一步」。任一行缺失即视为孤儿文档。
- **AC 2**：F3 的根因**有真机取证**（本地日志 + 可读错误 + 能力探测三件套），且**不得**在未复测前把根因写成「已定位」。
- **AC 3**：F4 的候选源只有本机已下载条目（`LocalRepo`），**不新增任何 HTTP 接口**；点选后自动填 `itemId` + `kind` 并回显只读标题。
- **AC 4**：F5 的共享向量全绿，三端（App 文章页 / App 课时页 / 节点门户）同一段正文渲染出的标签结构一致，消毒负例集合齐全。
- **AC 5**：F6 的分类**双来源优先级**在册子里定死（优先读 `attr.category`，缺失才回退导入器产的 `category/<slug>` 清单行），冲突口径明确；导入器路径不动。
- **AC 6**：F7 **不建审批闸门**（已核实不存在「未授权」状态），只做可见性；课程页「我创建的」区覆盖 `pending` / `failed` 行。
- **AC 7**：F9 图章全手动、多值落**单行** `attr.badge`（固定分隔符 + 字典序）；标题高亮落独立 `attr.title_color`，色名枚举**复用 F5 的 6 色**，标题仍纯文本。
- **AC 8**：批次收口——门禁全绿（§6）、发布四步完成、线上 `GET /v1/release` → `0.16.0`、`HEAD /dl/base-0.16.0.apk` = 200、`verifyRelease` = true。

## 8. 风险点

1. **双端漂移（F6 / F9 新增 kind）**：`attr.*` 的 `seq<0` 排布进 `content_hash`，两端不一致会**静默出新版本而不报错**。压舱石是 `vectors/v1/attrs.json`；老条目「无该行 ⇒ 排布不变、不破哈希」必须逐条验。
2. **F3 根因未定**：`uni.chooseFile` 在 App 端是否提供**无法静态判定**（平台声明为可选）。故 F3 必须按「诊断 + 预置双分支」写——运行时探测决定走相册 / 拍照类 API 还是 `chooseFile`，**不得**预先假定某一分支正确。
3. **F5 的三端一致与 XSS**：门户用 `template.HTML` 关转义，消毒是唯一出口；新增任何属性前必须先加负例用例。
4. **F7 的范围蔓延**：用户原话里的「<10 人创建人自授权 / ≥10 人投票」在多处代码里**并不存在**对应的拒绝状态。本批次只登记为现状口径说明（名册上限即 10），**不新造闸门**，否则会破 `#25` / `#27` 的既有契约。
5. **单次发布的收敛成本**：批内任何一个 F 条未收口都会阻塞发布。故每份计划必须自带「可独立验证」的 AC，任一条未过即在该条计划内解决，不带入发布。

---

## 9. 执行实况（批次收口）

执行方式：**子代理驱动**（每个 Task 一个全新子代理，Task 间做核对复查）。批内六条（F3+F4 `#47`、F5 `#48`、F6 `#50`、F7 `#52`、F9 `#54`）各自 Task 全部落地并逐一 commit + push，收口集中在 REL。

### 1. 批内提交链（全部已 push 到 `master`）

- F3+F4 `#47` → F5 `#48` → F6 `#50` → F7 `#52` → F9 `#54`；F9 六个 Task 的提交链为 `bfd09e3`(T1) → `4a66252`(T2) → `4498f29`(T3) → `59f2202`(T4) → `b5243d5`(T5) → `2cd83b6`(T6)，`1a3bacb..2cd83b6 HEAD -> master` 已推送。完整度见各计划「执行实况」。

### 2. 门禁实况（收口时全量复跑）

- 节点侧：`go build ./...` / `go vet ./...` / `go test ./...` **全绿**；`git diff --stat internal/importer` 无输出（导入器未动，符合 F6 册子约束）。
- 手机端：`npx vitest run` **28 文件 / 343 用例全绿**（基线 23 文件 / 230 用例）；`npx tsc --noEmit` 退出 0；`npm run build:h5` 与 `npm run build:app` 均 DONE。
- 发布前硬检查：模板 `.value` 扫描（`grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue`）**无输出**；`build:app` 产物 `app-service.js` 的 `\.value\.value` 计数 = 0（框架 vendor `uni-app-view.umd.js` 有 1 处，按 F7 口径独立记账）。
- 一键复跑：`scripts/acceptance-d.ps1` 的 TC-D01–TC-D07 **全 PASS**。

### 3. 发布产物（`0.16.0` / `21`）

| 项 | 值 |
| --- | --- |
| 版本改号 | `apps/mobile/src/manifest.json` → `versionName 0.16.0` / `versionCode 21` |
| APK | **27439912 字节** / sha256 `05233b8c56c11c3eb8d8abd2d53004a1fd9df977722bf7a2d4022278eea2f28b` |
| 证书 SHA1 | `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 0.6.0–0.15.0 一致，可覆盖安装） |
| 上传 | `/opt/appdl/base-0.16.0.apk`，远端 sha256 与本地逐字一致 |
| 落地页 | `/opt/appdl/index.html` 整页重写改指 0.16.0；实测线上入口为 **`http://118.190.217.242/dl/`**（`location /dl/` → appdl 静态服务），页内仅含 `base-0.16.0.apk`，无 `0.15.0` 残留 |
| release 文档 | `/opt/base-cache/data/release.json`（`based release -version-name 0.16.0 -min-version-name 0.8.0 -apk-url http://118.190.217.242/dl/base-0.16.0.apk -apk-file /opt/appdl/base-0.16.0.apk -out …`，`BASE_SIGN_KEY` 从 `/opt/base/base.secret.env` 载入未打印）；`/opt/base/data/release.json` 不存在（无游离副本） |
| 节点二进制 | **21813946 字节** / sha256 `0bb8a50dc88e07525ed01f7c963711d345ec45545eb0b130028469524908e000`；`mv` 原子替换 `/opt/base/based` + `chmod 0755`，旧件（21771639 字节 / `84b9738c…`）备份为 `/opt/base/based.bak-pre-0.16.0`；`base` 与 `base-cache` 重启后均 `active`，`ExecStart` 同指该二进制 |

### 4. 线上验证

`GET http://118.190.217.242/v1/release` → `version_name=0.16.0`、`min_version_name=0.8.0`、`apk_size=27439912`、`apk_sha256` 与本地逐字一致、`issuer=base-node-1`；`HEAD http://118.190.217.242/dl/base-0.16.0.apk` → `200` 且 `Content-Length=27439912` 与本地一致；只读探活 `/v1/comment` → 200、`/v1/proposal` → 200、`POST /v1/blob` → 400（非 404，新路由在线且无回归）、`/v1/blobzzz` → 404（反向对照）。

### 5. 执行期更正

1. **落地页线上入口**：§5 只写「落地页整页重写」，实测用户可见入口是 **`/dl/`**（nginx `location /dl/` → `127.0.0.1:8080` 的 appdl 静态服务，docroot `/opt/appdl`）——`location /` 反代的是缓存节点的**站点内容目录**，不是下载页。故验证一律以 `/dl/index.html` 为准。
2. **443 与 80 的 `/v1/release` 不同源**：`https://118.190.217.242/v1/release` 由 `base.service` 直供，回 `{"error":"本节点无升级信息"}`（源节点不落 release.json）；`http://118.190.217.242/v1/release` 经 nginx `location /` → `8083`（缓存节点）才回 `0.16.0`。§5 的「探活走 HTTPS 443」适用于节点路由存在性探活，**发布文档校验必须走 80**。
3. **证书指纹取证**：本机无 `keytool` / `apksigner`，改用 HBuilderX 自带 JRE 的 `D:\HBuilderX\plugins\amazon-corretto\bin\keytool.exe -printcert -jarfile <apk>` 读 v1 签名指纹。

### 6. 未实测（待人工）

见 `docs/README.md` §5「待人工」：`#47` 的 F3 真机复现与三结局判读 + F4 载体点选、`#48` 的 AC 1–8 三端渲染、`#50` 的 F6 分类分组、`#52` 的 F7「我创建的」（含 F2/F8 可见性）、`#54` 的 F9 图章与标题高亮；以及客户端 `verifyRelease` 对线上文档的实测验签（需真机执行）。
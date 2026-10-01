# base 容器编辑与失败行出路修复设计（A 主线 第 10 册 · 缺陷批次）

- 日期：2026-10-01
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`；直接上游 = `#40`（容器字段模型与编辑面）、`#56`（创作者可见性闭环：本地乐观落库 + 台账 + 一次性自愈迁移）、`#60`（上一批交付：行集预检 / 选文件探针 / `toPlusUrl` 的 `file://` 整串解析 / 免票删除）
- 范围：0.20.0 真机验收暴露的 5 条（Bug1 编辑页不回填、Bug2 选图报 `fs undefined`、Bug4 编辑提交失败、Bug5 失败行死胡同、Bug3 封面上传预览）
- 本册**不覆盖**：节点侧任何契约（`validateSubmitSegments` / `AttrSeqsCanonical` / 错误码 / `POST /v1/proposal` 一律不改）；内容包规范 v1；其余 4 处已有 `decodedId` 兜底的页面（article / quiz / tag / lesson-detail）的不动；iOS

## 0. 改版说明

### 0.1 2026-10-01 初版

**新增（本册首次定义）：**

- **参数解码下沉**（§2）：把「原样 id 查不到就按 `decodeURIComponent` 重试、并以命中的真实 id 覆盖 `form.itemId`」收进 `loadContainerForm` 内部，一处修复同时消灭「回填空」与「提交 400」两个症状。
- **台账失败行的出路矩阵**（§4）：列表页与详情页按 `state` 分配 编辑 / 重试 / 删除 / 复建 四种出路；**删除 = 台账行 + 本机乐观条目一起清**（新增 `LocalRepo.removeLocalContainer`）；**重试**新增 `core/submit.ts` 的 `retrySubmission`；**复建**复用编辑页并新增 `rebuildFrom` 入参。
- **封面上传预览**（§5）：上传成功即出缩略图，并把字节落到本地 + 登记 `blob_index`，使重进编辑页可回显；出口抽成封面 / 附件共用的一个小函数。
- **门禁补强**（§6）：现状 `typecheck = tsc --noEmit` **不检查 `.vue`**，加 `vue-tsc`。

**明确沿用、不改动：** `POST /v1/blob`（单块 multipart、字段名 `file`、上限 8 MiB、内容寻址幂等）与 `POST /v1/submit` 的容器分支；`#40 §2.1` 槽位表与 `seq<0` 分配规则、两条哈希口径；`#56` 的本地乐观落库（`upsertLocalContainer`）与台账三态语义、`local_only` 终态单向性；`LocalRepo` 其余方法语义与 `items` / `segments` / `my_submissions` 表结构；`detail.vue` 既有 `resolveBy` 取键口径（`#56 §2.5`）。

## 1. 范围与不做什么

| 做 | 不做 |
|---|---|
| §2：`loadContainerForm` / `startNewLesson` 前统一解码参数，`form.itemId` 恒为真实 id | 不重构其余 4 处各自的 `decodedId`（超出本次范围，避免无谓回归面） |
| §3：两处 `ctx.adapters.fs` → `ctx.opts.adapters.fs` | 不假定「掩码错误」之外**一定还有其他上传缺陷**——修完以真机复测为准（§7 风险 1） |
| §4：失败 / 待补发行 4 种出路（编辑 · 重试 · 删除 · 复建） | 不新增删除端点；不改台账三态语义；不给 `sent` 行开删除口（仍走既有 `remove` 提案） |
| §4：删除同时清本机乐观条目 | 不清理包表来源（`source !== 'local'`）的条目——那是节点已收录内容，删它属治理范畴 |
| §5：封面缩略图 + 重进回显 | 不做附件缩略图；不做点击看大图；不改附件「按 blob_id 从节点取回」的既有读法 |
| §6：`vue-tsc` 进 `typecheck` | 不顺手清理无关 `.vue` 的既有类型错（§7 风险 3 给退化路径） |

**批次硬约束（沿用 `#45 §4`）：** 不改内容包规范 v1、不 bump `schema_version`、不新增 `source` / `type` 枚举值、不加配置项、**零新 HTTP 接口**、不改 `#40` 槽位语义与两条哈希口径。

## 2. Bug1 + Bug4：编辑页回填与 id 解码

### 2.1 症状与根因（已定位）

- 症状 A：进「编辑课程」页，标题 / 简介 / 封面 / 课时清单**全部为空**。
- 症状 B：编辑后保存报 4xx。

根因同一条：`pages/course/edit.vue:204-215` 与 `pages/lesson/edit.vue:265-277` 直接拿 `query.courseId` / `query.lessonId` **原样**查库，而跳转方（`pages/course/detail.vue:264-266`）传的是 `encodeURIComponent(id)`，课程 id 形如 `course/<16hex>` 被编成 `course%2F<16hex>`：

1. `repo.getItem('course%2F…')` 查不到 → `loadContainerForm` 回空表单（症状 A）；
2. `emptyContainerForm(type, itemId)` 把这个**未解码头**当身份写进 `form.itemId`，提交时该 id 含 `%`、不合节点 id 形态 → 4xx（症状 B）。

对照：article / quiz / tag / lesson-detail 四页**都有** `decodedId` + 「先原样、后解码」的兜底（`detail.vue:185-202` 是其写法样例），唯两个编辑页漏了。

### 2.2 处置

解码下沉进 `core/course-edit.ts`（不 import `'uni'`，可在 Node 下测试）：

- 新增内部 `resolveId(repo, raw)`：先 `getItem(raw)`，为空且 `decodeURIComponent(raw) !== raw` 时再 `getItem(decoded)`；返回命中的真实 id 或 `null`。
- `loadContainerForm(repo, rawId, type)`：用 `resolveId` 拿到真实 id，**以真实 id 构造表单**（覆盖 `form.itemId`）；`resolveId` 为 `null` 时仍返回空表单（保持「条目不存在也得空表单，不抛」的既有语义，与 `repo.listSegments` 同口径）。
- `startNewLesson(courseId)` 的调用点（`pages/lesson/edit.vue:278-279`）先解码 `courseId`，避免生成 `course%2F…/lesson/…` 的坏 id。

**为何下沉而非在页面加一份 `decodedId`：** 页面加等于第 5、6 份复制；下沉后两个编辑页零解码代码，且 `form.itemId` 的合法性由 `course-edit.ts` 单点保证。

## 3. Bug2：日志出口字段错误

`pages/course/edit.vue:284` 与 `pages/lesson/edit.vue:329` 写的是 `ctx.adapters.fs`，但 `AppContext`（`platform/index.ts:10-16`）只有 `opts` / `repo` / `db` / `capabilities`，**没有 `adapters`**——适配器在 `ctx.opts.adapters`。

后果是双重的：

1. `recordEditFailure` 永远拿不到参数，**日志从未落盘**；
2. 这行在 `catch` 里二次抛错，把真实失败（选图 / 读文件 / 上传）**盖成** `Cannot read properties of undefined (reading 'fs')`——即用户看到的报错。

处置：两处改为 `ctx.opts.adapters.fs`。

**为何它没被门禁拦住：** `apps/mobile/package.json:11` 的 `typecheck` 是 `tsc --noEmit`，而 `tsc` **不解析 `.vue` 单文件组件**，项目也未依赖 `vue-tsc`。故 §6 一并补门禁。

## 4. Bug5：失败行出路矩阵

### 4.1 症状与根因（已定位）

- 「我创建的」列表（`pages/course/course.vue:19`）只在 `row.localOnly` 时给「删除」；
- 点进详情走 `from=ledger` 分支，`canEdit` 判据是 `row.state === 'sent'`（`pages/course/detail.vue:119`）⇒ `failed` / `pending` 行既无「编辑」也无「删除」。

两者相加 = 用户描述的死胡同：行常驻「我创建的」、显示「失败」、点进去一片空白。

补充事实：`saveContainer` 是**先** `upsertLocalContainer`（写 `items` + `segments`）**再**发网络（`course-edit.ts:266-283`），所以失败行的内容其实**本机已可读**——「编辑后重投」能直接复用现有编辑页，无需从 `segments_json` 另起一条加载路径。反之，只删台账行而不清 `items` / `segments`，该课程仍会出现在课程列表里，等于把死胡同挪了个位置。

### 4.2 出路矩阵

| 台账 state | 编辑 | 重试 | 删除 | 复建 | 说明 |
|---|---|---|---|---|---|
| `sent` | ✅（现状） | — | —（走既有 `remove` 提案） | — | 已收录内容，下架属治理 |
| `pending` | ✅ | ✅ | ✅ | — | 断网待补发；重试=立即补发这一条 |
| `failed` | ✅ | ✅ | ✅ | ✅ | 4xx 永久失败；复建仅在 id 非法时出现 |
| 任意 state 且 **id 非法** | ❌ | ❌ | ✅ | ✅ | 含 `%` 或不合 id 形态者不可原样重投 |

- **列表页**（`course.vue:19`）：删除入口判据由 `row.localOnly` 放宽为 `row.state !== 'sent' || row.localOnly`——**只增不减**，`localOnly` 行原有的删除入口一字不动地保留，`pending` / `failed` 行新增。
- **详情页**（`detail.vue` 的 `from=ledger` 分支）：按上表出动作；`canEdit` 判据由 `state === 'sent'`（`detail.vue:119`）放宽为「id 合法」。非 `sent` 行的「删除」直接调仓库；`sent` 行保持 `removeCourse`（`remove` 提案）不动。
- **表格读法**：末行（id 非法）**优先级最高**——任何 state 下 id 非法时，「编辑」与「重试」都不给（原样重投只会再被拒一次），只剩「删除」与「复建」。

### 4.3 三个新出口的实现口径

- **删除**：新增 `LocalRepo.removeLocalContainer(itemId)`——一个事务内 `DELETE FROM segments WHERE item_id=?` 与 `DELETE FROM items WHERE item_id=? AND source='local'`。**带 `source='local'` 守卫**：万一 id 与包内条目撞车，绝不误删节点已收录内容。页面顺序为 `removeSubmission(itemId)` → `removeLocalContainer(itemId)` → 重载列表。
- **重试**：`core/submit.ts` 新增 `retrySubmission(o, itemId): Promise<SubmitOutcome>`。读台账行 → 容器行复用既有 `containerSegmentsFromLedger`（`#56 §2.3` 归一化重建）→ 走既有 `submitItem` → 按结果 `markSubmissionSent` / `markSubmissionFailed`；`containerSegmentsFromLedger` 返回 `null`（数据还原不出）时走 `markSubmissionLocalOnly`，与 `runFlushSubmissions` 同一判据、同一文案。**不引入新的状态流转**：仍是既有的三态。
- **复建**：详情页为 id 非法的失败行给「复建为新课程」，跳 `pages/course/edit?rebuildFrom=<台账 id>`。编辑页在该分支下用 `containerFormFromLedger(row)` 回填内容，再把 `itemId` 换成 `startNewCourse()` 的新 id——**内容照搬、身份重生成**，这是「坏 id 不可救」时唯一的出路。
- **id 合法性判据**：客户端现有的 id 形态约束（`[a-z0-9][a-z0-9-]` 段、`course/<hex>`、`course/<hex>/lesson/<hex>`）；实现为 `core/course-edit.ts` 中一个纯函数 `isLegalContainerId(type, id)`，与复建分支共用。

## 5. Bug3：封面上传预览

- **立即预览**：`pickCover` 拿到字节后**立即**置 `coverPreview = 'data:image/*;base64,' + bytesToBase64(bytes)`（`platform/uni.ts:473`，H5 与 App 同一实现，无平台分支），`<image :src="coverPreview">` 当场可见，不必等本地落盘或节点返回。
- **重进回显**：上传成功后把字节写到 `${workDir}/blobs/<blobId>`（与 `core/sync.ts:241-243` 的块落盘**同一路径口径**），并 `repo.addBlob(blobId, `${itemId}/cover`, path, size, now)`；编辑页 `onLoad` 用 `repo.findBlobPathByItem(`${itemId}/cover`)` 取路径回显——与 `detail.vue:142-143` 读封面的键**逐字一致**（`path.startsWith('file://') ? path : 'file://'+path`），零新契约。
- **共用出口**：`core/course-edit.ts` 新增 `uploadAndStoreBlob(o, itemId, slot, picked)`（`o` = `{ adapters, repo, workDir }`），依次 `uploadBlob`（`core/blob.ts:51-91`）→ `adapters.fs.writeFile` → `repo.addBlob`，返回 `{ blobId, path }`；**封面与附件共用同一出口**，两个编辑页不再各写一份。分工写明：**「字节 → 上传落盘登记」进 `core`，「字节 → 预览 src」留页面**（`bytesToBase64` 属平台层，`core/*` 不引 `'uni'`）。
- 预览 src 有两个来源（刚上传 = 内存 dataURL、重进页 = `file://` 路径），共用同一个 `<image :src>`。
- 附件不做缩略图：附件多为文档，列表已有文件名，收益低。

## 6. 门禁补强

- `apps/mobile` 加 `vue-tsc` 依赖（`^2`），`apps/mobile/package.json` 的 `typecheck` 脚本**直接替换**为 `vue-tsc --noEmit`（不新增第二个脚本、不加配置项）。
- 最低要求：**本节改动涉及的两个编辑页必须在 `vue-tsc` 下干净**——§3 这类「不存在的字段」错误从此不再穿闸。

## 7. 已知边界与风险

1. **Bug2 的真实失败仍未知（最大风险）**：`ctx.adapters.fs` 只是**掩码**。它一旦修好，真实的 `stage=pick|read|upload` 才会进 `edit-surface.log`。真机复测若仍失败，按 `#46 §2.4` 的判读口径取证（`read` ⇒ 仍是临时路径未被 `toPlusUrl` 认下，即 `#60` 那处改动；`upload` ⇒ `POST /v1/blob` 侧）。**本册不预设其他根因，也不改读取实现。**
2. **「重试」对永久失败通常是再失败一次**：`failed` 行本就是 4xx 判死，重试只是给用户一个「再试一次」的确定动作；文案需说清「若仍失败，请编辑内容或复建」（复用 `SubmitError.message` 原样展示，不另造词）。
3. **`vue-tsc` 首次全量可能翻出既有 `.vue` 类型错**：若量大，退化为「只对本次改动文件过 `vue-tsc`」，**不顺手清理无关页面**（避免把缺陷批次变成重构批次）。
4. **`form.itemId` 下沉解码的回归面**：`detail.vue` 传入的已是解码态 id，`resolveId` 首次命中即返回，行为不变；「不存在的 id 得空表单、不抛」是**保留语义**（§2.2），既有断言不必改，AC 2 覆盖。
5. **删除的 `source='local'` 守卫会静默生效**：若某失败行的 `items` 行被包表覆盖成非 `local`，删除只清台账不清条目——这是刻意取舍（宁留一份数据，不误删已收录内容）。

## 8. 验收

| AC | 内容（方式） |
|---|---|
| 1 | `loadContainerForm` 传编码 id（`course%2F…`）能回填真实内容，且 `form.itemId` 为解码后的合法 id（vitest） |
| 2 | 传不存在 / 非法 id 仍得空表单、不抛（vitest） |
| 3 | `isLegalContainerId`：`course/<hex>`、`course/<hex>/lesson/<hex>` 合法；含 `%`、段长越界、大写、空段非法（vitest） |
| 4 | `retrySubmission`：`pending`→`sent`、永久失败→`failed`、还原不出→`localOnly`；不改三态语义（vitest + fakes） |
| 5 | `removeLocalContainer`：清 `segments` 与 `items`（`source='local'`）；`source!='local'` 时 `items` 保留（vitest） |
| 6 | 门禁：Go `build` / `vet` / `test` 全绿；mobile `vitest run` 全绿（只增不减）+ `vue-tsc --noEmit` 干净 + `build:h5` 通过；模板 `.value` 硬检查无输出（命令） |
| 7 | 真机 1：编辑已有课程 → 标题 / 简介 / 封面 / 课时清单**全部回填** |
| 8 | 真机 2：选封面 → 上传成功且**立即**出缩略图；退出再进编辑页缩略图仍在 |
| 9 | 真机 3：改完保存 → 成功，**不再 400** |
| 10 | 真机 4：制造一条失败行 → 详情页出现 编辑 / 重试 / 删除 |
| 11 | 真机 5：删除该失败行 → 从「我创建的」**与课程列表**都消失 |
| 12 | 真机 6：id 非法的失败行 → 复建为新课程成功，且新课程 id 合法 |
| 13 | 真机 7：若选图仍失败 → `edit-surface.log` 有 `stage` + `detail` 原文（即 §7 风险 1 的取证） |
| 14 | `uploadAndStoreBlob`：字节写 `${workDir}/blobs/<blobId>`，且 `addBlob(blobId, '<itemId>/cover')` 可被 `findBlobPathByItem('<itemId>/cover')` 取回（vitest + fakes） |
| 15 | 删除入口只增不减：`localOnly` 行与 `pending` / `failed` 行都出「删除」，`sent` 且非 `localOnly` 不出（vitest） |

## 9. 版本与发布

- 本册为**缺陷批次**，单次发布 **`0.20.1` / `26`**（基线 `0.20.0` / `25`）。仅动 `apps/mobile`，**零节点改动**（不交叉编译、不部署节点二进制）。
- 发布四步沿用既有口径：云打包 → 上传 `/opt/appdl` → 落地页改指 → `based release` 签发落缓存节点；线上核对 `GET /v1/release` 与 `HEAD /dl/base-0.20.1.apk`。

## 10. 文档登记

- 本文档登记为 `docs/README.md` 第 **61** 行；配套实施计划为第 **62** 行（由 writing-plans 产出后补登）。
- 上游回填：`#56 §2.5` 的取键口径由「详情页统一」扩为「详情页 + 两个编辑页（经 `loadContainerForm` 下沉）」；`#40 §6` 补一处指向本册（编辑面回填与出路）。

## 11. 发布前硬检查

- `grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue` 必须无输出。
- `build:app` 产物 `\.value\.value` 计数为 0。
- `git diff --stat -- internal/` 无输出（本册零节点改动）。

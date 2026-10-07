# app 容器 id 解码根治与失败提示（课时 400 修复）

* 日期：2026-10-07

* 直接上游：`specs/2026-10-01-base-container-edit-deadend-fix-design.md`（下称 #61）——本册是同一类 Bug 的复发补全，#61 修了「查库解码」但漏了「新建回落」

* 范围：`packages/core-ts`（course-edit.ts）+ `apps/mobile`（lesson/edit.vue、course/edit.vue）客户端修复；**节点零改动**（400 本身是节点正确拒绝）

* 本册**不覆盖**：课时级分类字段（数据模型无此概念，用户未选）；H5/app 光标与预览的其余差异点（仅预览渲染差异，不影响数据）

## 1. 背景与根因（取证）

app 端「课程 → 添加课时 → 保存」必得 400 `item_id_invalid`，H5 正常。链路：

1. `course/edit.vue:400` 跳转传 `encodeURIComponent(id)`；H5 vue-router 自动解码，**app onLoad 不解码**。
2. `lesson/edit.vue:546-547` 只解码了 courseId，**lessonId 漏了**（`decodedId` 是该页 L578-585 页内私有函数）。
3. core 层 `resolveId`（`packages/core-ts/src/course-edit.ts:231-242`）对**已存在**条目能解码命中（#61 修复），但**新课时**尚未落库、两级查找都未命中 → 返回 null → `loadContainerForm`（L247）**回落 rawId（编码态）** → `form.itemId = course%2F…%2Flesson%2F…`。
4. 提交 payload `item_id` 编码态 → Go `containerShapeOf` 按 `/` 切 1 段 → 400 `item_id_invalid`（`internal/httpapi/submit.go:205-209`）。H5 解码后形态正确，故仅 app 中招。
5. **不可自愈**：首次提交前 `saveContainer` 已本地乐观落库（L301-304，#56 §2.1 设计行为），孤儿行 itemId 为编码态；重进编辑 `resolveId` 对编码态原样命中 → 永远 400。
6. **提示不可见**：400 时 `out.message`（含服务端码）只写入 `notice.value`（`lesson/edit.vue:765-771`），渲染为保存按钮上方 13px 橙色行内小字（L236），无 toast。

## 2. 目标与非目标

**目标（用户定案：A2 根治 + Toast）**

1. 任何容器编辑入口（course/lesson）在 app 端拿到的 id 一律为解码态——core 兜底 + 页面显式双保险。
2. 存量编码态孤儿行可自愈：内容不丢，身份迁到正确 id，重投 200。
3. 提交失败必须 toast（含服务端错误码），行内详情保留。

**非目标**：节点侧校验改动（现状正确）；光标/预览其余 app 差异；分类功能（挂账）。

## 3. 方案

### 3.1 core 兜底（主修，`packages/core-ts/src/course-edit.ts`）

`loadContainerForm` 的 id 解析升级为**身份迁移语义**：

1. `resolveId(repo, raw)` 命中（raw 或 decoded 存在于库）→ 沿用现行为，返回命中 id。
2. 均未命中（新容器）：取 `candidate = decodeSafe(raw)`（幂等解码，try/catch 失败原样）。
3. **迁移分支**：若 `candidate !== raw` 且 `repo.getItem(raw)` 命中（即编码态孤儿行存在）→ 内容从 raw 行回填、**`form.itemId = candidate`**——重进即看到原内容，保存即落正确 id。
4. 都没有 → 空表单 + `form.itemId = candidate`。

`decodeSafe` 从 lesson/edit.vue:578-585 上提为 `course-edit.ts` 导出函数（纯 JS，core-ts 可承载），lesson/edit.vue 页内私有副本删除改 import。

### 3.2 页面入口显式解码（双保险，沿用 #61 §2 先例）

- `lesson/edit.vue` onLoad：`lessonId` 与 `courseId` 均过 `decodedId`（import 自 core-ts）。
- `course/edit.vue` onLoad（L207-226）：`courseId` 补过 `decodedId`。
- core 已兜底，页面这层是**防御纵深**：漏写不再致 4xx，但保留显式解码让 id 流转可读。

### 3.3 存量孤儿清理（一次性）

迁移分支解决「重进可救」；未被重进的孤儿行仍会出现在课程页课时列表顶部。加一次性清理：`repo.purgeIllegalContainers()`——删除 `items`/`segments`/`submissions` 中 `itemId` 不过 `isLegalContainerId(type, itemId)` 的行（判据复用 `course-edit.ts:111-116`，编码态是当前唯一已知非法形态）；bootstrap 时调用一次。安全性：迁移分支保证内容已可救回，清理只删「身份坏、内容已可迁移」的行；本地缓存非 append-only（`upsertLocalContainer` 先例），删除合规。

### 3.4 失败 Toast（`lesson/edit.vue` + `course/edit.vue` 同构处理）

`saveContainer` 返回 `ledgerState === 'failed'` 时：`uni.showToast({ title: out.message, icon: 'none' })` + 保留现有 `notice.value` 行内详情。message 已含服务端码（`mapSubmitFailure`，`submit.ts:231-244`），不重复拼接。

## 4. 契约边界

* 节点路由、校验、错误码**零改动**；payload 构造（`buildContainerPayload`）零改动。
* `resolveId` 对已存在条目的命中语义不变（#61 行为保持）。
* `isLegalContainerId` 判据不变，仅新增调用方（purge）。
* 台账状态机（sent/pending/failed）不变。

## 5. 验收标准

| # | 验收 | 手段 |
|---|---|---|
| 1 | `loadContainerForm`：编码态新 id → 返回解码态 itemId；编码态孤儿行存在 → 内容回填 + itemId 迁移 | core-ts vitest 新用例 |
| 2 | `decodeSafe` 幂等（已解码原样返回、坏编码原样返回） | core-ts vitest |
| 3 | 存量卡死课时：app 重进编辑 → 内容可见 → 保存 200 | 真机 |
| 4 | 课程页不再出现编码态孤儿行 | 真机（purge 后） |
| 5 | 保存失败（如断网时人工构造非法行）→ toast 弹出含错误码 | 真机 |
| 6 | 门禁：core-ts `tsc --noEmit && vitest run` 全绿；mobile `tsc --noEmit && vitest run && npm run build:h5` 全绿 | CI 本地跑 |
| 7 | H5 回归：浏览器添加/编辑课时行为不变（#61 用例全绿即覆盖） | vitest |

## 6. 风险

1. **迁移分支的解码歧义**：若历史上存在解码态与编码态两条行并存，迁移以解码态优先（resolveId 已命中即走现行为），编码态行留给 purge——不丢数据（内容在编码态行与台账 segmentsJson 双份）。
2. **purge 误删**：判据用 `isLegalContainerId`（#61 同款，测试覆盖段结构），非仅 `includes('%')`；lesson 的合法 4 段结构显式校验，误删面为零。
3. **toast 时机**：uni.showToast 在 app 端与页面跳转竞态——toast 在 saveContainer 返回后同步调用，无跳转动作，无竞态面。

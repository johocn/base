# App 编辑器体验对齐网页版 + 课时回写父课程 + 图片渲染修复设计册子

- 日期：2026-10-08
- 状态：已与用户逐项确认（预览形态、历史孤儿课时、图库形态、光标路线、五节设计）
- 前置：#67 编辑器光标三级裁决、#80 Markdown 快捷标签、#81 编辑回填均已上线（0.20.7/32）

## 1. 问题（四块）

1. **App 光标漂移**：App 端点工具栏按钮（色块/加粗等），内容插到光标**上方几行**的位置；插入后光标没有落到标记内待输入；有选区时没有包裹选区。H5（网页版）达标，App 不达标。
2. **课时未关联课程**：课程里添加的课时保存后不出现在该课程的课时区，只在「我创建的」台账里作为独立条目出现。
3. **课时图片不可见**：编辑器上传的图片在课时预览与课时详情里都不显示。
4. **图库弹层简陋**：图片弹层能打开但不美观，上传后没有预览效果。

## 2. 取证事实（设计依据）

| 事实 | 位置 |
|---|---|
| 光标取值三级裁决 `live`（H5 DOM）→ `ledger`（App renderjs 台账）→ `fallback`（正文末尾）；App 端 renderjs 上报滞后是漂移根因（读到比实际小的 offset） | `packages/core-ts/src/editor-caret.ts:29-33`、`apps/mobile/src/pages/submit/submit.vue:259-300` |
| App 端 renderjs 桥：模板 `:prop="caretCmd"` + `:change:prop="caretBridge.setCaret"`；写光标走 `setSelectionRange`（App 原生 textarea 无此 DOM，需 renderjs 视图层执行） | `submit.vue:116-125/219-240`、`lesson/edit.vue:307-387` |
| uni-app textarea 官方跨端 API：`@input` 事件 `e.detail.cursor`、`@blur` 事件 `e.detail.cursor`、`selection-start`/`selection-end` 属性写光标 | uni-app 文档（实施时以真机为准） |
| 工具栏纯函数（包裹/行前缀/工具分发）与插入语义已实现且有测试：无选区→光标落标记内，有选区→包裹 | `packages/core-ts/src/markdown-toolbar.ts:35-133` |
| 课时保存 `saveContainer` 只提交课时自己（item+segments），**不回写父课程 children 段** | `packages/core-ts/src/course-edit.ts:325-343` |
| 课程详情页课时区数据源 = 课程 segments 的 children 行（`childrenRowsOf(segs)` → `buildLessonList`）——children 没有课时 id 就永远不显示 | `apps/mobile/src/pages/course/detail.vue:208-210`、`packages/core-ts/src/container-view.ts:108` |
| 课时 id 形态正确：`newLessonID(courseId)` = `course/<cid>/lesson/<hex>`；课时表单由 `startNewLesson(courseId)` 生成 | `packages/core-ts/src/submit.ts:56-59`、`course-edit.ts:153-156` |
| 图片正文引用是 `blob:<hash>` 协议（跨节点可移植），渲染前必须 `resolveBlobRefsInMd(md, nodeBaseUrl)` 解析成 `{节点}/v1/blob/{hash}`，否则被 markdown 渲染的 safeURL 过滤 | `packages/core-ts/src/editor-links.ts:44-61`、`blob-refs.ts:23` |
| 文章详情页渲染**有** blob 解析（能看图）；课时详情、课时预览、投稿预览**裸调** `renderMarkdown`（看不了图）——4 处 | `article.vue:185/214` vs `lesson/detail.vue:221/295`、`lesson/edit.vue:345`、`submit.vue:257` |
| `searchLocalBlobs` 的 SELECT 未取 `b.path` 列，`BlobSearchRow` 无 path 字段；blob_index 表有 path（本机文件路径） | `packages/core-ts/src/editor-links.ts:108-119/159-166` |
| 预览现状 = 正文输入框下方只读 `rich-text`（两端同构），样式简陋 | `lesson/edit.vue:115-117` |
| 从 items+segments 重建容器表单的函数已有（回写时复用） | `packages/core-ts/src/course-edit.ts:257`（`loadContainerForm`） |

## 3. 设计决策（用户确认）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 预览形态 | **保持下方预览区**，修图片显示 + 预览排版样式与详情页一致 |
| 2 | 历史孤儿课时 | **不迁移**；历史课时重进编辑页保存一次即自动回写父课程 |
| 3 | 图库形态 | **缩略图网格**（3 列，本地 blob 文件直读预览）+ 上传 tab 选完图先大图预览再确认插入 |
| 4 | 光标路线 | **方案 A：官方事件光标**——读 `@input/@blur` 的 `e.detail.cursor`，写 `selection-start/selection-end` 属性，删 renderjs 桥整层；真机验证失效回退方案 B（renderjs 补记修滞后） |
| 5 | 回写层级 | **core 层收敛**（`saveContainer` 内），页面零改动 |

## 4. 方案

### 4.1 光标与工具栏（submit.vue + lesson/edit.vue 双页同构）

**读侧**：

- **单点光标主源**：正文 textarea 加 `@input="onBodyInput"`（`caretLedger.value = { start: e.detail.cursor, end: e.detail.cursor }`）+ `@blur="onBodyBlur"` 同口径补记——修「插到上方几行」的漂移（renderjs 上报滞后读小 offset）。
- **选区端点**：App 端原生 textarea 的 input/blur 事件**不携带选区端点**，只有单点 cursor。选区数据源保留 renderjs 视图层 onCaret 上报（职责收窄为只报 `{start, end}` 选区，删除其单点消费路径）——`resolveCaret` 三级裁决改为：H5 live（DOM 选区，H5 端 input/blur 也照旧 live 优先）→ App 选区 renderjs ledger → 单点 input ledger → fallback 正文末尾。真机验证 renderjs 选区可取性；若取不到稳定选区，App 端「选区包裹」降级为单点插入（光标落标记内），以真机定案为准。
- **删除**：`caretCmd` ref、模板 `:prop="caretCmd"` / `:change:prop` 的**写光标**桥（写侧改属性）；renderjs 段收窄为选区上报（若真机可取）。

**写侧**：

- 插入流程改为：`resolveCaret` 取准光标 → `applyToolbar`/`insertMarkdownAtCursor` 纯函数变换得新文本与目标光标 → 更新 `bodyMd` → 设置 `selStart.value/selEnd.value` → textarea `:selection-start="selStart" :selection-end="selEnd"` + `:focus="bodyFocus"` 拉回焦点，光标落标记内（无选区）或包裹选区后落在闭合标记后（有选区，`markdown-toolbar.ts` 既有契约）。
- 工具栏按钮防失焦沿用现状（按钮区不抢焦点的既有手法），焦点拉回用 `bodyFocus` 置真一拍再复位。

**真机验证点（册子 §8 风险 1）**：① App 端 `selection-start/end` 写光标到标记中间是否生效（需 focus 配合）；② 中文输入法组合输入期 `e.detail.cursor` 是否准。任一失效 → 回退方案 B（renderjs 桥保留，多事件点补记 + `\r\n` 归一）。

### 4.2 课时回写父课程（core 层，course-edit.ts）

`saveContainer` 在既有课时提交流程后追加：

```
若 form.type === 'lesson' 且 itemId 匹配 /^course\/([^/]+)\/lesson\// 且结果.ledgerState ∈ {sent, pending}：
  cid = 提取的课程 id
  父课程 = await repo.getItem(cid)
  若父课程不存在 → 跳过（静默，课时保存结果照常返回）
  否则：
    courseForm = await loadContainerForm(repo, cid, 'course')
    若 courseForm.children 已含本课时 itemId → 跳过（幂等，重复保存不重复追加）
    否则：courseForm.children.push({ kind: 'lesson', itemId: 课时 id })
         → 递归调用 saveContainer(o, courseForm)（课程 type 非 lesson，无二次递归）
           = 本地 upsertLocalContainer（课程详情页课时区立即可见）+ enqueueOrSend（课程重投进台账，同步节点）
```

- 回写**失败不吞**：课程重投若 failed，走既有失败 Toast/台账 failed + 重试链路；课时本身的保存结果不受影响。
- 台账语义：课程回写后在「我创建的」多一条课程更新记录（`created` 沿用 upsert 既有值）——预期行为，同 #81 §8 风险 2 口径。

### 4.3 图片渲染（4 处补解析，与文章页同口径）

`renderMarkdown(x)` → `renderMarkdown(resolveBlobRefsInMd(x, opts.nodeBaseUrl || ''))`：

- `lesson/detail.vue:221`（ledger 分支）与 `:295`（items 分支）
- `lesson/edit.vue:345`（`previewHtml` computed）
- `submit.vue:257`（`previewHtml` computed）

预览排版样式与详情页对齐：把详情页正文的 class（字号/行距/标题/代码块）复用到两处预览 rich-text（样式拷贝，不抽全局）。

### 4.4 图库弹层（submit.vue + lesson/edit.vue 双页同构）

- **图片库 tab**：文字列表 → 3 列网格（`display:flex; flex-wrap:wrap`，每格 `mode="aspectFill"` 方图）。`searchLocalBlobs` 补取 `b.path`（SELECT 与 `BlobSearchRow` 加 `path: string`）；缩略图 src = path 有值用本地路径（无 `file://` 前缀则补，`detail.vue:202` 同款手法），path 空回退 `resolveBlobUrl(nodeBaseUrl, 'blob:'+blobId)`（在线可见）。点格 → `insertMarkdownAtCursor(buildBlobImage(blobId, name))` + 关弹层。
- **上传 tab**：选图 → 上传 blob 成功后**先显示大图预览**（`bytesToBase64` dataURL，`coverPreview` 同款手法）+ 文件名，用户点「插入正文」才 insert + 关弹层；点「重新选图」可换。上传失败仍走既有错误提示。
- 两页模板各自修改（跟随现状两份拷贝，不抽公共组件——弹层状态与页内光标耦合，抽组件收益不抵改造成本）。

## 5. 边界与预期行为

| 场景 | 行为 |
|---|---|
| 光标在正文中间、无选区点「色块」 | 标记插在光标处，光标落标记内直接打字；不再漂到上方几行 |
| 选中一段文字点「加粗/斜体/行内代码/色块」 | 包裹选区，选区还原为包裹后的完整标记内容 |
| 连续点多个按钮 | 各自插到上一次落点之后（工具动作后的新光标位置就是下一次的输入点） |
| 课时保存成功（sent/pending）且父课程在本机 | 课程 children 追加课时、课程详情页课时区立即可见、课程重投进台账 |
| 重复保存同一课时 | children 已含 → 跳过，课程不重投（幂等） |
| 课时预检 failed（如标题空） | 不回写课程（无失败的课程垃圾台账行） |
| 父课程不在本机（换机未同步） | 静默跳过回写，课时照常保存；同步课程后重存课时即补挂 |
| 课时 pending 时课程已重投 | 课程入队顺序晚于课时，补发按台账时间序先课时后课程；若节点仍拒（子项未收录），课程行 failed + 既有重试兜底 |
| 离线看课时详情图片 | 与文章页现状同口径：本机有 blob 字节但渲染走节点 URL → 离线裂图（不额外做本地回退，登记挂账） |
| 图库离线 | 缩略图走本地 path 直读，离线可见（path 缺失的老数据回退节点 URL） |

## 6. 测试（vitest，core 层）

1. 回写·新增：`saveContainer` 提交课时（父课程本机存在）→ 课程 children 追加该课时 + 课程 enqueueOrSend 被调用（fake http 可见第二个 submit 请求）。
2. 回写·幂等：children 已含该课时 → 不重投（无第二个 submit 请求）。
3. 回写·父课程缺失：items 无课程行 → 跳过，课时结果照常（不抛错）。
4. 回写·课时 failed：预检失败（如空标题）→ 不回写、不重投课程。
5. `searchLocalBlobs` 补 path：SELECT 返回行含 path → `BlobSearchRow.path` 逐字透传。
6. `markdown-toolbar` 既有用例不动（包裹/落点语义契约已锁）。

页面行为（光标三态、网格交互、上传预览流）以真机验收为主，core 测试锁函数契约。

## 7. 验收清单（真机，App 端）

1. 正文光标在任意行中间，点「色块」→ 标记插在光标处、光标落标记内（不漂到上方几行）。
2. 选中文字点「加粗/斜体/行内代码/色块」→ 包裹选区，可继续输入。
3. 连续插入多个标记，位置与光标逐次正确。
4. 课程里新建课时保存 → 课程详情页课时区立即出现该课时。
5. 联网等台账补发后，节点 catalog 侧课程详情含该课时（网页版可见）。
6. 课时编辑正文插一张图 → 预览区图片显示；保存后课时详情页图片显示。
7. 投稿页正文插图 → 预览区图片显示。
8. 预览区排版（字号/行距/标题层级）与详情页一致。
9. 图库弹层 3 列缩略图网格，离线也能看到本机已有图。
10. 上传 tab 选图 → 大图预览 + 文件名 →「插入正文」才写入；「重新选图」可换。
11. 历史孤儿课时：重进编辑页保存一次 → 课程课时区出现（回写对旧数据生效路径）。
12. 门禁：core-ts vitest 全绿、mobile vitest 全绿、vue-tsc 零错、build:h5 通过。

## 8. 风险

1. **App 端写光标 API 生效性未真机验证**：`selection-start/end` + `:focus` 组合在 App 原生 textarea 上把光标写进标记中间——uni-app 文档支持但真机行为存变数（尤其键盘拉起时序）。缓解：实施计划把「光标真机冒烟」列为首个可验证 Task；失效回退方案 B（renderjs 桥保留 + 补记修滞后），回退不影响 §4.2-4.4。
2. **App 端选区获取不确定**：input/blur 事件只有单点 cursor，renderjs 选区上报是否稳定需真机定案；取不到则选区包裹降级单点插入（§4.1 已定降级口径，不算失败）。
3. **课程重投被节点拒**（课时 pending 时 children 引用未收录子项）：台账时间序补发 + failed 重试兜底；若线上确现，二期考虑「课程重投延后到课时 sent」的事件化——本册不做。
4. **离线图片裂图**（渲染走节点 URL）：与文章页既有口径一致，本册不扩；挂账「离线渲染本地 blob 回退」。
5. **input 光标在组合输入期不准**：中文输入法拼音组合中 cursor 可能指到组合串首——工具栏点击通常发生在组合结束后的稳定态，影响面小；真机验收覆盖一条中文场景。

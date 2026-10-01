# base 正文光标定位修复（A 主线 第 13 册 · 缺陷批次）

- 日期：2026-10-02
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`；直接上游 = `#44`（正文渲染增强：Markdown 语法工具栏与实时预览）、`#40`+`#41`（课程与课时编辑）、`#29`+`#30`（创作 UI：投稿编辑器与「我的条目」）、`#63`+`#64`（运行路径落盘根与存量台账自愈，已发布 `0.20.2`/`27`）
- 范围：`0.20.3`/`28` 真机反馈 1 条 —— **编辑课时正文**与**投稿正文**的 Markdown 快捷标签未插入到光标处，始终落在「上一个快捷标签的落点」
- 本册**不覆盖**：正文插图与媒体相对引用（另立一册，口径已定案，见 §6）；跨设备 / 跨节点分发口径（现状已核实，见 §6）；`core/markdown-toolbar.ts` 三个纯变换的语义与三组按钮常量；工具栏按钮集合、样式与顺序；`v-model` 落库口径与提交链路；iOS

## 0. 改版说明

### 0.1 2026-10-02 初版

**新增（本册首次定义）：**

- **光标取值改由 renderjs 桥接**（§3.1）：两页各挂一个 renderjs 模块 `caretBridge`，**只做「读光标 + 写光标」两件事**，不承载任何业务逻辑。逻辑层取值优先级 = **H5 原生 DOM（既有，保留不动） → renderjs 台账（新增，覆盖 App） → 正文末尾 + 一次轻提示**。
- **兜底口径**（用户已确认）：取不到真实光标时插到 `src.length` 并给一次 `uni.showToast` 轻提示，**任何情况下都不静默插到「上一次落点」**。
- **新增纯模块 `core/editor-caret.ts`**（§3.2）：把「取值 + 回落裁决」抽成纯函数，使这段判定能进 vitest（本仓库无 `.vue` 测试基建，页面内逻辑无法单测）。

**明确沿用、不改动：** `core/markdown-toolbar.ts` 的 `wrapSelection` / `prefixLines` / `insertSeparator` 与 `PARAGRAPH_BUTTONS` / `INLINE_BUTTONS` / `COLOR_BUTTONS` **一字不改**（「无选区把光标夹在标记中间、有选区则包裹」的语义本来就正确）；`v-model="form.bodyMd"` 的落库口径、预览派生 `renderMarkdown`、保存与提交链路；两页的提交、校验、台账与日志。

## 1. 范围与不做什么

| 做 | 不做 |
|---|---|
| §3.1：两页各加 renderjs 光标桥（读 + 写，最小面） | 不改 `core/markdown-toolbar.ts` 三个纯变换与三组按钮常量 |
| §3.2：新增 `core/editor-caret.ts` 纯取值裁决 + 单测 | 不给正文加插图 / 媒体引用（另立一册，见 §6） |
| §3.3：删掉 `bodySelStart` / `bodySelEnd` 这对「工具栏自产自销」的 ref 与 `:selection-start/-end` 绑定 | 不改节点任何契约、不动内容包规范 v1、零新 HTTP 接口 |
| §3.3：取不到光标 ⇒ 插到正文末尾 + 一次轻提示 | 不改工具栏按钮集合 / 顺序 / 样式；不动 tabBar |
| 发布口径 `0.20.4`/`29`，仅动 `apps/mobile`（零节点改动） | 不看 iOS；不改 `attr.*` 与提交 / 校验口径 |

## 2. 症状与根因

### 2.1 症状（用户口径）

> 编辑课时的正文，与发表文章的正文 markdown 区域，快捷 markdown 标签没有定位到光标处，始终插入到一个位置，就是上一个快捷标签的输入位置。正常顺序应该是选择正文位置，点快捷标签，光标停在内容输入区域等待输入；输入完成，或光标指向其他位置，点快捷标签，快捷标签代码插入新的光标处。

### 2.2 根因（代码级，已定位）

两页写法同源，是**同一个缺陷**：

1. 取值表达式 —— `apps/mobile/src/pages/submit/submit.vue:122-125`、`apps/mobile/src/pages/lesson/edit.vue:224-227`：

   ```ts
   const field = bodyTextarea();
   const start = field ? field.selectionStart : bodySelStart.value >= 0 ? bodySelStart.value : src.length;
   const end = field ? field.selectionEnd : bodySelEnd.value >= 0 ? bodySelEnd.value : src.length;
   ```

2. `bodyTextarea()`（`submit.vue:114-118` / `lesson/edit.vue:216-220`）靠 `bodyRef.value?.$el?.querySelector('textarea')` 取原生节点。**该路径只在 H5 成立**；App 端 `$el` 上无 `querySelector` ⇒ 恒返回 `null`。

3. `null` 时回落的 `bodySelStart` / `bodySelEnd` —— **只在 `applyTool` 内部被写**（`lesson/edit.vue:230-231`、`submit.vue:128-129`），**从不记录用户真实光标**。所以它永远等于「上一次工具动作算出的落点」；首帧初值 `-1` 时落到 `src.length`。

⇒ 现象逐字吻合：第一次点标签插到正文末尾，此后每次都插到上一次落点。H5 不受影响（走第 1 优先，取到真实选区）。

**纯变换层无缺陷**：`applyToolbar` 在正确的 `start`/`end` 下产出正确结果（既有 `core/markdown-toolbar.test.ts` 为证）。坏掉的只有「选区从哪来」这一个变量。

## 3. 处置

### 3.1 renderjs 光标桥（新增，面压到最小）

两页各加一个 renderjs 模块，**只做读与写**：

- **读**：在真实 DOM 上监听 `selectionchange`（document 级，过滤到本页 textarea）+ `focus` / `blur` / `input`，把 `{ start, end, focused }` 经 `$ownerInstance.callMethod('onCaret', …)` 上报逻辑层，逻辑层存入 `caretLedger`。
- **写**：暴露 `setCaret(start, end, text)`，内部 `el.focus(); el.value = text; el.setSelectionRange(start, end)` —— 沿用既有「直接落到原生节点、绕开组件 model→DOM 100ms 防抖、避免光标被重置到末尾」的做法。逻辑层经 `:prop` / `:change:prop` 触发。

固定边界：renderjs 侧**不读不写任何业务状态**（不碰 `form`、不碰落库、不碰提交）。

### 3.2 取值裁决（纯模块，可单测）

新增 `apps/mobile/src/core/editor-caret.ts`（不 import `uni` / `plus`，遵 `core` 层不变式）：

```ts
export interface Caret { start: number; end: number }
export type CaretSource = 'live' | 'ledger' | 'fallback';
export function resolveCaret(
  live: Caret | null,
  ledger: Caret | null,
  len: number,
): { caret: Caret; source: CaretSource }
```

优先级：`live`（H5 原生 DOM，保留现状） → `ledger`（renderjs 台账） → `fallback`（`{ start: len, end: len }`）。任何入参一律钳到 `[0, len]`，`end < start` 时取 `end = start`。

### 3.3 两页接线

`applyTool` 改为：

1. `resolveCaret(live, caretLedger, src.length)`；
2. `applyToolbar(src, caret.start, caret.end, action)`（既有纯函数，调用方式不变）；
3. `form.bodyMd = r.text`；
4. 若 `source === 'fallback'` ⇒ `uni.showToast({ title: '未取到光标，已插入到正文末尾', icon: 'none' })` **一次**；
5. 调 renderjs `setCaret(r.start, r.end, r.text)` 写回光标。

**删除** `bodySelStart` / `bodySelEnd` 两个 ref 与 textarea 上的 `:selection-start` / `:selection-end` 绑定 —— 它们正是本缺陷的根源；`bodyFocus` 保留（沿用现有重新聚焦行为）。

### 3.4 真机探针（硬门，执行时第一个 Task）

方案成立的前提是 **App 端 renderjs 能在真实 DOM 里命中 textarea**。执行时先做探针，不得带着假设往下写：

- renderjs 内 `document.querySelector('uni-textarea textarea')` 是否命中；
- 命中后 `selectionStart` 是否随点击 / 输入变化；
- `$ownerInstance.callMethod` 回调是否按期到达逻辑层。

**探针不通过即停下**，回退「事件台账」方案（不依赖 renderjs）或重新裁决，不允许静默降级。

## 4. 兼容与影响

- **H5**：取值第 1 优先仍是既有原生 DOM 路径 ⇒ **行为逐字不变**，零回归。
- **App**：从「恒错」变为「取真实光标」；取不到才走末尾 + 轻提示。
- **老客户端（≤ `0.20.3`）**：不受影响（纯客户端修复，无节点侧参与）。
- **节点侧零改动**：`git diff --stat -- internal/` 必须为空 ⇒ **不交叉编译、不部署节点二进制**。
- **契约**：零新 HTTP 接口、不改内容包规范 v1、不动 `attr.*`、不加配置项。
- **renderjs 是仓库首次引入的模式**（全仓现无既有用法），故 §3.4 的探针门槛是本册的前置条件而非可选项。

## 5. 验证口径（门禁）

| 项 | 命令 | 判据 |
|---|---|---|
| mobile 单测 | `npx vitest run`（cwd `apps/mobile`） | 全绿（现基线 455 用例），且新增 `core/editor-caret.test.ts` 用例通过 |
| mobile 类型 | `npm run typecheck` | **不新增**（基线 2 条册外既有错：`governance.vue(58,7)` TS2741、`submit.vue(156,5)` TS2322） |
| H5 构建 | `npm run build:h5` | 通过 |
| App 构建 | `npm run build:app` | 通过；产物 `dist/build/app/app-service.js` 中 `.value.value` 计数 = **0** |
| 节点 | `go test ./...` | 全包 ok |
| 节点改动面 | `git diff --stat -- internal/` | **空输出** |
| 模板硬检查 | `git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages` | 无输出 |
| 真机 | 手工 | §3.4 探针通过 + 「选位置 → 点标签 → 插入该位置」在两页均成立 |

新增用例（`core/editor-caret.test.ts`，最低要求）：① `live` 优先于 `ledger`；② 无 `live` 时用 `ledger`；③ 双空 ⇒ `fallback` 且 `start = end = len`；④ 越界 / `end < start` 一律钳制。

## 6. 后续册子（**不在本册范围**，仅登记已定案口径与已核实现状，避免决策丢失）

### 6.1 正文插图口径（用户已定案）

**采用「媒体段进内容包（相对引用）」**，理由是跨设备 / 跨节点稳定性：节点 blob 绝对链接（`http://<节点>/v1/blob/<id>`）会把某台节点的地址焊进正文，换节点即断链；媒体段随内容包走，接收方按 `chunk_hashes_json` 校验后本地解析，不依赖所连节点。

已核实的**既有部分**（不是从零造）：`media_meta` 已是内容包内五张表之一（`internal/packexport/export.go:47-64`）；包 entry 的 `chunks` 已承载 `{ BlobID, Size, Seq }`（同文件 `:124-150`）；`vectors/v1/manifest.json` 的 `cover:demo-1` 即此形态；手机端已有 `attr.cover` / `attr.attachment` 槽位（`apps/mobile/src/core/attrs.ts:14-18`）。

**必须新增的四块**：① 正文相对引用 scheme（现行 `safeURL` 只认 `http://` / `https://`：`internal/markdown/markdown.go:293-295` 与 `apps/mobile/src/core/markdown.ts:220-223`）；② Go / TS 双侧渲染白名单同步 + `vectors/v1/markdown.json` 同步（违反则镜像校验挂）；③ 渲染期把相对引用解析成本机 `{workDir}/blobs/<blob_id>`；④ 打包 `DeclaredChunks` 声明补齐，否则对端拿不到图。现行 spec 明文写着「无图床、只支持外链」（`specs/2026-09-30-base-markdown-render-design.md:71-72`），选此口径即**修订渲染契约**。

**两条待验证风险**（须在那一册开工前实测，不得假设）：① App 端 `rich-text` 能否渲染本机文件路径的图片 —— 它决定「离线本机可见」是否成立；② 新增 scheme 与 `vectors` 的镜像纪律。

该册子**尚未立册、尚未定编号**。

### 6.2 跨设备 / 跨节点分发现状（已核实，供后续册子直接引用）

- 手机端本地 SQLite 只有**文本、元数据与块索引**；图片本体落在**本机文件** `{workDir}/blobs/<blob_id>`。
- 节点导出的内容包 `pack.sqlite` **不含 blob 本体**，只带 `chunk_hashes_json`；图片靠 `GET /v1/blob/{id}` **按需拉取**（`apps/mobile/src/core/sync.ts:233-243`）。
- ⇒ **把 APK 装到另一台设备，既不带走数据库，也不带走任何图片**；能否看到图，取决于它连的那个节点是否持有该 blob。此结论**在 §6.1 口径落地后会被部分改变**（正文内嵌图片将随内容包分发；本地数据库仍不随 APK 走）。

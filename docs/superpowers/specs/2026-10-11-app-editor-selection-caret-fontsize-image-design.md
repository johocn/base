# App 编辑器选区包裹与光标落位修复 + 字号快捷标签 + 图片等比缩放设计册子

- 日期：2026-10-11
- 状态：已与用户逐项确认（字号交互/档位/图片缩放范围）
- 前置：#82（0.20.8/33）已上线——插入位置漂移已修（读侧 e.detail.cursor 达标），遗留两项光标缺陷

## 1. 问题（四块）

1. **选中文字点快捷标签不包裹**：选中文字后点「加粗」等，只插入标签对，选中的文字未被包裹。
2. **无选区插入后光标不落标记内**：`**` 插入后光标停在标记后，应落在 `**` 中间等待输入。
3. **图片不缩放**：预览区大图显示不全；上传弹窗大图把弹层撑爆、按钮被挤出视口。
4. **缺字号快捷按钮**：需要「文字大小」快捷标签。

## 2. 取证事实（设计依据）

| 事实 | 位置 |
|---|---|
| 包裹/夹位纯函数契约完好：有选区包裹、无选区夹位 | `packages/core-ts/src/markdown-toolbar.ts:36-52` |
| 读选区现状：renderjs 桥只在 `selectionStart !== selectionEnd` 时上报，而 App 端视图层 DOM 拿不到 textarea 选区状态 → 选区从不进台账 | `apps/mobile/src/core/caret-bridge.renderjs.js:36-41` |
| 官方读选区 API：`uni.getSelectedTextRange`（App vue 2.8.12+，仅 focus 时有效，无变更事件） | uni-app 官方文档 |
| 写光标官方口径：selection-start/end 值变化 + focus 翻转才生效；「值不变不触发、不重新 focus 不生效」两坑均成立；HBuilderX 4.75 修复过多次设置不生效 | uni-app textarea 源码 watch + 官方示例 |
| 现状写侧缺 focus 翻转：bodyFocus 首次 false→true 后恒为 true，第二次起不翻转 → 不生效（问题 2 根因） | `submit.vue:293-296`、`lesson/edit.vue` 同构 |
| App-vue 页面组件在 WebView DOM 渲染，无「原生覆盖」问题；textarea 内层元素类名 `uni-textarea-textarea` | uni-app H5/App-vue textarea 源码 |
| 渲染白名单：只产 span[class]，class 只认 7 个色块枚举名；未知类名字面量输出 | `packages/protocol-ts/src/markdown.ts:20,227-249` |
| 色块语法 `[文字]{.c-x}` 双端镜像（TS + Go），共读 `vectors/v1/markdown.json` 契约向量 | `markdown.ts:1-9` |
| 色块 CSS 分布：mobile 三页（submit 预览 / lesson edit 预览 / lesson detail 详情+sepia）、web/templates/base.html、node portal fixtures | grep 实测 |
| parseImage 产 `<img src alt>` 无宽度约束 → 预览大图溢出；上传预览 `widthFix`+`width:100%` 无限高 → 撑爆弹窗 | `markdown.ts:211-224`、`submit.vue:83,663` |
| 工具栏防失焦手法沿用现状（view @click 不抢焦点） | `submit.vue:27-43` |

## 3. 设计决策（用户确认）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 选区读取路线 | **换官方 API**：点工具栏瞬间 `uni.getSelectedTextRange()`，删 renderjs 桥整层 |
| 2 | 光标写入路线 | **值变化 + focus 翻转**（官方口径）：bodyFocus false→nextTick→true 完整序列 |
| 3 | 字号交互 | **弹层选档**：工具栏一个「字号」按钮，点击弹档位选择（同图片弹窗手法） |
| 4 | 字号档位 | **三档**：小 13px `{.fs-sm}` / 大 19px `{.fs-lg}` / 特大 24px `{.fs-xl}`（标准 15px 不需标记） |
| 5 | 图片缩放范围 | **全端统一**：渲染器 img 加固定内联 style，一次改全端生效 |

## 4. 方案

### 4.1 选区读取（两页同构：submit.vue + lesson/edit.vue）

- **删**：`caret-bridge.renderjs.js` 文件、模板 `:change:prop` 绑定、`onCaret`/`defineExpose`。
- **读链**（点工具栏瞬间）：H5 live DOM → App `uni.getSelectedTextRange`（异步 success/fail 回调）→ `caretLedger`（单点）→ fallback 正文末尾。
- `getSelectedTextRange` 是异步 API：把「变换+写回」提为同步函数 `runToolbar(start, end, source)`；API success 回调传选区调它，fail/无 API 传 ledger 单点调它。H5 端该 API 不可用，走既有 live DOM，行为不变。
- textarea 保持 focus（工具栏 view 点击不抢焦点的现状手法），是 API 生效前提；工具动作后写侧拉回焦点。

### 4.2 光标写入（两页同构）

工具动作/插入后执行完整序列（替换现有 selStart/selEnd + bodyFocus=true 两行）：

```
bodyFocus.value = false
await nextTick()
selStart.value = r.start; selEnd.value = r.end   // 每次都赋新值
bodyFocus.value = true                            // false→true 边沿触发选区应用
```

- 连续两次目标光标相同也生效（focus 边沿 + 值都在变）。
- H5 DOM 双 setTimeout 兜底保留不动。
- `applyTool`/`insertMarkdownAtCursor` 变 async（调用点同步链，无需等待）。
- 真机若键盘闪动不可接受 → 备选「hold-keyboard / 只变值不翻转」实测定案（风险 2）。

### 4.3 字号三档（协议双端同步）

- 语法与色块同构：`[文字]{.fs-sm}` / `{.fs-lg}` / `{.fs-xl}` → `<span class="fs-sm">` 等。
- **TS 渲染器**（`packages/protocol-ts/src/markdown.ts`）：`parseBracket` 的 `{.c-` 分支泛化为 `{.` 前缀 + 类名校验两个白名单 Set（colorClasses 7 个不变 + sizeClasses 新增 fs-sm/fs-lg/fs-xl）；未知类名仍字面量输出。
- **Go 侧镜像**（internal/markdown）：同决策同步改（实施时定位文件）。
- **契约向量**（`vectors/v1/markdown.json`）：新增 3 条 fs 用例。
- **CSS**（.fs-sm 13px / .fs-lg 19px / .fs-xl 24px）：mobile 三页（submit 预览、lesson/edit 预览、lesson/detail 详情+sepia 变体）、web/templates/base.html、node portal fixtures 同步补。
- **工具栏**：`markdown-toolbar.ts` 新增 `SIZE_OPTIONS`（key/label/after 三字段，before 固定 `[`）；两页工具栏加「字号」按钮开弹层，弹层三档点选 → 有选区包裹 / 无选区插空标记夹位（复用 `wrapSelection`/`applyTool` 全链路）。

### 4.4 图片等比缩放

- **渲染器**：`parseImage` 产出加固定内联 style：`<img src alt style="max-width:100%;height:auto">`——白名单扩 img[style]，**值恒定不开放**（非注入面）。Go 侧 + 向量（现有 img 用例期望值同步更新）。
- **CSS 兜底**：web/templates/base.html 与 mobile 三页正文容器补 `img { max-width: 100%; height: auto; }`（rich-text App 端内联 style 自带生效，CSS 覆盖 H5 与旧节点缓存内容）。
- **上传弹窗**：upload-preview 加 `max-height: 40vh` + `mode` 改 `aspectFit`（完整显示不撑爆）；图片库网格 `aspectFill` 方格不动。
- 详情页（article/lesson detail）同口径覆盖（渲染器内联 style 全端生效，无需逐页改）。

## 5. 边界与预期行为

| 场景 | 行为 |
|---|---|
| 选中文字点「加粗/斜体/行内代码/色块/字号档」 | 包裹选区，选区还原为包裹后完整内容 |
| 无选区点上述按钮 | 插入空标记对，光标夹中间等待输入 |
| 连续点两个按钮 | 第二次插到第一次落点后（tool 后光标就是下一次输入点） |
| 工具栏点击时 textarea 已失焦（键盘收起） | getSelectedTextRange fail → ledger 单点兜底 → 单点插入 |
| 历史正文 `[x]{.c-red}` | 渲染不变（colorClasses 不动） |
| 未知 `{.fs-xx}` | 字面量输出（与未知色块同口径） |
| 大图在预览/详情 | 等比缩放不溢出；弹窗预览限高 40vh 完整显示 |
| 老版本 App/未升级网页版看 `{.fs-x}` 正文 | 未知类名字面量显示（不崩，升级后恢复渲染） |

## 6. 测试（vitest + go test，core/协议层）

1. TS 渲染器：fs 三档渲染 span + 未知 fs 类名字面量 + img 带 style。
2. 向量：markdown.json 新增 fs/img-style 用例，TS/Go 共读全绿。
3. `markdown-toolbar.ts`：SIZE_OPTIONS 三档包裹/夹位用例。
4. 既有用例回归（渲染白名单改动不破色块/链接/图片既有期望——img 向量期望值需同步更新）。

页面行为（选区包裹、光标夹位、弹层交互、图片缩放）以真机验收为主。

## 7. 验收清单（真机，App 端）

1. 选中文字点「加粗」→ 文字被 `****` 包裹且加粗内容正确。
2. 选中文字点任一色块 → 包裹变色。
3. 无选区点「加粗」→ 光标落在 `**` 中间，直接打字即在标记内。
4. 连续插入多个标记，位置与落点逐次正确。
5. 点「字号」→ 弹层三档；选中文字选「大」→ `[文字]{.fs-lg}`，预览变大字。
6. 预览/详情大图等比缩放不溢出。
7. 上传弹窗选长图 → 预览限高完整显示，操作按钮可见。
8. 图片库网格正常（不回归）。
9. H5 网页版：选区包裹/光标夹位/字号/图片缩放同口径不回归。
10. 门禁：protocol-ts + core-ts + mobile vitest 全绿、Go 侧测试全绿、vue-tsc 零错、build:h5 通过。

## 8. 风险

1. **getSelectedTextRange 真机可用性**：仅 focus 时有效，工具栏点击若致失焦则拿不到——降级单点插入（既有口径，不算失败）；实施首项即真机冒烟此项。
2. **focus 翻转的键盘闪动**：每次工具动作 focus false→true 可能收起再弹键盘；不可接受则实测「hold-keyboard」「只变值不翻转」备选定案。
3. **协议双端不同步**：fs/img-style 白名单 TS 与 Go 必须同决策——vectors 契约向量守门，漏改一侧测试即红。
4. **rich-text App 端对 img 内联 style 支持度**：真机验证；不支持则 mobile 端补样式穿透方案（页面级 class 选择器）。
5. **老客户端看新标记**：未升级端 `{.fs-x}` 字面量显示，不崩——预期行为，无需迁移。

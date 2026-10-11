# App 编辑器选区光标修复 + 字号标签 + 图片缩放 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修 App 端选区包裹与光标夹位（官方 API 读选区 + focus 翻转写光标）、加字号三档快捷标签（协议双端）、图片全端等比缩放。

**Architecture:** 协议层一次扩展（TS+Go 渲染器白名单 + 契约向量守门）；mobile 两页同构改造光标读写并删 renderjs 层；CSS 全端铺开。上游册子：`docs/superpowers/specs/2026-10-11-app-editor-selection-caret-fontsize-image-design.md`。

**Tech Stack:** uni-app Vue3（H5+App）、TypeScript、Go、vitest、vue-tsc。

**执行约定：**
- 所有 git 命令在 `e:\code\base` 下执行；PowerShell 不支持 `&&`，用 `;` 链接。
- 每个 Task 结束即 commit（只 add 该 Task 文件）；Task 6 完成后 push。
- commit 前跑该 Task 的测试命令，绿了才提交。
- 用户规则：不用 python 脚本写/改文件；本地用编辑工具，远程用简单命令。

---

### Task 1: protocol-ts 渲染器 — fs 白名单 + img style + 向量

**Files:**
- Modify: `packages/protocol-ts/src/markdown.ts:20`（白名单）、`:211-224`（parseImage）、`:226-249`（parseBracket）
- Modify: `vectors/v1/markdown.json:74-78`（img 期望值）、`:128` 后（fs 用例）
- Test: `packages/protocol-ts/src/markdown.test.ts`（向量驱动，无需新用例文件）

- [ ] **Step 1: 改 TS 渲染器**

`markdown.ts` 三处。

L20 后加（colorClasses 保持不动）：

```ts
// 字号扩展的 3 个枚举类名（span[class] 的合法取值；标准 15px 不需标记）。
const sizeClasses = new Set(['fs-sm', 'fs-lg', 'fs-xl']);
```

`parseImage`（L211-224）`out` 末行改为：

```ts
  let out = '<img';
  if (safeURL(u.url)) out += ' src="' + escapeAttr(u.url) + '"';
  out += ' alt="' + escapeAttr(alt) + '" style="max-width:100%;height:auto">';
  return { html: out, len: k + 1 + u.len };
```

`parseBracket`（L226-249）：`rest.startsWith('{.c-')` 改为 `rest.startsWith('{.')`，`const cls = rest.slice(4, end)` 改为 `const cls = rest.slice(2, end)`，白名单判断改为双 Set：

```ts
  if (rest.startsWith('{.')) {
    const end = rest.indexOf('}');
    if (end < 0) return null;
    const len = k + 1 + end + 1;
    const cls = rest.slice(2, end);
    if (colorClasses.has(cls) || sizeClasses.has(cls)) {
      return { html: '<span class="' + cls + '">' + inline(content) + '</span>', len };
    }
    // 未知类名：整段按字面量原样输出，不产 span。
    return { html: '[' + escapeText(content) + ']' + escapeText(rest.slice(0, end + 1)), len };
  }
```

- [ ] **Step 2: 更新向量**

`vectors/v1/markdown.json`：

L77 图片期望值改为（style 加在 alt 后）：

```json
      "html": "<p><img src=\"http://example.com/a.png\" alt=\"alt\" style=\"max-width:100%;height:auto\"></p>"
```

L128（`变色内允许行内嵌套` 用例后）追加 4 条：

```json
    {
      "name": "字号 fs-sm",
      "src": "[小]{.fs-sm}",
      "html": "<p><span class=\"fs-sm\">小</span></p>"
    },
    {
      "name": "字号 fs-lg",
      "src": "[大]{.fs-lg}",
      "html": "<p><span class=\"fs-lg\">大</span></p>"
    },
    {
      "name": "字号 fs-xl",
      "src": "[特大]{.fs-xl}",
      "html": "<p><span class=\"fs-xl\">特大</span></p>"
    },
    {
      "name": "未知字号类名字面量",
      "src": "[文字]{.fs-foo}",
      "html": "<p>[文字]{.fs-foo}</p>"
    },
```

- [ ] **Step 3: 跑测试**

Run: `cd packages/protocol-ts; npx vitest run`
Expected: 全绿（向量驱动；若 `{.c-foo}` 字面量用例红，检查 parseBracket 泛化是否保留了字面量分支）。

- [ ] **Step 4: Commit**

```powershell
git add packages/protocol-ts/src/markdown.ts vectors/v1/markdown.json
git commit -m "feat(protocol-ts): 渲染白名单扩字号三档 fs-* 并给 img 加等比缩放 style (#83)"
```

---

### Task 2: Go 渲染器同步

**Files:**
- Modify: `internal/markdown/markdown.go`（L33-37 白名单区、L213-238 parseImage、L240-260 parseBracket）
- Test: 既有 Go 测试（向量驱动）

- [ ] **Step 1: 读 Go 原文，按同决策镜像改**

先 Read `internal/markdown/markdown.go` 的三个函数，然后：

1. `colorClasses` 旁加 `sizeClasses`（map 或 set，跟随现有写法）：`fs-sm/fs-lg/fs-xl`。
2. `parseImage`：`<img` 产出在 alt 后加 ` style="max-width:100%;height:auto"`（与 TS 逐字节同构：`<img src="…" alt="…" style="max-width:100%;height:auto">`；src 不合法时同样保留 style，与 TS 口径一致——TS 是无条件拼 style）。
3. `parseBracket`：`{.c-` 前缀判断泛化为 `{.`，类名截取 `rest[2:end]`，白名单判断改为 color 或 size 命中，未知仍字面量。

- [ ] **Step 2: 跑测试**

Run: `go test ./internal/markdown/...`
Expected: 全绿（向量共读守门，Task 1 已更新向量）。

Run: `go build ./...`
Expected: 编译通过。

- [ ] **Step 3: Commit**

```powershell
git add internal/markdown/markdown.go
git commit -m "feat(internal/markdown): Go 渲染器同步字号三档与 img style 白名单 (#83)"
```

---

### Task 3: core-ts 工具栏 SIZE_OPTIONS

**Files:**
- Modify: `packages/core-ts/src/markdown-toolbar.ts`（L133 `COLOR_BUTTONS` 之后）
- Test: `packages/core-ts/src/markdown-toolbar.test.ts`

- [ ] **Step 1: 写失败测试**

`markdown-toolbar.test.ts` 尾追加：

```ts
describe('SIZE_OPTIONS 字号档位（册子 #83 §4.3）', () => {
  it('三档包裹选区', () => {
    const r = applyToolbar('hello', 0, 5, SIZE_OPTIONS[1]!.action);
    expect(r.text).toBe('[hello]{.fs-lg}');
    expect(r.start).toBe(1);
    expect(r.end).toBe(6);
  });
  it('无选区夹位', () => {
    const r = applyToolbar('ab', 1, 1, SIZE_OPTIONS[0]!.action);
    expect(r.text).toBe('a[]{.fs-sm}b');
    expect(r.start).toBe(2);
    expect(r.end).toBe(2);
  });
});
```

确认 import 块已含 `SIZE_OPTIONS`（追加进既有 import）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core-ts; npx vitest run src/markdown-toolbar.test.ts`
Expected: FAIL（SIZE_OPTIONS 不存在）。

- [ ] **Step 3: 实现**

`markdown-toolbar.ts` L133 后加：

```ts
/** 字号三档（册子 #83 §4.3）：标准 15px 不需标记；before 固定 `[`，与色块同构。 */
export const SIZE_OPTIONS: ToolbarButton[] = [
  { key: 'fs-sm', label: '小', action: { kind: 'wrap', before: '[', after: ']{.fs-sm}' } },
  { key: 'fs-lg', label: '大', action: { kind: 'wrap', before: '[', after: ']{.fs-lg}' } },
  { key: 'fs-xl', label: '特大', action: { kind: 'wrap', before: '[', after: ']{.fs-xl}' } },
];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core-ts; npx vitest run`
Expected: 全绿。

- [ ] **Step 5: Commit**

```powershell
git add packages/core-ts/src/markdown-toolbar.ts packages/core-ts/src/markdown-toolbar.test.ts
git commit -m "feat(core-ts): 工具栏字号三档 SIZE_OPTIONS（复用 wrapSelection 语义）(#83)"
```

---

### Task 4: submit.vue — 光标读写改造 + 字号弹层 + 上传预览限高

**Files:**
- Modify: `apps/mobile/src/pages/submit/submit.vue`（模板 L83 上传预览、L109-120 textarea、L27-44 工具栏、弹层区 L75-108 旁；脚本 L216-306 光标段、L598-599 renderjs 声明、L622-629 CSS 区）

- [ ] **Step 1: 脚本层改造**

1. **删** L271-275（`onCaret` + `defineExpose({ onCaret })`）、L598-599（renderjs 模块声明两行及其上注释）。
2. **删** import `resolveCaret`（L169）；import 块从 `../../core/markdown-toolbar` 追加 `SIZE_OPTIONS`。
3. **替换** `insertMarkdownAtCursor`（L217-243）与 `applyTool`（L278-306）两函数为下面三个函数（原两函数的其它调用点不变，`insertMarkdownAtCursor` 签名保持）：

```ts
/** 工具动作统一入口：读当前光标/选区（H5 live DOM → App 官方 API → 台账 → 末尾）再变换 */
function applyTool(action: ToolbarAction) {
  const field = bodyTextarea();
  if (field) {
    runToolbar(field.selectionStart, field.selectionEnd, 'live', action);
    return;
  }
  uni.getSelectedTextRange({
    success: (res) => runToolbar(res.start, res.end, 'ledger', action),
    fail: () => {
      const l = caretLedger.value;
      runToolbar(l?.start ?? bodyMd.value.length, l?.end ?? bodyMd.value.length, l ? 'ledger' : 'fallback', action);
    },
  });
}

/** 在光标处插入任意 markdown：等价于空 before 的包裹动作（册子 #83 §4.1 统一路径） */
function insertMarkdownAtCursor(markdown: string) {
  applyTool({ kind: 'wrap', before: '', after: markdown });
}

/** 同步变换 + 异步写光标（官方口径：focus 翻转 + 值每次变化） */
function runToolbar(start: number, end: number, source: 'live' | 'ledger' | 'fallback', action: ToolbarAction) {
  const src = bodyMd.value;
  const r = applyToolbar(src, start, end, action);
  bodyMd.value = r.text;
  caretLedger.value = { start: r.start, end: r.end };
  if (source === 'fallback') {
    uni.showToast({ title: '未取到光标，已插入到正文末尾', icon: 'none' });
  }
  void writeCaret(r.start, r.end);
}

/** 写光标：focus false→nextTick→置选区值→true；H5 DOM 双拍兜底保留 */
async function writeCaret(start: number, end: number) {
  bodyFocus.value = false;
  await nextTick();
  selStart.value = start;
  selEnd.value = end;
  bodyFocus.value = true;
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(start, end);
  }, 60);
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(start, end);
  }, 250);
}
```

注意：`onBodyInput`/`onBodyBlur`/`caretLedger`/`selStart`/`selEnd`/`bodyTextarea`/`bodyFocus` 全部保留不动。若原 `applyTool` 内还有 `selStart/selEnd/bodyFocus` 直写残留行，删除（已并入 writeCaret）。

- [ ] **Step 2: 字号弹层**

模板：工具栏「图片」按钮（L43）前加：

```html
        <view class="tool" @click="sizeOpen = true">字号</view>
        <view class="tool-divider" />
```

图片弹层（L76 `imageOpen` 的 view）后加同款弹层：

```html
      <!-- 字号弹层：三档选一（册子 #83 §4.3） -->
      <view v-if="sizeOpen" class="modal-mask" @click.self="sizeOpen = false">
        <view class="modal">
          <view class="modal-tabs">
            <text class="modal-tab modal-tab-on">选择字号</text>
          </view>
          <view class="size-row">
            <view v-for="s in SIZE_OPTIONS" :key="s.key" class="tool size-opt" :class="s.key" @click="applySize(s)">
              <text :class="s.key">{{ s.label }}</text>
              <text class="hint">{{ s.key }}</text>
            </view>
          </view>
          <view class="modal-actions">
            <text class="act" @click="sizeOpen = false">取消</text>
          </view>
        </view>
      </view>
```

脚本：`imageOpen` ref 旁加 `const sizeOpen = ref(false);`；`applyTool` 定义后加：

```ts
/** 字号档位点选：包裹/夹位后关弹层 */
function applySize(s: (typeof SIZE_OPTIONS)[number]) {
  sizeOpen.value = false;
  applyTool(s.action);
}
```

CSS（L629 色块样式后追加）：

```css
/* 字号三档渲染（册子 #83 §4.3）：预览与详情同值 */
.fs-sm { font-size: 13px; }
.fs-lg { font-size: 19px; }
.fs-xl { font-size: 24px; }
/* 预览内图片等比缩放（渲染器已带内联 style，此处为 H5 兜底） */
.preview img { max-width: 100%; height: auto; }
/* 上传预览限高：完整显示不撑爆弹窗（册子 #83 §4.4） */
.upload-preview { max-height: 40vh; }
.size-row { display: flex; gap: 10px; margin-top: 10px; }
.size-opt { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; }
```

- [ ] **Step 3: 上传预览组件属性**

模板 L83 `<image ... mode="widthFix" class="upload-preview" />` 的 `mode` 改为 `aspectFit`。

- [ ] **Step 4: 门禁**

Run: `cd apps/mobile; npx vue-tsc --noEmit`（零错）；`npm run build:h5`（通过）。
Run: `cd apps/mobile; npx vitest run`（全绿）。

- [ ] **Step 5: Commit**

```powershell
git add apps/mobile/src/pages/submit/submit.vue
git commit -m "feat(mobile): 投稿页选区读取换官方 API+写光标 focus 翻转+字号弹层+上传预览限高 (#83)"
```

---

### Task 5: lesson/edit.vue 同构 + 详情页 CSS + 删 renderjs 文件

**Files:**
- Modify: `apps/mobile/src/pages/lesson/edit.vue`（同构锚点：光标段 L342-380、renderjs 声明 L797-798、工具栏区、图片弹层、CSS 区 L820-827）
- Modify: `apps/mobile/src/pages/lesson/detail.vue:477-484`（CSS 区）、`apps/mobile/src/pages/article/article.vue`（正文样式区，grep `.c-red` 定位）
- Delete: `apps/mobile/src/core/caret-bridge.renderjs.js`（两页引用都删后才能删）

- [ ] **Step 1: edit.vue 按 Task 4 同口径全改**

以 Task 4 的改法为镜像（结构同构，行号偏移）：
1. 删 `onCaret`+`defineExpose`（L365 附近）与 renderjs 声明两行（L797-798）。
2. 删 `resolveCaret` import；追加 `SIZE_OPTIONS` import。
3. `insertMarkdownAtCursor`/`applyTool` 替换为 `applyTool`/`insertMarkdownAtCursor`/`runToolbar`/`writeCaret` 四函数（代码与 Task 4 Step 1 逐字一致）。
4. 字号弹层（模板+`sizeOpen` ref+`applySize`）、上传预览 `aspectFit`、CSS 四段（fs/preview img/upload-preview/size-row）同 Task 4。

- [ ] **Step 2: 详情页 CSS**

`lesson/detail.vue` L484 后与 `article.vue` 的 `.c-mark` 样式后各追加：

```css
.fs-sm { font-size: 13px; }
.fs-lg { font-size: 19px; }
.fs-xl { font-size: 24px; }
/* 正文图片等比缩放（渲染器内联 style 为准，此处 H5 兜底） */
```

（img 规则若该页已有 `max-width` 约束则不重复；没有则同样补 `.body img { max-width: 100%; height: auto; }`——容器 class 以各页实际为准。）

- [ ] **Step 3: 删 renderjs 文件**

两页声明都删后：删除 `apps/mobile/src/core/caret-bridge.renderjs.js`。

- [ ] **Step 4: 门禁**

Run: `cd apps/mobile; npx vue-tsc --noEmit`；`npx vitest run`；`npm run build:h5`。全绿。

- [ ] **Step 5: Commit**

```powershell
git add apps/mobile/src/pages/lesson/edit.vue apps/mobile/src/pages/lesson/detail.vue apps/mobile/src/pages/article/article.vue
git rm apps/mobile/src/core/caret-bridge.renderjs.js
git commit -m "feat(mobile): 课时编辑页同构光标/字号改造+详情页字号图片 CSS+删 renderjs 桥 (#83)"
```

---

### Task 6: web/portal CSS + 全仓门禁 + push

**Files:**
- Modify: `web/templates/base.html:31-37`（色块 CSS 区追加 fs 三档 + img 等比）
- Modify: `apps/node/src/routes/__fixtures__/portal/*.html`（6 个 fixture 与 base.html 同源，同步追加；若 fixture 由脚本从 base.html 生成则跑生成脚本，grep 定位）

- [ ] **Step 1: base.html 追加**

`.c-mark` 行后：

```html
.fs-sm { font-size: 13px; }
.fs-lg { font-size: 19px; }
.fs-xl { font-size: 24px; }
.article-body img, .body img { max-width: 100%; height: auto; }
```

（img 选择器按该模板正文容器实际 class 调整；渲染器内联 style 已覆盖主流路径，此为兜底。）

- [ ] **Step 2: fixtures 同步**

6 个 portal fixture 的同位置追加同三行 fs（img 行同 base.html 口径）。若 fixture 有生成脚本/向量校验（`go test ./apps/node/...` 或 node 测试）则跑之。

- [ ] **Step 3: 网页版前端渲染器排查**

Grep `web/` 与 `apps/node/src` 里前端 JS 渲染 markdown 的调用点（`renderMarkdown|marked|markdown-it`）。若有独立前端渲染器：按 Task 1 同决策同步 fs/img-style；若无（纯服务端渲染）：无改动，记录结论。

- [ ] **Step 4: 全仓门禁**

```powershell
cd packages/protocol-ts; npx vitest run
cd packages/core-ts; npx vitest run
cd apps/mobile; npx vue-tsc --noEmit; npx vitest run; npm run build:h5
cd e:\code\base; go test ./...
```

全部绿。

- [ ] **Step 5: Commit + push**

```powershell
git add web/templates/base.html apps/node/src/routes/__fixtures__/portal/
git commit -m "feat(web): 字号三档与图片等比缩放 CSS 全端铺开 (#83)"
git push
```

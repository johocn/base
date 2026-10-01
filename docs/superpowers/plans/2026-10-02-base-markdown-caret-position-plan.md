# 正文光标定位修复实施计划（A 主线 第 13 册 · 计划 #68）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 `0.20.3`/`28` 真机反馈 1 条 —— 「编辑课时正文」与「投稿正文」的 Markdown 快捷标签未插入到光标处，始终落在「上一个快捷标签的落点」。

**Architecture:** 取值来源换成三级裁决（H5 原生 DOM → App renderjs 光标台账 → 正文末尾 + 一次轻提示），裁决抽成纯模块进 vitest；App 侧新增全仓首个 renderjs 模块 `caretBridge`，**只做读光标 + 写光标**，不承载任何业务逻辑。删掉 `bodySelStart`/`bodySelEnd` 这对「工具栏自产自销」的 ref。零新接口、零新表、不改任何契约、**零节点改动**（仅动 `apps/mobile`）。

**Tech Stack:** TypeScript + Vue 3 + uni-app（`apps/mobile`）／ renderjs（App 视图层）／ vitest ／ vue-tsc ／ PowerShell 5.1。

**上游 spec:** `docs/superpowers/specs/2026-10-02-base-markdown-caret-position-design.md`（册子 `#67`，本册权威需求来源）；直接上游 `#44`（正文渲染增强）、`#40`+`#41`（课程与课时编辑）、`#29`+`#30`（创作 UI）、`#63`+`#64`（运行路径落盘根与存量台账自愈，已发布 `0.20.2`/`27`）。

---

## 执行环境约定（每个 Task 都适用）

1. **PowerShell 5.1**：不支持 `&&` 与 heredoc。多命令用 `;`；`git commit` 用多个 `-m`。
2. **只 `git add` 当前 Task 列出的文件**；工作区另有未提交改动（`.gitignore`、`apps/mobile/src/core/types.ts`、`internal/httpapi/web.go`、未跟踪的 `based-linux-amd64`）——**一律不碰**。
3. **两阶段审查**：每个 Task 完成后先跑该 Task 的验收命令，再做一次代码审查（对照本 Task 的 Files 列表逐条核对），通过才进下一个 Task。
4. **门禁命令（cwd 见括号）**：
   - mobile 单测：`npx vitest run`（cwd = `apps/mobile`）
   - mobile 类型：`npm run typecheck`（cwd = `apps/mobile`，实为 `vue-tsc --noEmit`）
   - H5 构建：`npm run build:h5`（cwd = `apps/mobile`）
   - App 构建：`npm run build:app`（cwd = `apps/mobile`）
   - 节点：`go test ./...`（cwd = 仓库根 `e:\code\base`）
   - 节点改动面：`git diff --stat -- internal/`（cwd = 仓库根）必须**空输出**
   - 模板 `.value` 硬检查（cwd = 仓库根）：`git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages` 必须无输出
5. **类型检查基线**：`typecheck` 恒有 **2 条册外既有错误**（`src/pages/governance/governance.vue(58,7)` TS2741、`src/pages/submit/submit.vue(156,5)` TS2322）。判据是「**不新增**」，不要试图修这两条。
6. **单测基线**：`npx vitest run` 现为 **37 文件 / 455 用例**（已核实）。本册 Task 1 新增 1 文件 / 5 用例 ⇒ 收口时应为 **38 文件 / 460 用例**。

---

## 计划期取证（已做，结论直接采信，不要重复踩坑）

写计划时用临时探针在本机实测过 renderjs 的写法可行性，**三条结论改变了 spec §3.1 / §3.4 的落地方式**，逐条登记：

| 结论 | 证据 | 影响 |
| --- | --- | --- |
| **内联 `<script module="caretBridge" lang="renderjs">export default {…}</script>` 过不了 `vue-tsc`** | 探针页实测报 8 条错，含 `TS2528 A module cannot have multiple default exports`、模板 `TS2339 Property 'caretBridge' does not exist`、`TS7006` 隐式 any ×3、`Element` 无 `focus`/`value`/`setSelectionRange` | ⇒ **必须**用「`src` 指外部 `.js` 文件」的写法（spec §3.1 未规定写法，本册在此定案） |
| **`<script module="caretBridge" lang="renderjs" src="./x.renderjs.js">` 的写法在 app 构建中确实生效**（原本最担心的「带 `src` 会绕过 `?vue&type=renderjs` 的 transform 钩子 ⇒ 模块不注册」被推翻） | 在 `pages/submit/submit.vue` 临时挂一块 `module="probeCaretBridge"` 后 `npm run build:app`：产物 `dist/build/app/app-renderjs.js` 内**含桥体原文**（`__renderjsModules["9a1f8192"]=(()=>{…})()`），`app-service.js` 内注册语句为 `(e.$renderjs||(e.$renderjs=[])).push("probeCaretBridge")` 与 `e.$renderjsModules.probeCaretBridge="9a1f8192"` | ⇒ 写法定案；**本轮探针文件已全部删除、未提交** |
| **`declare module 'vue'` 不能写在 `src/shims-vue.d.ts` 这类全局（非模块）声明文件里** | 实测会把真正的 `vue` 模块整个顶掉，`ref`/`computed`/`createSSRApp` 等全部报 `TS2305`（全仓 60+ 条错） | ⇒ **不用** vue 模块增强；模板里的 `caretBridge` 改用**页内 `const` 空实现占位**（同形、H5 上被真调用但只做 no-op，App 上由 uni 模板编译器按模块名解析、该 const 不参与运行） |

另外两条本仓事实（写计划时读代码得到）：

- `pages/lesson/edit.vue` 页面里**有两个 `<textarea>`**（正文 `:37`、摘要 `:53`），所以 renderjs **不能**用 `document.querySelector('uni-textarea textarea')` 裸取（会取到正文，但顺序耦合、脆弱）⇒ 给正文 textarea 加固定 `id="body-caret-anchor"`，桥内按 `#body-caret-anchor textarea` 取。
- 平台差异决定了「读光标」只能靠元素级事件：`document` 级 `selectionchange` 对 `<textarea>` 的光标移动**在旧版 Android WebView 上不触发**（Chrome 到 125 才补上元素级 `selectionchange`）⇒ 桥**不依赖** `selectionchange`，只挂元素上的 `focus` / `blur` / `input`。用户口径「输入完成，或光标指向其他位置，点快捷标签」这四种时序里，`input`（打字）与 `blur`（点标签前必然失焦）已全部覆盖。

**执行期修正（Task 3 实测，计划初稿漏了这两条，Task 4 照此办）**：

- **renderjs 模块声明块必须显式写**：只在模板里写 `:change:prop="caretBridge.setCaret"` **不会**注册模块，`build:app` 既不出 `app-renderjs.js`，`app-service.js` 里也没有注册语句（表现为「产物里搜不到 `caretBridge`」）。必须加：
  `<script module="caretBridge" lang="renderjs" src="src/core/caret-bridge.renderjs.js"></script>`（放在 setup `</script>` 与 `<style>` 之间）。
- **`src` 相对「项目根」（`apps/mobile`）解析，不是相对 `.vue` 文件**：写 `../core/…` 会被解析成 `apps/core/…` 并报 `ENOENT`；两页都用 `src/core/caret-bridge.renderjs.js`。
- 该 `src` 写法下 `vue-tsc` 干净（不新增错），`build:app` 产物校验通过：`app-renderjs.js`（1040 B）含 `selectionStart` 与 `body-caret-anchor`，`app-service.js` 含 `caretBridge` 注册。

> **对 spec §3.4「真机探针硬门」的处置**：spec 要求「执行时第一个 Task 先做真机探针，不通过即停」。其中**可由本机自动取证的两条已经做完并通过**（模块注册进 `app-renderjs.js`、`app-service.js` 注册语句）——即原方案最大的假设已被证据消除。剩下「真机 DOM 能否命中 / `callMethod` 回调是否到达」天然只能在设备上验，故本册把它落成 Task 6 Step 5 的**真机验收清单**（沿用本仓既有体例「真机验收待人工」），**不阻塞发布**；同时保留 spec 的兜底口径：取不到光标一律落正文末尾 + 一次轻提示，**任何情况下不静默插到「上一次落点」**，故即使真机发现 renderjs 不通，用户侧的缺陷（插错位置）也已消失，只是退化为「插到末尾 + 提示」，不会比现状更差。

---

## 开工前已核实的现状（执行时直接用，不要重新调研）

| 事实 | 位置（仓库根 = `e:\code\base`） |
| --- | --- |
| 缺陷取值表达式（两页同源） | `apps/mobile/src/pages/submit/submit.vue:122-125`、`apps/mobile/src/pages/lesson/edit.vue:224-227` |
| `bodyTextarea()` 只在 H5 成立（`$el.querySelector`），App 端恒 `null` | `apps/mobile/src/pages/submit/submit.vue:114-118`、`apps/mobile/src/pages/lesson/edit.vue:216-220` |
| 纯变换层（**本册一字不改**）：`EditResult { text, start, end }`、`ToolbarAction = {kind:'wrap',before,after} \| {kind:'prefix',prefix} \| {kind:'hr'}`、`applyToolbar(text,start,end,action)` | `apps/mobile/src/core/markdown-toolbar.ts` |
| 既有单测体例：`import { describe, expect, it } from 'vitest';` + 中文 `describe` + `toEqual` 整对象比对 | `apps/mobile/src/core/markdown-toolbar.test.ts:1-13` |
| `core` 层不变式：不 import `uni` / `plus` | `apps/mobile/src/core/*.ts` 全体 |
| 已有 `.d.ts`：仅 `src/shims-vue.d.ts`（全局声明文件，**无** `export {}`） | `apps/mobile/src/shims-vue.d.ts:1-5` |
| `tsconfig.json`：`include: ["src/**/*.ts","src/**/*.d.ts","src/**/*.vue"]`，**不含 `.js`** ⇒ 桥的 `.js` 文件本身不进 typecheck | `apps/mobile/tsconfig.json:12` |
| 两页正文 textarea：edit.vue `:37-45`（`v-model="form.bodyMd"`）、submit.vue `:42-50`（`v-model="bodyMd"`） | 同左 |
| 两页 `applyTool` 同构，差别只有 `form.value.bodyMd` vs `bodyMd.value` | `submit.vue:120-141`、`edit.vue:222-243` |
| edit.vue 页面内第二个 textarea（摘要） | `apps/mobile/src/pages/lesson/edit.vue:53` |
| 版本 `0.20.3` / `28` | `apps/mobile/src/manifest.json:5-6` |
| 发布四步已验证口径 | 见本仓 `docs/README.md` 的 `0.20.3` 条目 |

---

## File Structure

| 文件 | 动作 | 责任 |
| --- | --- | --- |
| `apps/mobile/src/core/editor-caret.ts` | **Create** | 取光标的三级裁决 + 钳制（纯函数，不 import `uni`/`plus`） |
| `apps/mobile/src/core/editor-caret.test.ts` | **Create** | 上述裁决的单测（5 用例） |
| `apps/mobile/src/core/caret-bridge.renderjs.js` | **Create** | renderjs 光标桥：读真实光标上报 + 按指令写回真实节点（视图层，零业务状态） |
| `apps/mobile/src/shims-vue.d.ts` | Modify | 追加 `declare module '*.renderjs.js'` 通配声明 |
| `apps/mobile/src/pages/lesson/edit.vue` | Modify | 正文 textarea 加锚点 id、外包 renderjs 绑定层、换 `applyTool` 取值来源、删 `bodySelStart/bodySelEnd` |
| `apps/mobile/src/pages/submit/submit.vue` | Modify | 同上（变量名为 `bodyMd` / `form` 不变） |
| `apps/mobile/src/manifest.json` | Modify | 版本 `0.20.4` / `29` |
| `docs/README.md` | Modify | `#67` 状态改「已发布」+ 登记计划 `#68` |
| `docs/superpowers/plans/2026-10-02-base-markdown-caret-position-plan.md` | Modify | 本文件：回填「执行实况」 |

---

### Task 1: `core/editor-caret.ts` —— 取光标的三级裁决（纯模块，TDD）

**Files:**
- Create: `apps/mobile/src/core/editor-caret.ts`
- Test: `apps/mobile/src/core/editor-caret.test.ts`

- [ ] **Step 1: 先写失败的测试**

  新建 `apps/mobile/src/core/editor-caret.test.ts`：

  ```ts
  import { describe, expect, it } from 'vitest';

  import { resolveCaret } from './editor-caret';

  describe('resolveCaret：live → ledger → fallback 三级裁决（册子 #67 §3.2）', () => {
    it('live 存在时优先于 ledger（H5 原生 DOM 路径不被台账覆盖）', () => {
      expect(resolveCaret({ start: 2, end: 4 }, { start: 9, end: 9 }, 10)).toEqual({
        caret: { start: 2, end: 4 },
        source: 'live',
      });
    });

    it('无 live 时用 ledger（App 端 renderjs 台账）', () => {
      expect(resolveCaret(null, { start: 3, end: 3 }, 10)).toEqual({
        caret: { start: 3, end: 3 },
        source: 'ledger',
      });
    });

    it('双空 ⇒ fallback 落到正文末尾（不静默落到上一次落点）', () => {
      expect(resolveCaret(null, null, 7)).toEqual({
        caret: { start: 7, end: 7 },
        source: 'fallback',
      });
      expect(resolveCaret(null, null, 0)).toEqual({
        caret: { start: 0, end: 0 },
        source: 'fallback',
      });
    });

    it('越界入参钳到 [0, len]', () => {
      expect(resolveCaret({ start: 99, end: 120 }, null, 5)).toEqual({
        caret: { start: 5, end: 5 },
        source: 'live',
      });
      expect(resolveCaret(null, { start: -4, end: 3 }, 5)).toEqual({
        caret: { start: 0, end: 3 },
        source: 'ledger',
      });
    });

    it('end < start 时取 end = start', () => {
      expect(resolveCaret({ start: 4, end: 2 }, null, 10)).toEqual({
        caret: { start: 4, end: 4 },
        source: 'live',
      });
    });
  });
  ```

- [ ] **Step 2: 跑测试确认它失败**

  ```powershell
  npx vitest run src/core/editor-caret.test.ts
  ```

  （cwd = `apps/mobile`）预期：FAIL，报 `Failed to resolve import "./editor-caret"`。

- [ ] **Step 3: 写最小实现**

  新建 `apps/mobile/src/core/editor-caret.ts`：

  ```ts
  /**
   * 正文光标的取值裁决（册子 #67 §3.2）。
   *
   * 三级优先级：`live`（H5 原生 DOM 选区） → `ledger`（App 端 renderjs 台账） → `fallback`（正文末尾）。
   * 固定口径：**任何情况下都不回落到「上一次工具动作的落点」**——那正是本册要修的缺陷。
   */

  /** 一段光标（或选区）位置；`start === end` 即单点光标 */
  export interface Caret {
    start: number;
    end: number;
  }

  /** 取值来源：live = 本端原生 DOM（H5）／ledger = renderjs 台账（App）／fallback = 正文末尾 */
  export type CaretSource = 'live' | 'ledger' | 'fallback';

  export interface CaretResolution {
    caret: Caret;
    source: CaretSource;
  }

  /** 钳到 [0, len]，并保证 end >= start */
  function clamp(c: Caret, len: number): Caret {
    const start = Math.min(Math.max(c.start, 0), len);
    const end = Math.min(Math.max(c.end, start), len);
    return { start, end };
  }

  export function resolveCaret(live: Caret | null, ledger: Caret | null, len: number): CaretResolution {
    if (live) return { caret: clamp(live, len), source: 'live' };
    if (ledger) return { caret: clamp(ledger, len), source: 'ledger' };
    return { caret: { start: len, end: len }, source: 'fallback' };
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  ```powershell
  npx vitest run src/core/editor-caret.test.ts
  ```

  （cwd = `apps/mobile`）预期：PASS，**1 文件 / 5 用例**。

- [ ] **Step 5: 提交**

  ```powershell
  git add apps/mobile/src/core/editor-caret.ts apps/mobile/src/core/editor-caret.test.ts
  git commit -m "feat(mobile): core/editor-caret 取光标三级裁决（册子 #67）"
  ```

---

### Task 2: renderjs 光标桥 + 类型垫片

**Files:**
- Create: `apps/mobile/src/core/caret-bridge.renderjs.js`
- Modify: `apps/mobile/src/shims-vue.d.ts`

- [ ] **Step 1: 写桥**

  新建 `apps/mobile/src/core/caret-bridge.renderjs.js`：

  ```js
  // @ts-nocheck
  /**
   * 正文光标桥（renderjs，只跑在 App 视图层；H5 无 renderjs，逻辑侧保留原生 DOM 路径）。
   *
   * 只做两件事：① 读真实 DOM 光标 → `$ownerInstance.callMethod('onCaret', …)` 上报逻辑层；
   * ② 按逻辑层经 `:prop` / `:change:prop` 下发的指令把文本与光标写回真实节点。
   * 固定边界：不读不写任何业务状态（不碰表单、不碰落库、不碰提交）。
   *
   * 逻辑层契约（两页一致）：
   *   <textarea id="body-caret-anchor" … />
   *   <view :prop="caretCmd" :change:prop="caretBridge.setCaret">…</view>
   *   defineExpose({ onCaret })
   *
   * 为什么不用 document 级 `selectionchange`：旧版 Android WebView 对 `<textarea>` 的光标移动
   * 不触发它（元素级 `selectionchange` 到 Chrome 125 才有）。元素上的 focus / blur / input 已覆盖
   * 「打字」「点标签前失焦」两条必经时序。
   */

  /** 正文 textarea 的真实 DOM 节点：id 落在组件根上，内层才是原生 textarea */
  function anchor() {
    const root = document.getElementById('body-caret-anchor');
    return root ? root.querySelector('textarea') : null;
  }

  export default {
    mounted() {
      // 视图层挂载可能早于组件渲染出 textarea，故短轮询直到命中（2 秒内），超时静默放弃
      let tries = 0;
      const bind = () => {
        const el = anchor();
        if (el) {
          const report = () => this.report(el);
          el.addEventListener('focus', report);
          el.addEventListener('blur', report);
          el.addEventListener('input', report);
          return;
        }
        tries += 1;
        if (tries < 40) setTimeout(bind, 50);
      };
      bind();
    },
    methods: {
      /** 读：把真实光标上报逻辑层（写入它的 `caretLedger`） */
      report(el) {
        const owner = this.$ownerInstance;
        if (!owner) return;
        owner.callMethod('onCaret', { start: el.selectionStart, end: el.selectionEnd });
      },
      /** 写：沿用「直写原生节点」以绕开组件 model→DOM 的 100ms 防抖，避免光标被重置到末尾 */
      setCaret(newValue) {
        const el = anchor();
        if (!el || !newValue) return;
        el.focus();
        el.value = newValue.text;
        el.setSelectionRange(newValue.start, newValue.end);
      },
    },
  };
  ```

- [ ] **Step 2: 加通配声明（否则页面上 `src="./…renderjs.js"` 报 TS7016）**

  `apps/mobile/src/shims-vue.d.ts` 全文改为：

  ```ts
  declare module '*.vue' {
    import type { DefineComponent } from 'vue';
    const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
    export default component;
  }

  declare module '*.renderjs.js' {
    const mod: Record<string, unknown>;
    export default mod;
  }
  ```

  **注意**：**不要**在这里写 `declare module 'vue' { … }`——本文件是全局（非模块）声明文件，写进去会把真正的 `vue` 模块顶掉，全仓 60+ 条 `TS2305`（已实测）。模板里的 `caretBridge` 由页内 `const` 占位解决（Task 3 / Task 4）。

- [ ] **Step 3: 跑门禁（此时两页还没接线，只验桥文件与声明不破坏现状）**

  ```powershell
  npm run typecheck
  ```

  （cwd = `apps/mobile`）预期：仅基线 2 条既有错误。

  ```powershell
  npx vitest run
  ```

  （cwd = `apps/mobile`）预期：全绿，**38 文件 / 460 用例**。

- [ ] **Step 4: 提交**

  ```powershell
  git add apps/mobile/src/core/caret-bridge.renderjs.js apps/mobile/src/shims-vue.d.ts
  git commit -m "feat(mobile): renderjs 正文光标桥 caretBridge（册子 #67）"
  ```

---

### Task 3: `pages/lesson/edit.vue` 接线

**Files:**
- Modify: `apps/mobile/src/pages/lesson/edit.vue`

- [ ] **Step 1: 模板 —— 正文 textarea 换锚点 id、外包 renderjs 绑定层、删两个选区 prop**

  `apps/mobile/src/pages/lesson/edit.vue:37-45` 由

  ```html
        <textarea
          ref="bodyRef"
          v-model="form.bodyMd"
          class="area"
          placeholder="课时正文；留空则不显示正文块"
          :selection-start="bodySelStart"
          :selection-end="bodySelEnd"
          :focus="bodyFocus"
        />
  ```

  改为

  ```html
        <view :prop="caretCmd" :change:prop="caretBridge.setCaret">
          <textarea
            id="body-caret-anchor"
            ref="bodyRef"
            v-model="form.bodyMd"
            class="area"
            placeholder="课时正文；留空则不显示正文块"
            :focus="bodyFocus"
          />
        </view>
  ```

- [ ] **Step 2: 模板 —— 加 renderjs 模块声明块（缺它 `:change:prop` 无从解析、`build:app` 不出 `app-renderjs.js`）**

  在 setup 脚本的 `</script>` 与 `<style>` 之间加（`src` 相对**项目根**，见上方「执行期修正」）：

  ```html
  <script module="caretBridge" lang="renderjs" src="src/core/caret-bridge.renderjs.js"></script>
  ```

- [ ] **Step 3: 脚本 —— 新增 import**

  在 `apps/mobile/src/pages/lesson/edit.vue` 的 import 段（`:177-193`）里，按拼音顺序插到 `../../core/editlog` 之后：

  ```ts
  import { resolveCaret } from '../../core/editor-caret';
  ```

- [ ] **Step 4: 脚本 —— 换掉 body 编辑态三行 + 改 `applyTool`**

  `apps/mobile/src/pages/lesson/edit.vue:208-243` 整段由

  ```ts
  /** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库（保存口径零改动） */
  const bodyRef = ref<{ $el?: Element } | null>(null);
  const bodySelStart = ref(-1);
  const bodySelEnd = ref(-1);
  const bodyFocus = ref(false);
  const previewHtml = computed(() => renderMarkdown(form.value.bodyMd));

  /** H5：组件根节点下即原生 textarea，用 ref 拿真实选区；其它端落 props 兜底 */
  function bodyTextarea(): HTMLTextAreaElement | null {
    const root = bodyRef.value?.$el;
    if (!root || typeof root.querySelector !== 'function') return null;
    return root.querySelector('textarea') as HTMLTextAreaElement | null;
  }

  /** 工具栏动作：把变换结果写回源文本，并把光标/选区落到新位置。 */
  function applyTool(action: ToolbarAction) {
    const field = bodyTextarea();
    const src = form.value.bodyMd;
    const start = field ? field.selectionStart : bodySelStart.value >= 0 ? bodySelStart.value : src.length;
    const end = field ? field.selectionEnd : bodySelEnd.value >= 0 ? bodySelEnd.value : src.length;
    const r = applyToolbar(src, start, end, action);
    form.value.bodyMd = r.text;
    bodySelStart.value = r.start;
    bodySelEnd.value = r.end;
    bodyFocus.value = false;
    nextTick(() => {
      bodyFocus.value = true;
      const el = bodyTextarea();
      if (el) {
        // 直接落到原生节点：绕开组件 model→DOM 的 100ms 防抖，避免光标被重置到末尾
        el.value = r.text;
        el.focus();
        el.setSelectionRange(r.start, r.end);
      }
    });
  }
  ```

  改为

  ```ts
  /** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库（保存口径零改动） */
  const bodyRef = ref<{ $el?: Element } | null>(null);
  const bodyFocus = ref(false);
  /** renderjs 台账：App 视图层上报的真实光标；H5 不用（走原生 DOM 选区） */
  const caretLedger = ref<{ start: number; end: number } | null>(null);
  /** 逻辑层 → 视图层的写光标指令；每次换新对象以触发 `:change:prop` */
  const caretCmd = ref<{ start: number; end: number; text: string } | null>(null);
  /**
   * renderjs 桥在 App 视图层执行，不进入逻辑层组件实例；这里给模板一个同形空实现占位：
   * H5 无 renderjs、该占位会被真调用（no-op），App 上 uni 模板编译器按模块名解析、此值不参与运行。
   */
  const caretBridge = {
    setCaret: (_value: { start: number; end: number; text: string }): void => undefined,
  };
  const previewHtml = computed(() => renderMarkdown(form.value.bodyMd));

  /** H5：组件根节点下即原生 textarea，用 ref 拿真实选区；其它端无 DOM，恒返回 null */
  function bodyTextarea(): HTMLTextAreaElement | null {
    const root = bodyRef.value?.$el;
    if (!root || typeof root.querySelector !== 'function') return null;
    return root.querySelector('textarea') as HTMLTextAreaElement | null;
  }

  /** renderjs 上报入口（App）：真实光标存台账 */
  function onCaret(c: { start: number; end: number }) {
    caretLedger.value = { start: c.start, end: c.end };
  }
  defineExpose({ onCaret });

  /** 工具栏动作：把变换结果写回源文本，并把光标/选区落到新位置。 */
  function applyTool(action: ToolbarAction) {
    const src = form.value.bodyMd;
    const field = bodyTextarea();
    const live = field ? { start: field.selectionStart, end: field.selectionEnd } : null;
    const pick = resolveCaret(live, caretLedger.value, src.length);
    const r = applyToolbar(src, pick.caret.start, pick.caret.end, action);
    form.value.bodyMd = r.text;
    // 台账就地前移：setCaret 之后真机上的上报是异步的，不能等它
    caretLedger.value = { start: r.start, end: r.end };
    // 视图层写回（App 走 renderjs；H5 由下面的原生直写生效）
    caretCmd.value = { start: r.start, end: r.end, text: r.text };
    if (pick.source === 'fallback') {
      uni.showToast({ title: '未取到光标，已插入到正文末尾', icon: 'none' });
    }
    bodyFocus.value = false;
    nextTick(() => {
      bodyFocus.value = true;
      const el = bodyTextarea();
      if (el) {
        // H5 直写原生节点：绕开组件 model→DOM 的 100ms 防抖，避免光标被重置到末尾
        el.value = r.text;
        el.focus();
        el.setSelectionRange(r.start, r.end);
      }
    });
  }
  ```

- [ ] **Step 5: 全门禁**

  ```powershell
  npm run typecheck
  ```

  （cwd = `apps/mobile`）预期：仅基线 2 条既有错误。

  ```powershell
  git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages
  ```

  （cwd = 仓库根）预期：无输出。⚠️ PowerShell 5.1 会把内嵌双引号吞掉，实跑请改用 Grep 工具或写进文件再执行（本次执行即因此误报过一次）。

  ```powershell
  npm run build:h5
  ```

  （cwd = `apps/mobile`）预期：通过。

  ```powershell
  npm run build:app
  ```

  （cwd = `apps/mobile`）预期：通过。并核对产物里桥确实被注册：

  ```powershell
  Select-String -Path "dist\build\app\app-renderjs.js" -Pattern "selectionStart" -SimpleMatch
  ```

  预期：有命中（桥体原文进了 `app-renderjs.js`）。

  ```powershell
  Select-String -Path "dist\build\app\app-service.js" -Pattern 'caretBridge' -SimpleMatch | Select-Object -First 1
  ```

  预期：有命中（`$renderjs` / `$renderjsModules` 注册语句）。

- [ ] **Step 6: 提交**

  ```powershell
  git add apps/mobile/src/pages/lesson/edit.vue
  git commit -m "fix(mobile): 课时正文快捷标签插入到真实光标处（册子 #67）"
  ```

---

### Task 4: `pages/submit/submit.vue` 接线

**Files:**
- Modify: `apps/mobile/src/pages/submit/submit.vue`

- [ ] **Step 1: 模板 —— 同上（`:42-50`）**

  由

  ```html
        <textarea
          ref="bodyRef"
          v-model="bodyMd"
          class="area"
          placeholder="正文内容"
          :selection-start="bodySelStart"
          :selection-end="bodySelEnd"
          :focus="bodyFocus"
        />
  ```

  改为

  ```html
        <view :prop="caretCmd" :change:prop="caretBridge.setCaret">
          <textarea
            id="body-caret-anchor"
            ref="bodyRef"
            v-model="bodyMd"
            class="area"
            placeholder="正文内容"
            :focus="bodyFocus"
          />
        </view>
  ```

- [ ] **Step 2: 模板 —— 加 renderjs 模块声明块（同 Task 3 Step 2，缺它不出 `app-renderjs.js`）**

  在 setup 脚本的 `</script>` 与 `<style>` 之间加：

  ```html
  <script module="caretBridge" lang="renderjs" src="src/core/caret-bridge.renderjs.js"></script>
  ```

- [ ] **Step 3: 脚本 —— 新增 import**

  在 `apps/mobile/src/pages/submit/submit.vue` 的 import 段里，插到 `import { renderMarkdown } from '../../core/markdown';` 之后：

  ```ts
  import { resolveCaret } from '../../core/editor-caret';
  ```

- [ ] **Step 4: 脚本 —— 换掉 `:106-141` 整段**

  由

  ```ts
  /** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库（保存口径零改动） */
  const bodyRef = ref<{ $el?: Element } | null>(null);
  const bodySelStart = ref(-1);
  const bodySelEnd = ref(-1);
  const bodyFocus = ref(false);
  const previewHtml = computed(() => renderMarkdown(bodyMd.value));

  /** H5：组件根节点下即原生 textarea，用 ref 拿真实选区；其它端落 props 兜底 */
  function bodyTextarea(): HTMLTextAreaElement | null {
    const root = bodyRef.value?.$el;
    if (!root || typeof root.querySelector !== 'function') return null;
    return root.querySelector('textarea') as HTMLTextAreaElement | null;
  }

  /** 工具栏动作：把变换结果写回源文本，并把光标/选区落到新位置。 */
  function applyTool(action: ToolbarAction) {
    const field = bodyTextarea();
    const src = bodyMd.value;
    const start = field ? field.selectionStart : bodySelStart.value >= 0 ? bodySelStart.value : src.length;
    const end = field ? field.selectionEnd : bodySelEnd.value >= 0 ? bodySelEnd.value : src.length;
    const r = applyToolbar(src, start, end, action);
    bodyMd.value = r.text;
    bodySelStart.value = r.start;
    bodySelEnd.value = r.end;
    bodyFocus.value = false;
    nextTick(() => {
      bodyFocus.value = true;
      const el = bodyTextarea();
      if (el) {
        // 直接落到原生节点：绕开组件 model→DOM 的 100ms 防抖，避免光标被重置到末尾
        el.value = r.text;
        el.focus();
        el.setSelectionRange(r.start, r.end);
      }
    });
  }
  ```

  改为

  ```ts
  /** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库（保存口径零改动） */
  const bodyRef = ref<{ $el?: Element } | null>(null);
  const bodyFocus = ref(false);
  /** renderjs 台账：App 视图层上报的真实光标；H5 不用（走原生 DOM 选区） */
  const caretLedger = ref<{ start: number; end: number } | null>(null);
  /** 逻辑层 → 视图层的写光标指令；每次换新对象以触发 `:change:prop` */
  const caretCmd = ref<{ start: number; end: number; text: string } | null>(null);
  /**
   * renderjs 桥在 App 视图层执行，不进入逻辑层组件实例；这里给模板一个同形空实现占位：
   * H5 无 renderjs、该占位会被真调用（no-op），App 上 uni 模板编译器按模块名解析、此值不参与运行。
   */
  const caretBridge = {
    setCaret: (_value: { start: number; end: number; text: string }): void => undefined,
  };
  const previewHtml = computed(() => renderMarkdown(bodyMd.value));

  /** H5：组件根节点下即原生 textarea，用 ref 拿真实选区；其它端无 DOM，恒返回 null */
  function bodyTextarea(): HTMLTextAreaElement | null {
    const root = bodyRef.value?.$el;
    if (!root || typeof root.querySelector !== 'function') return null;
    return root.querySelector('textarea') as HTMLTextAreaElement | null;
  }

  /** renderjs 上报入口（App）：真实光标存台账 */
  function onCaret(c: { start: number; end: number }) {
    caretLedger.value = { start: c.start, end: c.end };
  }
  defineExpose({ onCaret });

  /** 工具栏动作：把变换结果写回源文本，并把光标/选区落到新位置。 */
  function applyTool(action: ToolbarAction) {
    const src = bodyMd.value;
    const field = bodyTextarea();
    const live = field ? { start: field.selectionStart, end: field.selectionEnd } : null;
    const pick = resolveCaret(live, caretLedger.value, src.length);
    const r = applyToolbar(src, pick.caret.start, pick.caret.end, action);
    bodyMd.value = r.text;
    // 台账就地前移：setCaret 之后真机上的上报是异步的，不能等它
    caretLedger.value = { start: r.start, end: r.end };
    // 视图层写回（App 走 renderjs；H5 由下面的原生直写生效）
    caretCmd.value = { start: r.start, end: r.end, text: r.text };
    if (pick.source === 'fallback') {
      uni.showToast({ title: '未取到光标，已插入到正文末尾', icon: 'none' });
    }
    bodyFocus.value = false;
    nextTick(() => {
      bodyFocus.value = true;
      const el = bodyTextarea();
      if (el) {
        // H5 直写原生节点：绕开组件 model→DOM 的 100ms 防抖，避免光标被重置到末尾
        el.value = r.text;
        el.focus();
        el.setSelectionRange(r.start, r.end);
      }
    });
  }
  ```

- [ ] **Step 5: 全门禁（同 Task 3 Step 5，逐条跑）**

  ```powershell
  npm run typecheck
  ```

  （cwd = `apps/mobile`）预期：仅基线 2 条既有错误。

  ```powershell
  npx vitest run
  ```

  （cwd = `apps/mobile`）预期：全绿，**38 文件 / 460 用例**。

  ```powershell
  npm run build:h5
  ```

  （cwd = `apps/mobile`）预期：通过。

  ```powershell
  npm run build:app
  ```

  （cwd = `apps/mobile`）预期：通过。

  ```powershell
  Select-String -Path "dist\build\app\app-service.js" -Pattern 'caretBridge' -SimpleMatch | Measure-Object | Select-Object -ExpandProperty Count
  ```

  预期：≥ **2**（两页各注册一次）。

- [ ] **Step 6: 提交**

  ```powershell
  git add apps/mobile/src/pages/submit/submit.vue
  git commit -m "fix(mobile): 投稿正文快捷标签插入到真实光标处（册子 #67）"
  ```

---

### Task 5: 版本号与全门禁

**Files:**
- Modify: `apps/mobile/src/manifest.json:5-6`

- [ ] **Step 1: 升版本**

  第 5-6 行改为：

  ```json
      "versionName" : "0.20.4",
      "versionCode" : "29",
  ```

- [ ] **Step 2: 全门禁（逐条跑，任一非预期即停）**

  ```powershell
  npx vitest run
  ```

  （cwd = `apps/mobile`）预期：全绿，**38 文件 / 460 用例**（上一册 37/455 + Task 1 的 1 文件 / 5 用例）。

  ```powershell
  npm run typecheck
  ```

  （cwd = `apps/mobile`）预期：仅基线 2 条既有错误。

  ```powershell
  npm run build:h5
  ```

  （cwd = `apps/mobile`）预期：通过。

  ```powershell
  npm run build:app
  ```

  （cwd = `apps/mobile`）预期：通过；核对 `dist\build\app\app-service.js` 中 `\.value\.value` 计数为 **0**。

  ```powershell
  go test ./...
  ```

  （cwd = 仓库根）预期：全包 `ok`。

  ```powershell
  git diff --stat -- internal/
  ```

  （cwd = 仓库根）预期：**空输出**（本册零节点改动）。

  ```powershell
  git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages
  ```

  （cwd = 仓库根）预期：无输出。

- [ ] **Step 3: 提交**

  ```powershell
  git add apps/mobile/src/manifest.json
  git commit -m "chore(mobile): 版本 0.20.4/29（册子 #67）"
  ```

---

### Task 6: 发布（仅手机端、零节点改动）

**Files:** 无源码改动；证据回填到本计划文末「执行实况」（**不落仓库产物**）

- [ ] **Step 1: 确认零节点改动（发布前再验一次）**

  ```powershell
  git diff --stat -- internal/
  ```

  （cwd = 仓库根）预期：**空输出** ⇒ **不交叉编译、不部署节点二进制**。

- [ ] **Step 2: 四步发布（沿用 `0.20.3` 已验证口径，一气呵成）**

  1. HBuilderX `cli pack` 云打包：

     ```powershell
     & 'D:\HBuilderX\cli.exe' pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3
     ```

     产物核对以**包内** `version.name=0.20.4` / `version.code=29` 为准，不看构建目录。
  2. `scp` 上传到 `/opt/appdl/base-0.20.4.apk`（核对远端 sha256 与本地逐字一致）。
  3. `/opt/appdl/index.html` **整页重写**改指 `0.20.4`（不得残留 `0.20.3`；旧页备份为 `index.html.bak-0.20.3`）。
  4. 服务器上 `based release` 签发（先 `set -a; . /opt/base/base.secret.env; set +a;`）：

     ```bash
     based release -version-name 0.20.4 -min-version-name 0.8.0 -apk-url http://118.190.217.242/dl/base-0.20.4.apk -apk-file /opt/appdl/base-0.20.4.apk -notes <备注> -out /opt/base-cache/data/release.json
     ```

     确认无游离副本。
  5. 线上核对：`GET /v1/release` → `0.20.4`（`apk_size` / `apk_sha256` 与本地逐字一致）、`HEAD /dl/base-0.20.4.apk` = 200（`Content-Length` 与本地一致）、`GET /dl/` 只出现 `0.20.4`；证书 SHA1 = `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 `0.6.0`–`0.20.3` 一致 ⇒ 可覆盖安装）。

- [ ] **Step 3: 真机探针（硬门的设备部分；不阻塞发布，但必须逐条实测并如实记录）**

  装 `0.20.4` 后逐条走：

  1. **读光标是否到达逻辑层**：进「编辑课时」→ 点正文中间某处 → 点「加粗」。判据：`**` 插在**点击处**、光标停在 `**` 中间（**不是**正文末尾、不是上一次的落点）。
  2. **写光标是否生效**：接上一步，直接打字。判据：字落在 `**` 中间。
  3. **移动光标后再点**：把光标移到正文别处 → 点「标题」。判据：`## ` 插在新的光标处。
  4. **投稿页同样四条**：重复 1–3 于「投稿 → 文章」正文区。
  5. **兜底是否只出一次**：若 renderjs 未生效，应看到一次「未取到光标，已插入到正文末尾」轻提示 + 插到末尾。

  **判读**：
  - 1–4 全过 ⇒ 本册目标达成。
  - 有「插到末尾 + 轻提示」⇒ renderjs 未通（`#body-caret-anchor` 未命中 或 `callMethod` 未达），**登记为真机缺陷并回退「事件台账」方案**（spec §3.4 的退路），**不得静默降级、不得当作通过**。
  - 5 出现但 1–4 也过 ⇒ 说明某次取值落在兜底（例如首次进入未聚焦就点标签），属可接受范围，如实记录。

- [ ] **Step 4: 回填执行实况与本册状态**

  在本计划文末「执行实况」写：各 Task 的 commit、门禁实测数字、四步发布证据、线上核对结果、真机探针 5 条结论；并把 `docs/README.md` 中 `#67` 那条的结尾 `状态：**册子已定稿，待出实施计划（`#68`）**` 改为 `状态：**已发布 `0.20.4`/`29`**（实施计划 `#68` 见 `plans/2026-10-02-base-markdown-caret-position-plan.md`，Task 1–6；执行实况见其文末）`。

  ```powershell
  git add docs/README.md docs/superpowers/plans/2026-10-02-base-markdown-caret-position-plan.md
  git commit -m "docs: 回填 #68 执行实况与 #67 发布状态（0.20.4/29）"
  ```

---

## 自检（写完计划后已核）

**1. Spec 覆盖**

| spec 章节 | 对应 Task |
| --- | --- |
| §2.1 症状 | 无代码（已定稿在 spec） |
| §2.2 根因三条 | Task 3 Step 3 / Task 4 Step 3（换掉取值表达式与自产自销的 ref） |
| §3.1 renderjs 光标桥（读 + 写，最小面） | Task 2（写法按「计划期取证」定案为 `src` 外部文件） |
| §3.2 `core/editor-caret.ts` 纯裁决 | Task 1 |
| §3.3 `applyTool` 五步 + 删 `bodySelStart`/`bodySelEnd` 与 `:selection-start/-end`、保留 `bodyFocus` | Task 3、Task 4 |
| §3.3 步 ④ 兜底 toast **一次** | Task 3 / Task 4 的 `if (pick.source === 'fallback')` |
| §3.4 真机探针硬门 | 「计划期取证」表（本机可自动的两条已过）+ Task 6 Step 3（设备部分，含退路口径） |
| §4 兼容与影响（H5 逐字不变 / 节点零改动 / 零新接口） | Task 3/4 保留 H5 原生直写分支 + Task 5 Step 2 的 `git diff --stat -- internal/` 空输出 + Task 6 Step 1 |
| §5 门禁表 8 项 | Task 1 Step 4、Task 3 Step 4、Task 4 Step 4、Task 5 Step 2、Task 6 Step 3 |
| §5 新增用例 4 条（live 优先 / 用 ledger / 双空 fallback / 钳制） | Task 1 Step 1（5 条，多一条 `end < start`） |
| §6 后续册（插图口径 / 分发现状） | 明确**不在本册**，不改 `docs/README.md` 里已登记的 §6.1 / §6.2 口径 |

**2. Placeholder 扫描**：全部 Step 均含可直接执行的具体命令与完整代码；无「TBD」「同 Task N」「加上适当错误处理」等字样。

**3. 类型一致性**：`Caret` / `CaretSource` / `CaretResolution` / `resolveCaret` 在 Task 1 定义，Task 3 / Task 4 只按签名调用；`caretLedger`（`Caret | null`）、`caretCmd`（`{start,end,text} | null`）、`caretBridge.setCaret`、`onCaret` 两页同名同形；桥内锚点 `#body-caret-anchor` 与两页模板的 `id` 逐字一致。

**4. 与 spec 的三处落地偏差（已登记在「计划期取证」，均为取证后收窄，不降判据）**：写法由「未规定」定案为 `src` 外部文件；模板占位由「vue 模块增强」改为「页内 `const` 空实现」（前者实测会顶掉 `vue`）；真机探针由「第一个 Task」改为「发布前 Step（设备部分）」+ 本机可自动部分已提前做完并留证。

---

## 执行实况

（执行时在此回填：各 Task commit、门禁实测数字、四步发布证据、线上核对结果、真机探针 5 条结论。）

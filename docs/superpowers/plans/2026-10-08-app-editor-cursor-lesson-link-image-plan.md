# App 编辑器体验对齐 + 课时回写父课程 + 图片渲染修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修 App 端编辑器光标漂移（插入位置漂到上方几行、光标不落标记内）、课时保存回写父课程 children、四处图片渲染补 blob 解析、图库缩略图本地直读与上传大图预览。

**Architecture:** core 层两处收敛（`saveContainer` 回写、`searchLocalBlobs` 补 path，TDD）；mobile 两页（submit.vue / lesson/edit.vue）同构改造光标读写与图库弹层；渲染层四处补 `resolveBlobRefsInMd`。上游册子：`docs/superpowers/specs/2026-10-08-app-editor-cursor-lesson-link-image-design.md`。

**Tech Stack:** uni-app Vue3（H5 + App）、TypeScript、vitest、vue-tsc。

**执行约定：**
- 所有 git 命令在 `e:\code\base` 下执行；PowerShell 不支持 `&&`，用 `;` 链接。
- 每个 Task 结束即 commit（只 add 该 Task 文件）；最后一个 Task 完成后 push。
- commit 前跑该 Task 的测试命令，绿了才提交。

---

### Task 1: core — `saveContainer` 课时回写父课程

**Files:**
- Modify: `packages/core-ts/src/course-edit.ts`（`saveContainer` L325-343 尾部追加回写）
- Test: `packages/core-ts/src/course-edit.test.ts`（文件尾新增 describe）

- [ ] **Step 1: 写失败测试**

在 `course-edit.test.ts` 文件尾（现有最后一个 `}` 之后）追加。先在文件头 import 区确认已 import `emptyContainerForm`（现有 `lessonForm` fixture 已用到；若无则补进既有 import 块）：

```ts
describe('saveContainer 课时回写父课程（册子 #82 §4.2）', () => {
  /** seed 一门本地课程：items 行 + 空 children 的 segments（digest 行 seq=0）。 */
  function seedCourse(repo: MemoryRepo, courseId: string): void {
    repo.items.set(courseId, {
      itemId: courseId, type: 'course', title: '测试课程', digest: '', likeCount: 0, authorId: 'a'.repeat(64),
    } as never);
    repo.segments.set(courseId, [{ itemId: courseId, seq: 0, kind: 'digest', text: '' }]);
  }

  it('新课时保存 sent → 父课程 children 追加该课时并重投（两个 submit 请求）', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
    const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
    seedCourse(repo, 'course/c1');
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'x', created: true }));

    const form = { ...emptyContainerForm('lesson', 'course/c1/lesson/l1'), title: '第一讲' };
    const out = await saveContainer(o, form);
    expect(out.ledgerState).toBe('sent');

    const submits = http.posted.filter((p) => p.url.endsWith('/v1/submit'));
    expect(submits).toHaveLength(2); // 课时 + 课程回写重投
    const courseWire = JSON.parse(decodeUtf8(submits[1]!.body)) as { item_id: string; segments: Array<{ kind: string; text: string }> };
    expect(courseWire.item_id).toBe('course/c1');
    expect(courseWire.segments.some((s) => s.kind === 'lesson' && s.text === 'course/c1/lesson/l1')).toBe(true);
    expect((await repo.getSubmission('course/c1'))).not.toBeNull();
  });

  it('children 已含该课时 → 幂等跳过（仅 1 个 submit）', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
    const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
    seedCourse(repo, 'course/c1');
    // 课程 segments 预置该课时（seq=1 清单行）
    const segs = repo.segments.get('course/c1')!;
    segs.push({ itemId: 'course/c1', seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' });
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'x', created: true }));

    const form = { ...emptyContainerForm('lesson', 'course/c1/lesson/l1'), title: '第一讲' };
    await saveContainer(o, form);
    expect(http.posted.filter((p) => p.url.endsWith('/v1/submit'))).toHaveLength(1);
  });

  it('父课程不在本机 → 静默跳过，课时结果照常', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
    const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'x', created: true }));

    const form = { ...emptyContainerForm('lesson', 'course/c1/lesson/l1'), title: '第一讲' };
    const out = await saveContainer(o, form);
    expect(out.ledgerState).toBe('sent');
    expect(http.posted.filter((p) => p.url.endsWith('/v1/submit'))).toHaveLength(1);
  });

  it('课时 failed（节点 403）→ 不回写', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
    const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
    seedCourse(repo, 'course/c1');
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, { status: 403, body: utf8(JSON.stringify({ code: 'item_id_taken' })) });

    const form = { ...emptyContainerForm('lesson', 'course/c1/lesson/l1'), title: '第一讲' };
    const out = await saveContainer(o, form);
    expect(out.ledgerState).toBe('failed');
    expect(http.posted.filter((p) => p.url.endsWith('/v1/submit'))).toHaveLength(1);
  });
});
```

若 `repo.items.set` 的 `ItemRow` 形状与上面 `as never` 断言不符，以 `packages/core-ts/src/types.ts` 的 `ItemRow` 为准调整字段（至少 `itemId/type/title/authorId` 必填）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core-ts; npx vitest run src/course-edit.test.ts`
Expected: 第 1 条用例 FAIL（submits 为 1，期望 2）——回写逻辑尚不存在。

- [ ] **Step 3: 实现**

`packages/core-ts/src/course-edit.ts`，在 `saveContainer`（L325）之前插入两个函数，并把 `saveContainer` 尾部改为回写后返回：

```ts
/** 课时 id → 父课程 id：`course/<cid>/lesson/...` → `course/<cid>`；独立条目返回 null。 */
export function parentCourseIdOf(itemId: string): string | null {
  const m = /^course\/([^/]+)\/lesson\//.exec(itemId);
  return m ? `course/${m[1]}` : null;
}

/**
 * 课时保存成功（sent/pending）后回写父课程 children（册子 #82 §4.2）：
 * 幂等（已含跳过）、父课程不在本机静默跳过；课程重投走同一 saveContainer
 * （本地 upsert 立即可见 + enqueueOrSend 进台账），其 outcome 不覆盖课时结果——
 * 课程失败已落台账 failed 行，由既有重试链路兜底。
 */
async function backfillLessonIntoCourse(
  o: SubmitOptions,
  form: ContainerForm,
  outcome: SubmitOutcome,
): Promise<void> {
  if (form.type !== 'lesson') return;
  if (outcome.ledgerState !== 'sent' && outcome.ledgerState !== 'pending') return;
  const courseId = parentCourseIdOf(form.itemId);
  if (courseId === null) return;
  if ((await o.repo.getItem(courseId)) === null) return;
  const courseForm = await loadContainerForm(o.repo, courseId, 'course');
  if (courseForm.children.some((c) => c.itemId === form.itemId)) return;
  courseForm.children.push({ kind: 'lesson', itemId: form.itemId });
  await saveContainer(o, courseForm);
}
```

`saveContainer` 改为（仅最后一段变化）：

```ts
export async function saveContainer(o: SubmitOptions, form: ContainerForm): Promise<SubmitOutcome> {
  const { item, segments } = toLocalContainer(form, new Date().toISOString());
  // 先本地乐观落库（册子 #56 §2.1）：本机立刻可读、可点开、可编辑，不依赖节点重建内容包。
  await o.repo.upsertLocalContainer(item, segments);
  // 行集预检（本册 §4）：客户端能判的先判、指名到行、不发网络请求。
  const check = validateContainerSegments(form.type, segments);
  if (!check.ok) {
    await writeFailedLedger(o, form, segments, check.message);
    return { itemId: form.itemId, created: false, ledgerState: 'failed', message: check.message };
  }
  const outcome = await enqueueOrSend(o, {
    itemId: form.itemId,
    type: form.type,
    title: form.title,
    bodyMd: '',
    questionJson: '',
    segments,
  });
  await backfillLessonIntoCourse(o, form, outcome);
  return outcome;
}
```

若 `SubmitOutcome` 未在 import 区，补 `import type { SubmitOutcome } from './submit';`（文件内已 import 其它 submit 符号则并入该行）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core-ts; npx vitest run`
Expected: 全绿（新增 4 条 + 既有全部通过）。

- [ ] **Step 5: Commit**

```powershell
git add packages/core-ts/src/course-edit.ts packages/core-ts/src/course-edit.test.ts
git commit -m "feat(core-ts): 课时保存回写父课程 children（幂等/父缺失跳过/failed 不回写）(#82)"
```

---

### Task 2: core — `searchLocalBlobs` 补 `path` 字段

**Files:**
- Modify: `packages/core-ts/src/editor-links.ts`（`BlobSearchRow` L108-119、SELECT L160、map L170-177）
- Test: `packages/core-ts/src/editor-links.test.ts`（`searchLocalBlobs` describe 内追加 1 条）

- [ ] **Step 1: 写失败测试**

在 `editor-links.test.ts` 的 `searchLocalBlobs` describe 内追加：

```ts
  it('SELECT 取 b.path 并逐字透传到 BlobSearchRow.path', async () => {
    const db = new FakeDb();
    db.setResponse('FROM blob_index', [
      { blob_id: 'b1', item_id: 'x', size: 100, verified_at: '2026-10-01', original_name: 'a.png', content_type: 'image/png', path: '/data/blobs/b1' },
    ]);
    const rows = await searchLocalBlobs({ db });
    expect(db.lastSql).toContain('b.blob_id, b.owner_id, b.item_id, b.size, b.verified_at, b.original_name, b.content_type, b.path,');
    expect(rows[0]!.path).toBe('/data/blobs/b1');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core-ts; npx vitest run src/editor-links.test.ts`
Expected: FAIL——`rows[0].path` 为 `undefined`（接口无此字段）。

- [ ] **Step 3: 实现**

`editor-links.ts` 三处：

`BlobSearchRow` 接口（L108-119）加一列（放在 `contentType` 之后）：

```ts
/** 客户端 blob_index.path（本机文件路径；空串 = 无本地文件，缩略图回退节点 URL） */
path: string;
```

SELECT（L160）改为：

```ts
    `SELECT b.blob_id, b.owner_id, b.item_id, b.size, b.verified_at, b.original_name, b.content_type, b.path,
            COUNT(ref.item_id) AS refs
```

map（L170-177）加一行：

```ts
    path: String(r.path ?? ''),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/core-ts; npx vitest run`
Expected: 全绿。

- [ ] **Step 5: Commit**

```powershell
git add packages/core-ts/src/editor-links.ts packages/core-ts/src/editor-links.test.ts
git commit -m "feat(core-ts): searchLocalBlobs 补 path 字段（图库缩略图本地直读）(#82)"
```

---

### Task 3: submit.vue — 光标重构（方案 A：官方事件光标 + 属性写回）

**Files:**
- Modify: `apps/mobile/src/pages/submit/submit.vue`（模板 L116-125、script L219-301、L585 renderjs 引用）
- Modify: `apps/mobile/src/core/caret-bridge.renderjs.js`（收窄为选区上报）

**背景（执行者必读）**：App 端漂移根因 = renderjs `report` 把**单点光标**经 `callMethod` 异步上报，跨层延迟导致逻辑层读到旧 offset。修法：单点光标改由组件层同步事件 `@input/@blur` 的 `e.detail.cursor` 上报（无跨层延迟）；renderjs 只在**选区非空**（`selectionStart !== selectionEnd`）时上报（选区语义）。写光标从 renderjs `setCaret` 改为 textarea `:selection-start/:selection-end` 属性。H5 端 live DOM 读与双 setTimeout 写保留（已证有效；App 逻辑层无 `document`，`bodyTextarea()` 返回 null 自动空转）。

- [ ] **Step 1: 模板改造**

L116-125 的包裹 view + textarea 整段替换为（去掉 `:prop`/`:change:prop` 桥，textarea 直挂事件与选区属性）：

```html
      <textarea
        id="body-caret-anchor"
        ref="bodyRef"
        v-model="bodyMd"
        class="area"
        placeholder="正文内容"
        :focus="bodyFocus"
        :selection-start="selStart"
        :selection-end="selEnd"
        @input="onBodyInput"
        @blur="onBodyBlur"
      />
```

- [ ] **Step 2: script 状态与事件改造**

L243-256 一段（`bodyRef`/`bodyFocus`/`caretLedger`/`caretCmd`/`caretBridge` 声明）替换为：

```ts
/** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库（保存口径零改动） */
const bodyRef = ref<{ $el?: Element } | null>(null);
const bodyFocus = ref(false);
/** 光标台账：单点 = @input/@blur 的 detail.cursor（组件层同步事件）；选区 = renderjs 上报（仅非空选区） */
const caretLedger = ref<{ start: number; end: number } | null>(null);
/** App 端属性写光标：每次变换后设新值驱动 :selection-start/:selection-end 应用；-1 = 不干预 */
const selStart = ref(-1);
const selEnd = ref(-1);
const previewHtml = computed(() => renderMarkdown(bodyMd.value));

/** 单点光标补记（App 同步路径）：renderjs 跨层上报滞后是漂移根因，这里不经过它 */
function onBodyInput(e: { detail?: { cursor?: number } }) {
  const c = e?.detail?.cursor;
  if (typeof c === 'number' && c >= 0) caretLedger.value = { start: c, end: c };
}
function onBodyBlur(e: { detail?: { cursor?: number } }) {
  onBodyInput(e);
}
```

- [ ] **Step 3: 插入/工具函数尾段改造**

`insertMarkdownAtCursor`（L219-241）与 `applyTool`（L271-301）中，删除所有 `caretCmd.value = ...` 行；两处的尾部（`bodyFocus.value = true;` 起的双 setTimeout 段）统一替换为：

```ts
  // 写光标：App 走 selection-start/end 属性（原生组件应用）；H5 再由 DOM 兜底（下方）
  selStart.value = r.start;
  selEnd.value = r.end;
  bodyFocus.value = true;
  // H5 已证口径：v-model flush 会把光标重置到末尾，双 setTimeout 在 flush 后设回
  // （App 逻辑层无 document，bodyTextarea() 为 null，自动空转无害）
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(r.start, r.end);
  }, 60);
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(r.start, r.end);
  }, 250);
```

`onCaret`（L265-269）与 `defineExpose({ onCaret })` 保留不动（renderjs 选区上报入口）。

- [ ] **Step 4: renderjs 收窄**

`apps/mobile/src/core/caret-bridge.renderjs.js`：删除 `setCaret` method 整段（L50-57），`report` 改为只在选区非空时上报，头注释同步改写：

```js
// @ts-nocheck
/**
 * 正文光标桥（renderjs，只跑在 App 视图层；H5 无 renderjs）。
 * 职责收窄（册子 #82 §4.1）：只上报**非空选区** `{start, end}` 到逻辑层 `onCaret`；
 * 单点光标由逻辑层 textarea 的 @input/@blur `e.detail.cursor` 直接补记（组件层同步事件，
 * 不经 renderjs 跨层——跨层延迟正是旧版「插入漂到上方几行」的根因）。
 * 写光标已改走逻辑层 `:selection-start/:selection-end` 属性，本桥不再有写路径。
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
    /** 读：仅非空选区上报（选区语义）；单点交给逻辑层 @input/@blur，杜绝滞后覆盖 */
    report(el) {
      if (el.selectionStart === el.selectionEnd) return;
      const owner = this.$ownerInstance;
      if (!owner) return;
      owner.callMethod('onCaret', { start: el.selectionStart, end: el.selectionEnd });
    },
  },
};
```

L585 的 `<script module="caretBridge" ...>` 引用行保留（模块名不变，模板虽不再引用，保留无害且省一次编译面改动）。

- [ ] **Step 5: 自查与门禁**

Run: `cd apps/mobile; npx vue-tsc --noEmit`
Expected: 零错误（caretCmd/caretBridge 引用已全部清除，若报残留引用逐处删除）。

- [ ] **Step 6: Commit**

```powershell
git add apps/mobile/src/pages/submit/submit.vue apps/mobile/src/core/caret-bridge.renderjs.js
git commit -m "fix(mobile): 投稿页光标改官方事件源+属性写回，修 App 插入漂移 (#82 §4.1)"
```

---

### Task 4: lesson/edit.vue — 光标重构（与 Task 3 同构）

**Files:**
- Modify: `apps/mobile/src/pages/lesson/edit.vue`（模板 L104-113、script L307-387、L778 renderjs 引用）
- Modify: `apps/mobile/src/core/caret-bridge.renderjs.js`（Task 3 已改，此处零改动）

- [ ] **Step 1: 模板改造**

L104-113（包裹 view + textarea）替换为：

```html
      <textarea
        id="body-caret-anchor"
        ref="bodyRef"
        v-model="form.bodyMd"
        class="area"
        placeholder="正文内容"
        :focus="bodyFocus"
        :selection-start="selStart"
        :selection-end="selEnd"
        @input="onBodyInput"
        @blur="onBodyBlur"
      />
```

（以现文件实际的 v-model 表达式与 placeholder 为准，只增删属性不改其它；若现模板 v-model 为 `form.bodyMd` 则保持。）

- [ ] **Step 2: script 状态与事件改造**

L331-345（`bodyRef`/`bodyFocus`/`caretLedger`/`caretCmd`/`caretBridge`/`previewHtml` 声明段）替换为：

```ts
/** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库（保存口径零改动） */
const bodyRef = ref<{ $el?: Element } | null>(null);
const bodyFocus = ref(false);
/** 光标台账：单点 = @input/@blur 的 detail.cursor（组件层同步事件）；选区 = renderjs 上报（仅非空选区） */
const caretLedger = ref<{ start: number; end: number } | null>(null);
/** App 端属性写光标：每次变换后设新值驱动 :selection-start/:selection-end 应用；-1 = 不干预 */
const selStart = ref(-1);
const selEnd = ref(-1);
const previewHtml = computed(() => renderMarkdown(form.value.bodyMd));

/** 单点光标补记（App 同步路径）：renderjs 跨层上报滞后是漂移根因，这里不经过它 */
function onBodyInput(e: { detail?: { cursor?: number } }) {
  const c = e?.detail?.cursor;
  if (typeof c === 'number' && c >= 0) caretLedger.value = { start: c, end: c };
}
function onBodyBlur(e: { detail?: { cursor?: number } }) {
  onBodyInput(e);
}
```

- [ ] **Step 3: 插入/工具函数尾段改造**

`insertMarkdownAtCursor`（L307-329）与 `applyTool`（L359-387）：删除所有 `caretCmd.value = ...` 行；尾部双 setTimeout 段替换为与 Task 3 Step 3 **逐字相同**的尾段（`selStart/selEnd/bodyFocus/双 setTimeout`，操作 `form.value.bodyMd` 的版本仅 `r` 来源不同，尾段完全一致）。

`onCaret` 与 `defineExpose({ onCaret })` 保留不动。

- [ ] **Step 4: 自查与门禁**

Run: `cd apps/mobile; npx vue-tsc --noEmit`
Expected: 零错误。

- [ ] **Step 5: Commit**

```powershell
git add apps/mobile/src/pages/lesson/edit.vue
git commit -m "fix(mobile): 课时编辑页光标改官方事件源+属性写回，与投稿页同构 (#82 §4.1)"
```

---

### Task 5: 图片渲染四处补解析 + 预览样式对齐

**Files:**
- Modify: `apps/mobile/src/pages/lesson/detail.vue`（L221、L295 渲染两处）
- Modify: `apps/mobile/src/pages/lesson/edit.vue`（`previewHtml` computed、`.preview` 样式）
- Modify: `apps/mobile/src/pages/submit/submit.vue`（`previewHtml` computed、`.preview` 样式）

- [ ] **Step 1: lesson/detail.vue 两处**

import 区加（与 article.vue 同口径路径）：

```ts
import { resolveBlobRefsInMd } from '@base/core-ts/blob-refs';
```

L221 一带（ledger 分支）：

```ts
      bodyHtml.value = renderMarkdown(resolveBlobRefsInMd(form.bodyMd, opts.nodeBaseUrl || ''));
```

L295 一带（items 分支）：

```ts
    bodyHtml.value = renderMarkdown(resolveBlobRefsInMd(attrs.bodyMd, opts.nodeBaseUrl || ''));
```

（以两处现行的变量名为准——`form.bodyMd`/`attrs.bodyMd` 取自现有代码，只在外面包 `resolveBlobRefsInMd(x, opts.nodeBaseUrl || '')`。）

- [ ] **Step 2: 两页预览 computed**

`lesson/edit.vue`（`ctx` 为页内 bootstrap 上下文变量）：

```ts
const previewHtml = computed(() => renderMarkdown(resolveBlobRefsInMd(form.value.bodyMd, ctx?.opts.nodeBaseUrl ?? '')));
```

`submit.vue`（`editCtx` 为页内上下文变量）：

```ts
const previewHtml = computed(() => renderMarkdown(resolveBlobRefsInMd(bodyMd.value, editCtx?.opts.nodeBaseUrl ?? '')));
```

import 区各加：

```ts
import { resolveBlobRefsInMd } from '@base/core-ts/blob-refs';
```

- [ ] **Step 3: 预览样式对齐详情页**

两页 `.preview` 样式（现为 `font-size: 14px; line-height: 1.8`）统一改为与 `detail.vue` `.body`（L474）同值：

```css
.preview { display: block; padding: 8px; border: 1px solid #f0f0f0; border-radius: 6px; font-size: 15px; line-height: 1.7; color: #333333; }
```

（7 个 `.c-*` 变色类两页已存在，零改动。）

- [ ] **Step 4: 门禁**

Run: `cd apps/mobile; npx vue-tsc --noEmit`
Expected: 零错误。

- [ ] **Step 5: Commit**

```powershell
git add apps/mobile/src/pages/lesson/detail.vue apps/mobile/src/pages/lesson/edit.vue apps/mobile/src/pages/submit/submit.vue
git commit -m "fix(mobile): 课时详情/预览与投稿预览补 blob 图片解析，预览排版对齐详情页 (#82 §4.3)"
```

---

### Task 6: 图库缩略图本地直读 + 上传大图预览（两页）

**Files:**
- Modify: `apps/mobile/src/pages/submit/submit.vue`（`imageUrlOf` → `thumbSrcOf`、上传 tab 预览、样式）
- Modify: `apps/mobile/src/pages/lesson/edit.vue`（同构）

- [ ] **Step 1: submit.vue script**

`imageUrlOf`（L431-435）替换为 `thumbSrcOf`（保留 `imageUrlOf` 供回退，两函数并存）：

```ts
function imageUrlOf(blobId: string): string {
  // 渲染时用 resolveBlobUrl 把 blob:{hash} 转绝对 URL
  const base = editCtx?.opts.nodeBaseUrl ?? '';
  return resolveBlobUrl(base, `blob:${blobId}`);
}
/** 缩略图 src：本地 blob 文件直读（离线可见）；path 缺失回退节点 URL（在线可见） */
function thumbSrcOf(b: BlobSearchRow): string {
  const p = b.path;
  if (p !== '') return p.startsWith('file://') ? p : `file://${p}`;
  return imageUrlOf(b.blobId);
}
```

上传预览：状态区（`uploadAlt` 声明旁）加：

```ts
/** 上传成功的大图预览（dataURL）；「重新选图」即再点选择覆盖 */
const uploadPreview = ref('');
```

`openImageDialog` 重置行加 `uploadPreview.value = '';`；`pickAndUploadImage` 成功分支（`uploadedFileName.value = picked.name;` 之后）加：

```ts
    uploadPreview.value = `data:${mimeFromName(picked.name) || 'application/octet-stream'};base64,${bytesToBase64(picked.bytes)}`;
```

import 处理：`mimeFromName` 加入既有 `../../core/course-edit` 的 import（`decodeSafe, uploadAndStoreBlob` 同行）；`bytesToBase64` 已在 `../../platform/uni` import 中（确认存在，无则补）。

- [ ] **Step 2: submit.vue 模板**

图片对话框 upload block（L82-90）替换为：

```html
          <block v-if="imageTab === 'upload'">
            <image v-if="uploadPreview !== ''" :src="uploadPreview" mode="widthFix" class="upload-preview" />
            <view class="modal-actions">
              <text class="act" @click="pickAndUploadImage">{{ uploadBusy ? '上传中…' : (uploadedBlobId === '' ? '选择图片并上传' : '重新选图') }}</text>
              <text class="act act-primary" @click="confirmUploadImage" :class="uploadedBlobId === '' ? 'act-disabled' : ''">插入正文</text>
              <text class="act" @click="closeImageDialog">取消</text>
            </view>
            <text v-if="uploadedBlobId !== ''" class="hint">已上传：{{ uploadedFileName || uploadedBlobId }}，点「插入正文」写入光标处</text>
            <input v-model="uploadAlt" class="input" placeholder="alt 文本（可空）" />
          </block>
```

library block 的缩略图（L96）：`:src="imageUrlOf(b.blobId)"` 改 `:src="thumbSrcOf(b)"`。

样式区（`.thumb` 附近）加：

```css
.upload-preview { width: 100%; border-radius: 8px; margin-bottom: 8px; }
```

- [ ] **Step 3: lesson/edit.vue 同构改造**

与 Step 1-2 同构：`imageUrlOf` 旁加 `thumbSrcOf`（`ctx` 版本）；`uploadPreview` ref + `openImageDialog` 重置 + `pickAndUploadImage` 成功分支赋值（`bytesToBase64`/`mimeFromName` import——edit.vue 若无 `bytesToBase64` import 则从 `../../platform/uni` 补，`mimeFromName` 从 `../../core/course-edit` 补）；upload block 模板与 library 缩略图 `:src="thumbSrcOf(b)"` 同改；`.upload-preview` 样式同加。

（edit.vue 现行 upload block 若与 submit.vue 略有差异，以现文件为准做同语义替换：加预览 image、按钮文案改「选择图片并上传/重新选图」与「插入正文」。）

- [ ] **Step 4: 门禁**

Run: `cd apps/mobile; npx vue-tsc --noEmit`
Expected: 零错误。

- [ ] **Step 5: Commit**

```powershell
git add apps/mobile/src/pages/submit/submit.vue apps/mobile/src/pages/lesson/edit.vue
git commit -m "feat(mobile): 图库缩略图本地直读（离线可见）+ 上传大图预览与确认插入 (#82 §4.4)"
```

---

### Task 7: 全量门禁 + push

**Files:** 无新改动（纯验证）。

- [ ] **Step 1: core-ts 全套测试**

Run: `cd packages/core-ts; npx vitest run`
Expected: 全绿（含 Task 1/2 新增 5 条）。

- [ ] **Step 2: mobile 全套测试**

Run: `cd apps/mobile; npx vitest run`
Expected: 全绿。

- [ ] **Step 3: 类型与构建**

Run: `cd apps/mobile; npx vue-tsc --noEmit`
Expected: 零错误。

Run: `cd apps/mobile; npm run build:h5`
Expected: 构建成功。

- [ ] **Step 4: push**

```powershell
git push
```

---

## Self-Review 记录

1. **Spec 覆盖**：册子 §4.1 → Task 3/4；§4.2 → Task 1；§4.3 → Task 5；§4.4 → Task 2+6；§6 测试 1-4 → Task 1、测试 5 → Task 2；§7 真机清单不进计划（人工）。无缺口。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整代码；Task 5/6 的「以现文件为准」限定了变量名取自已取证的现行代码（detail.vue `form.bodyMd`/`attrs.bodyMd`、edit.vue `ctx`、submit.vue `editCtx`），非占位。
3. **类型一致性**：`parentCourseIdOf`/`backfillLessonIntoCourse`/`SubmitOutcome`/`ChildRow`/`BlobSearchRow.path` 各 Task 引用与定义一致；两页 `selStart/selEnd/onBodyInput/onBodyBlur/caretLedger` 命名统一。
4. **已知取舍**：renderjs 模块名 `caretBridge` 保留（模板解绑后无引用，保留省编译面改动）；App 端选区包裹依赖 renderjs 非空选区上报（册子风险 2，真机定案）。

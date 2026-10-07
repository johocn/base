# 文章/题库编辑回填（items 表）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任何已同步到本机的自有文章/题库都能从详情页进入编辑页并带回原内容（台账优先 → items 表回退），突破「仅本机台账可重投」限制。

**Architecture:** core 层新增纯读函数 `loadItemDraft(repo, itemId)`（article 取 `articles.bodyMd`、quiz 取 `quizzes.questionJson`、title 取 `items.title`）；`submit.vue` onLoad 改为两级回退；article/quiz 详情页加「编辑」按钮（`item.authorId` 比对本机身份，fail-closed）。提交链路 `enqueueOrSend`/服务端 `checkItemOwnership` 零改动。

**Tech Stack:** TypeScript（packages/core-ts，vitest）、uni-app Vue3（apps/mobile，vue-tsc + build:h5）。

**册子:** `docs/superpowers/specs/2026-10-07-app-article-quiz-edit-backfill-design.md`（已批准，提交 abcccf5）

**测试命令（Windows PowerShell，注意用 `;` 不用 `&&`）：**
- core-ts（cwd `e:\code\base\packages\core-ts`）：`npx tsc --noEmit; npx vitest run src/submit.test.ts`（单文件）/ `npx tsc --noEmit; npx vitest run`（全量）
- mobile（cwd `e:\code\base\apps\mobile`）：`npx vue-tsc --noEmit; npx vitest run; npm run build:h5`

**File Structure（改动全景）：**

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/core-ts/src/submit.ts` | 修改 | 新增 `ItemDraft` + `loadItemDraft`（唯一核心函数） |
| `packages/core-ts/src/submit.test.ts` | 修改 | 追加 5 条回填用例 |
| `apps/mobile/src/pages/submit/submit.vue` | 修改 | onLoad 两级回退（台账 → items） |
| `apps/mobile/src/pages/article/article.vue` | 修改 | 编辑按钮 + canEdit |
| `apps/mobile/src/pages/quiz/quiz.vue` | 修改 | 编辑按钮 + canEdit（补 getItem） |
| `apps/mobile/src/manifest.json` | 修改 | versionName 0.20.7 / versionCode 32 |

re-export 壳零改动（`apps/mobile/src/core/*` 均为 `export *`，`loadItemDraft`/`decodeSafe`/`peekLocalIdentity`/`deviceKek` 自动可用，已核实）。

---

### Task 1: core — `loadItemDraft`（TDD）

**Files:**
- Modify: `packages/core-ts/src/submit.ts`（在 `contentHashOf` 函数之后追加）
- Test: `packages/core-ts/src/submit.test.ts`（文件末尾追加）

- [ ] **Step 1: 扩测试文件 imports**

`submit.test.ts` 第 7 行 import 追加 `loadItemDraft`：

```ts
import { buildArticlePayload, buildContainerPayload, buildQuizPayload, buildTagPayload, contentHashOf, enqueueOrSend, flushSubmissions, loadItemDraft, newItemID, retrySubmission, submitItem, type SubmitDraft, type SubmitOptions } from './submit';
```

第 10 行 import 追加类型：

```ts
import type { ArticleRow, ItemRow, MySubmissionRow, QuizRow } from './types';
```

- [ ] **Step 2: 文件末尾追加失败测试**

```ts
/** ===== loadItemDraft：items 表回填（册子 2026-10-07 §4.1）===== */

function backfillItem(itemId: string, type: string): ItemRow {
  return {
    itemId,
    source: type,
    type,
    title: `标题-${itemId}`,
    rev: 'rev-1',
    contentHash: 'h',
    state: 'active',
    updatedAt: '2026-01-01T00:00:00Z',
    authorId: 'author-1',
    authorSig: 'sig',
  };
}

describe('loadItemDraft：items 表回填', () => {
  it('article：items+articles 有行 → 返回 title/bodyMd，questionJson 恒空', async () => {
    const repo = new MemoryRepo();
    repo.items.set('article/a1', backfillItem('article/a1', 'article'));
    const ar: ArticleRow = {
      itemId: 'article/a1', title: '标题-article/a1', digest: '', publishedAt: '',
      tagsJson: '', bodyMd: '# 正文', contentHash: 'h', rev: 'rev-1',
    };
    repo.articles.set('article/a1', ar);
    expect(await loadItemDraft(repo, 'article/a1')).toEqual({
      itemId: 'article/a1', type: 'article', title: '标题-article/a1', bodyMd: '# 正文', questionJson: '',
    });
  });

  it('quiz：items+quizzes 有行 → 返回 title/questionJson，bodyMd 恒空', async () => {
    const repo = new MemoryRepo();
    repo.items.set('quiz/q1', backfillItem('quiz/q1', 'quiz'));
    const qr: QuizRow = { itemId: 'quiz/q1', questionJson: '{"v":1}', contentHash: 'h' };
    repo.quizzes.set('quiz/q1', qr);
    expect(await loadItemDraft(repo, 'quiz/q1')).toEqual({
      itemId: 'quiz/q1', type: 'quiz', title: '标题-quiz/q1', bodyMd: '', questionJson: '{"v":1}',
    });
  });

  it('条目不存在 → null', async () => {
    const repo = new MemoryRepo();
    expect(await loadItemDraft(repo, 'article/nope')).toBeNull();
  });

  it('type=course / tag → null（册子 §3.5 排除）', async () => {
    const repo = new MemoryRepo();
    repo.items.set('course/c1', backfillItem('course/c1', 'course'));
    repo.items.set('tag/t1', backfillItem('tag/t1', 'tag'));
    expect(await loadItemDraft(repo, 'course/c1')).toBeNull();
    expect(await loadItemDraft(repo, 'tag/t1')).toBeNull();
  });

  it('有 item 无 articles 行（异常态）→ bodyMd 空串不抛错', async () => {
    const repo = new MemoryRepo();
    repo.items.set('article/a2', backfillItem('article/a2', 'article'));
    expect(await loadItemDraft(repo, 'article/a2')).toEqual({
      itemId: 'article/a2', type: 'article', title: '标题-article/a2', bodyMd: '', questionJson: '',
    });
  });
});
```

说明：`MemoryRepo.items/articles/quizzes` 是公开 `Map`（fakes.ts:46-47/179），直接 seed。

- [ ] **Step 3: 跑测试确认失败**

cwd `e:\code\base\packages\core-ts`：`npx vitest run src/submit.test.ts`
Expected: FAIL —— `loadItemDraft` 未导出（SyntaxError: The requested module does not provide an export named 'loadItemDraft'）。

- [ ] **Step 4: 最小实现**

`packages/core-ts/src/submit.ts` 在 `contentHashOf` 函数结束（约 L94）之后追加：

```ts
/** items 表回填的编辑草稿（册子 2026-10-07 §4.1）：只读产物，不签名不写库。 */
export interface ItemDraft {
  itemId: string;
  type: 'article' | 'quiz';
  title: string;
  /** quiz 恒 '' */
  bodyMd: string;
  /** article 恒 '' */
  questionJson: string;
}

/**
 * 从 items 表取已同步条目回填编辑：article 取 `articles.bodyMd`、quiz 取 `quizzes.questionJson`，
 * title 统一取 `items.title`。条目不存在或类型不支持（course/lesson/tag，册子 §3.5）返回 null。
 * 只读：不写库、不发请求、不签名。
 */
export async function loadItemDraft(repo: LocalRepo, itemId: string): Promise<ItemDraft | null> {
  const item = await repo.getItem(itemId);
  if (!item) return null;
  if (item.type !== 'article' && item.type !== 'quiz') return null;
  const bodyMd = item.type === 'article' ? ((await repo.getArticle(itemId))?.bodyMd ?? '') : '';
  const questionJson = item.type === 'quiz' ? ((await repo.getQuiz(itemId))?.questionJson ?? '') : '';
  return { itemId, type: item.type, title: item.title, bodyMd, questionJson };
}
```

依赖已就位：`LocalRepo`（L16 import）、`repo.getItem/getArticle/getQuiz` 均在接口内（repo.ts:36/69 与 getItem）。

- [ ] **Step 5: 跑测试确认通过**

cwd `e:\code\base\packages\core-ts`：`npx vitest run src/submit.test.ts`
Expected: PASS（既有用例 + 新 5 条全绿）。

- [ ] **Step 6: Commit**

```powershell
git add packages/core-ts/src/submit.ts packages/core-ts/src/submit.test.ts; git commit -m "feat(core): loadItemDraft 从 items 表回填文章/题库编辑内容"
```

---

### Task 2: submit.vue — 两级回退

**Files:**
- Modify: `apps/mobile/src/pages/submit/submit.vue:172,184,481-501`

- [ ] **Step 1: 改 imports**

L172 改为（追加 `decodeSafe`，#80 入口解码口径）：

```ts
import { decodeSafe, uploadAndStoreBlob } from '../../core/course-edit';
```

L184 改为（追加 `loadItemDraft`）：

```ts
import { enqueueOrSend, loadItemDraft, newItemID, type SubmitDraft } from '../../core/submit';
```

- [ ] **Step 2: 重写 onLoad（L481-501）**

```ts
onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.itemId ?? '');
  try {
    const ctx = await bootstrap();
    editCtx = ctx;
    if (raw === '') return;
    const wanted = decodeSafe(raw);
    // 两级回退（册子 §4.2）：本机台账（可能有 pending/failed 未送达修改）优先 → items 表已同步版本回退
    const row = await ctx.repo.getSubmission(wanted);
    if (row) {
      itemId.value = row.itemId;
      type.value = row.type === 'quiz' ? 'quiz' : 'article';
      title.value = row.title;
      bodyMd.value = row.bodyMd;
      const loaded = row.type === 'quiz' ? draftsFromQuestionJSON(row.questionJson) : [];
      drafts.value = loaded.length > 0 ? loaded : [emptyDraft()];
      return;
    }
    const item = await loadItemDraft(ctx.repo, wanted);
    if (!item) {
      error.value = '本地没有这条记录';
      return;
    }
    itemId.value = item.itemId;
    type.value = item.type;
    title.value = item.title;
    bodyMd.value = item.bodyMd;
    const loaded = item.type === 'quiz' ? draftsFromQuestionJSON(item.questionJson) : [];
    drafts.value = loaded.length > 0 ? loaded : [emptyDraft()];
  } catch (e) {
    error.value = (e as Error).message;
  }
});
```

`submit()`、失败 Toast、blob_references 刷新零改动。

- [ ] **Step 3: vue-tsc 验证**

cwd `e:\code\base\apps\mobile`：`npx vue-tsc --noEmit`
Expected: 零错误。

- [ ] **Step 4: Commit**

```powershell
git add apps/mobile/src/pages/submit/submit.vue; git commit -m "feat(mobile): submit 页台账→items 两级回退回填"
```

---

### Task 3: article.vue — 编辑按钮

**Files:**
- Modify: `apps/mobile/src/pages/article/article.vue`（模板 L29-35、脚本 imports L84-108、onLoad L165/L201-203、函数区 L386-390）

- [ ] **Step 1: 模板加按钮**

`.actions` 行（L34 `<text class="act" @click="openGovernance">治理</text>` 之后）追加：

```html
        <text v-if="canEdit" class="act" @click="openEdit">编辑</text>
```

- [ ] **Step 2: 加 imports 与状态**

import 区（L96 `setPendingTarget` 行之后）加：

```ts
import { deviceKek, peekLocalIdentity } from '../../core/identity';
```

状态区（L113 `const error = ref('');` 之后）加：

```ts
const canEdit = ref(false);
```

- [ ] **Step 3: onLoad 两分支设 canEdit**

ledger 分支（`q.from === 'ledger'`，L187 `await restoreProgress(sub.itemId);` 之后、`await nextTick();` 之前）加：

```ts
      canEdit.value = true; // 台账行即本人投稿（my_submissions 只存本人）
```

普通分支（L202 `setAuthorId(item?.authorId ?? '');` 之后）加：

```ts
    try {
      const ident = await peekLocalIdentity(opts.adapters.storage, await deviceKek(opts.adapters.storage));
      canEdit.value = ident !== null && ident.id === (item?.authorId ?? '');
    } catch {
      canEdit.value = false; // 身份读取异常 fail-closed（册子 §8.1）
    }
```

- [ ] **Step 4: 加跳转函数**

`openQuiz`/`openArticle` 函数附近加：

```ts
function openEdit() {
  uni.navigateTo({ url: `/pages/submit/submit?itemId=${encodeURIComponent(itemId.value)}` });
}
```

- [ ] **Step 5: vue-tsc 验证**

cwd `e:\code\base\apps\mobile`：`npx vue-tsc --noEmit`
Expected: 零错误。

- [ ] **Step 6: Commit**

```powershell
git add apps/mobile/src/pages/article/article.vue; git commit -m "feat(mobile): 文章详情页编辑入口（仅本人条目显示）"
```

---

### Task 4: quiz.vue — 编辑按钮

**Files:**
- Modify: `apps/mobile/src/pages/quiz/quiz.vue`（模板 L5、imports L31-34、onLoad L48-87、函数区、style）

- [ ] **Step 1: 模板加按钮**

L5 `<text class="progress">…</text>` 之后追加：

```html
      <text v-if="canEdit" class="edit-link" @click="openEdit">编辑此题库</text>
```

- [ ] **Step 2: 加 imports 与状态**

import 区加（L34 `bootstrap` 行之后）：

```ts
import { deviceKek, peekLocalIdentity } from '../../core/identity';
```

状态区（L44 `restoredPosition` 之后）加：

```ts
const canEdit = ref(false);
```

- [ ] **Step 3: onLoad 两分支设 canEdit**

L52 `const { repo } = await bootstrap();` 改为：

```ts
    const { opts, repo } = await bootstrap();
```

ledger 分支（L67 `await restoreProgress();` 之后、`return;` 之前）加：

```ts
      canEdit.value = true; // 台账行即本人投稿
```

普通分支（L76 `itemId.value = row.itemId;` 之后）加：

```ts
    const it = await repo.getItem(row.itemId);
    try {
      const ident = await peekLocalIdentity(opts.adapters.storage, await deviceKek(opts.adapters.storage));
      canEdit.value = ident !== null && ident.id === (it?.authorId ?? '');
    } catch {
      canEdit.value = false; // fail-closed（册子 §8.1）
    }
```

- [ ] **Step 4: 加跳转函数与样式**

`restart` 函数附近加：

```ts
function openEdit() {
  uni.navigateTo({ url: `/pages/submit/submit?itemId=${encodeURIComponent(itemId.value)}` });
}
```

style 尾部（`.error` 行前后）加：

```css
.edit-link { display: block; color: #2b6cb0; font-size: 14px; margin-bottom: 8px; }
```

- [ ] **Step 5: vue-tsc 验证**

cwd `e:\code\base\apps\mobile`：`npx vue-tsc --noEmit`
Expected: 零错误。

- [ ] **Step 6: Commit**

```powershell
git add apps/mobile/src/pages/quiz/quiz.vue; git commit -m "feat(mobile): 题库详情页编辑入口（仅本人条目显示）"
```

---

### Task 5: 门禁 + 发版 + push

**Files:**
- Modify: `apps/mobile/src/manifest.json`（version 字段）

- [ ] **Step 1: core-ts 全量门禁**

cwd `e:\code\base\packages\core-ts`：`npx tsc --noEmit; npx vitest run`
Expected: 双绿（既有全量 + 新 5 条）。

- [ ] **Step 2: mobile 三绿门禁**

cwd `e:\code\base\apps\mobile`：`npx vue-tsc --noEmit; npx vitest run; npm run build:h5`
Expected: 三绿。

- [ ] **Step 3: 发版号**

`apps/mobile/src/manifest.json`：`versionName` 0.20.6 → **0.20.7**，`versionCode` 31 → **32**。

- [ ] **Step 4: Commit + push**

```powershell
git add apps/mobile/src/manifest.json; git commit -m "chore(mobile): 发版 0.20.7 (32)"; git push
```

- [ ] **Step 5: 云打包 + 真机验收**

云打包按 0.20.5/0.20.6 既证口径执行（既有运维流程，不写入本计划命令）。真机验收清单 = 册子 §7 共 9 条，结果回填册子 §7 勾选。

---

## Self-Review 记录

- **Spec coverage：** 册子 §4.1→Task1；§4.2→Task2；§4.3→Task3/4；§4.4→壳零改动（已核实写入 File Structure）；§5 边界→Task2/3/4 代码内注释与行为；§6 测试→Task1 五条一一对应；§7.9 门禁→Task5。无缺口。
- **Placeholder scan：** 无 TBD/TODO；每步含完整代码与命令。
- **Type consistency：** `ItemDraft` 字段（itemId/type/title/bodyMd/questionJson）在 Task1 定义、Task2 消费一致；`loadItemDraft(repo, itemId)` 签名一致；`decodeSafe`/`peekLocalIdentity`/`deviceKek` 均为既有导出（#80 已落地 / identity.ts:69/134）。
